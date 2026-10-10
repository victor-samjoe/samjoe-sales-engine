import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { Database } from '../core/db.js';
import { writeAudit } from '../core/audit.js';
import { CONTACT_STAGES, createContact, listContacts, type ContactInput } from '../services/contact-service.js';
import { recordConsent, type ConsentInput } from '../services/consent-service.js';

const ContactBody = Type.Object({
  fullName: Type.String({ minLength: 2, maxLength: 180 }),
  phone: Type.Optional(Type.String({ minLength: 10, maxLength: 30 })),
  email: Type.Optional(Type.String({ format: 'email', maxLength: 254 })),
  origin: Type.String({ minLength: 2, maxLength: 40 }),
  stage: Type.Optional(Type.Union(CONTACT_STAGES.map((stage) => Type.Literal(stage)))),
  tags: Type.Optional(Type.Array(Type.String({ maxLength: 40 }), { maxItems: 30 })),
  notes: Type.Optional(Type.String({ maxLength: 2000 })),
});

const ConsentBody = Type.Object({
  channel: Type.String({ minLength: 2, maxLength: 30 }),
  purpose: Type.Union([Type.Literal('marketing'), Type.Literal('order_updates')]),
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
    const contact = await createContact(db, request.user.tenantId, request.body);
    await writeAudit(db, {
      tenantId: request.user.tenantId,
      actorUserId: request.user.sub,
      entityType: 'contact',
      entityId: String((contact as { id: string }).id),
      action: 'contact.created',
    });
    return reply.code(201).send(contact);
  });

  app.post<{ Params: { id: string }; Body: ConsentInput }>('/api/v1/contacts/:id/consents', {
    onRequest: [app.authenticate],
    schema: {
      params: Type.Object({ id: Type.String({ format: 'uuid' }) }),
      body: ConsentBody,
    },
  }, async (request, reply) => {
    const consent = await recordConsent(
      db,
      request.user.tenantId,
      request.params.id,
      request.user.sub,
      request.body,
    );
    if (!consent) {
      return reply.code(404).send({
        error: { code: 'CONTACT_NOT_FOUND', message: 'Contato não encontrado', request_id: request.id },
      });
    }
    await writeAudit(db, {
      tenantId: request.user.tenantId,
      actorUserId: request.user.sub,
      entityType: 'consent_event',
      entityId: String((consent as { id: string }).id),
      action: `consent.${request.body.action}`,
      metadata: { contact_id: request.params.id, purpose: request.body.purpose, channel: request.body.channel },
    });
    return reply.code(201).send(consent);
  });
}

