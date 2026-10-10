import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { Database } from '../core/db.js';
import { writeAudit } from '../core/audit.js';
import { createProduct, listProducts, type ProductInput } from '../services/product-service.js';

const ProductBody = Type.Object({
  sku: Type.String({ minLength: 1, maxLength: 80 }),
  name: Type.String({ minLength: 2, maxLength: 180 }),
  category: Type.String({ minLength: 2, maxLength: 60 }),
  currentPriceCents: Type.Integer({ minimum: 0 }),
  currentEstimatedUnitCostCents: Type.Optional(Type.Integer({ minimum: 0 })),
  costSource: Type.Optional(Type.String({ maxLength: 60 })),
});

export async function productRoutes(app: FastifyInstance, db: Database) {
  app.get('/api/v1/products', { onRequest: [app.authenticate] }, async (request) => {
    const result = await listProducts(db, request.user.tenantId);
    return { data: result.rows };
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
}

