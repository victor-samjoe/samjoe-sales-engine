import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { Database } from '../core/db.js';
import { writeAudit } from '../core/audit.js';
import {
  CONTACT_STAGES, archiveContact, createContact, createContactsBulk, deleteContact,
  listContacts, updateContact, type ContactInput, type ContactUpdateInput,
} from '../services/contact-service.js';
import { grantMissingDefaultConsents, recordConsents, type ConsentInput } from '../services/consent-service.js';

const ContactBody = Type.Object({
  fullName: Type.String({ minLength: 2, maxLength: 180 }),
  phone: Type.Optional(Type.String({ minLength: 10, maxLength: 30 })),
  email: Type.Optional(Type.String({ format: 'email', maxLength: 254 })),
  origin: Type.String({ minLength: 2, maxLength: 40 }),
  stage: Type.Optional(Type.Union(CONTACT_STAGES.map((stage) => Type.Literal(stage)))),
  tags: Type.Optional(Type.Array(Type.String({ maxLength: 40 }), { maxItems: 30 })),
  notes: Type.Optional(Type.String({ maxLength: 2000 })),
});

const PurposeEnum = Type.Union([Type.Literal('marketing'), Type.Literal('order_updates')]);

const ConsentBody = Type.Object({
  channel: Type.String({ minLength: 2, maxLength: 30 }),
  purposes: Type.Array(PurposeEnum, { minItems: 1, maxItems: 2 }),
  action: Type.Union([Type.Literal('granted'), Type.Literal('revoked')]),
  source: Type.String({ minLength: 2, maxLength: 60 }),
  evidenceRef: Type.Optional(Type.String({ maxLength: 255 })),
  policyVersion: Type.String({ minLength: 1, maxLength: 40 }),
  occurredAt: Type.String({ format: 'date-time' }),
});

export async function contactRoutes(app: FastifyInstance, db: Database) {
  app.get<{ Querystring: { limit?: string; offset?: string } }>('/api/v1/contacts', {
    onRequest: [app.authenticate],
  }, async (request) => {
    const limit = Math.min(Math.max(Number(request.query.limit ?? 50), 1), 200);
    const offset = Math.max(Number(request.query.offset ?? 0), 0);
    const result = await listContacts(db, request.user.tenantId, limit, offset);
    return { data: result.rows, pagination: { limit, offset } };
  });

  app.post<{ Body: ContactInput }>('/api/v1/contacts', {
    onRequest: [app.authenticate],
    schema: { body: ContactBody },
  }, async (request, reply) => {
    const contact = await createContact(db, request.user.tenantId, request.body, request.user.sub);
    await writeAudit(db, {
      tenantId: request.user.tenantId,
      actorUserId: request.user.sub,
      entityType: 'contact',
      entityId: String((contact as { id: string }).id),
      action: 'contact.created',
    });
    return reply.code(201).send(contact);
  });

  app.post<{ Body: { contacts: ContactInput[] } }>('/api/v1/contacts/bulk', {
    onRequest: [app.authenticate],
  }, async (request, reply) => {
    if (request.user.role === 'viewer') return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Permissão insuficiente' } });
    if (!Array.isArray(request.body?.contacts) || request.body.contacts.length < 1 || request.body.contacts.length > 500) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Envie de 1 a 500 contatos' } });
    }
    return reply.code(201).send({ data: await createContactsBulk(db, request.user.tenantId, request.body.contacts, request.user.sub) });
  });

  app.post('/api/v1/contacts/consents/bulk-defaults', {
    onRequest: [app.authenticate],
  }, async (request, reply) => {
    if (!['owner', 'manager'].includes(request.user.role)) {
      return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Apenas owner ou manager podem alterar consentimentos em lote' } });
    }
    const result = await grantMissingDefaultConsents(db, request.user.tenantId, request.user.sub);
    await writeAudit(db, {
      tenantId: request.user.tenantId,
      actorUserId: request.user.sub,
      entityType: 'consent_event',
      action: 'consent.bulk_defaults_granted',
      metadata: result,
    });
    return { data: result };
  });

  app.patch<{ Params: { id: string }; Body: ContactUpdateInput }>('/api/v1/contacts/:id', {
    onRequest: [app.authenticate],
  }, async (request, reply) => {
    if (request.user.role === 'viewer') return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Permissão insuficiente' } });
    const updated = await updateContact(db, request.user.tenantId, request.params.id, request.body);
    if (!updated) return reply.code(404).send({ error: { code: 'CONTACT_NOT_FOUND', message: 'Contato não encontrado' } });
    return updated;
  });

  app.post<{ Params: { id: string } }>('/api/v1/contacts/:id/archive', {
    onRequest: [app.authenticate],
  }, async (request, reply) => {
    if (request.user.role === 'viewer') return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Permissão insuficiente' } });
    const archived = await archiveContact(db, request.user.tenantId, request.params.id);
    if (!archived) return reply.code(404).send({ error: { code: 'CONTACT_NOT_FOUND', message: 'Contato não encontrado' } });
    return archived;
  });

  app.delete<{ Params: { id: string } }>('/api/v1/contacts/:id', {
    onRequest: [app.authenticate],
  }, async (request, reply) => {
    if (!['owner', 'manager'].includes(request.user.role)) return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Apenas owner ou manager podem excluir contatos' } });
    const deleted = await deleteContact(db, request.user.tenantId, request.params.id);
    if (!deleted) return reply.code(404).send({ error: { code: 'CONTACT_NOT_FOUND', message: 'Contato não encontrado' } });
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string }; Body: ConsentInput }>('/api/v1/contacts/:id/consents', {
    onRequest: [app.authenticate],
    schema: {
      params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
      body: ConsentBody,
    },
  }, async (request, reply) => {
    const consents = await recordConsents(
      db,
      request.user.tenantId,
      request.params.id,
      request.user.sub,
      request.body,
    );
    if (!consents) {
      return reply.code(404).send({
        error: { code: 'CONTACT_NOT_FOUND', message: 'Contato não encontrado', request_id: request.id },
      });
    }
    await writeAudit(db, {
      tenantId: request.user.tenantId,
      actorUserId: request.user.sub,
      entityType: 'consent_event',
      entityId: request.params.id,
      action: `consent.${request.body.action}`,
      metadata: { contact_id: request.params.id, purposes: request.body.purposes, channel: request.body.channel },
    });
    return reply.code(201).send({ data: consents });
  });
}

