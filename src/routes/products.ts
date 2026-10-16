import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { Database } from '../core/db.js';
import { writeAudit } from '../core/audit.js';
import {
  createProduct, deleteProduct, listCategories, listProducts,
  updateProduct, type ProductInput, type ProductUpdateInput,
} from '../services/product-service.js';

const ProductBody = Type.Object({
  sku: Type.String({ minLength: 1, maxLength: 80 }),
  name: Type.String({ minLength: 2, maxLength: 180 }),
  category: Type.String({ minLength: 2, maxLength: 60 }),
  currentPriceCents: Type.Integer({ minimum: 0 }),
  currentEstimatedUnitCostCents: Type.Optional(Type.Integer({ minimum: 0 })),
  costSource: Type.Optional(Type.String({ maxLength: 60 })),
});

const ProductUpdateBody = Type.Object({
  name: Type.Optional(Type.String({ minLength: 2, maxLength: 180 })),
  category: Type.Optional(Type.String({ minLength: 2, maxLength: 60 })),
  currentPriceCents: Type.Optional(Type.Integer({ minimum: 0 })),
  currentEstimatedUnitCostCents: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
  costSource: Type.Optional(Type.String({ maxLength: 60 })),
  active: Type.Optional(Type.Boolean()),
});

export async function productRoutes(app: FastifyInstance, db: Database) {
  app.get('/api/v1/products', { onRequest: [app.authenticate] }, async (request) => {
    const result = await listProducts(db, request.user.tenantId);
    return { data: result.rows };
  });

  app.get('/api/v1/products/categories', { onRequest: [app.authenticate] }, async (request) => {
    const result = await listCategories(db, request.user.tenantId);
    return { data: result.rows.map(r => r.category) };
  });

  app.post<{ Body: ProductInput }>('/api/v1/products', {
    onRequest: [app.authenticate],
    schema: { body: ProductBody },
  }, async (request, reply) => {
    if (request.user.role === 'viewer') {
      return reply.code(403).send({
        error: { code: 'FORBIDDEN', message: 'Permissão insuficiente', request_id: request.id },
      });
    }
    const product = await createProduct(db, request.user.tenantId, request.body);
    await writeAudit(db, {
      tenantId: request.user.tenantId,
      actorUserId: request.user.sub,
      entityType: 'product',
      entityId: String((product as { id: string }).id),
      action: 'product.created',
    });
    return reply.code(201).send(product);
  });

  app.put<{ Params: { id: string }; Body: ProductUpdateInput }>('/api/v1/products/:id', {
    onRequest: [app.authenticate],
    schema: { body: ProductUpdateBody },
  }, async (request, reply) => {
    if (request.user.role === 'viewer') {
      return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Permissão insuficiente' } });
    }
    try {
      const { product, hasSales } = await updateProduct(db, request.user.tenantId, request.params.id, request.body);
      await writeAudit(db, {
        tenantId: request.user.tenantId,
        actorUserId: request.user.sub,
        entityType: 'product',
        entityId: request.params.id,
        action: 'product.updated',
        metadata: { hasSales },
      });
      return { data: product };
    } catch (err: unknown) {
      const e = err as { statusCode?: number; message: string };
      return reply.code(e.statusCode ?? 400).send({ error: { code: 'UPDATE_ERROR', message: e.message } });
    }
  });

  app.delete<{ Params: { id: string } }>('/api/v1/products/:id', {
    onRequest: [app.authenticate],
  }, async (request, reply) => {
    if (request.user.role === 'viewer') {
      return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Permissão insuficiente' } });
    }
    try {
      const result = await deleteProduct(db, request.user.tenantId, request.params.id);
      await writeAudit(db, {
        tenantId: request.user.tenantId,
        actorUserId: request.user.sub,
        entityType: 'product',
        entityId: request.params.id,
        action: result.deleted ? 'product.deleted' : 'product.deactivated',
      });
      return { data: result };
    } catch (err: unknown) {
      const e = err as { statusCode?: number; message: string };
      return reply.code(e.statusCode ?? 400).send({ error: { code: 'DELETE_ERROR', message: e.message } });
    }
  });
}
