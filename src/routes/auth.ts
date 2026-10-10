import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { Database } from '../core/db.js';
import { authenticateUser } from '../services/auth-service.js';

const LoginBody = Type.Object({
  tenant_slug: Type.String({ minLength: 2, maxLength: 80 }),
  email: Type.String({ format: 'email', maxLength: 254 }),
  password: Type.String({ minLength: 8, maxLength: 200 }),
});

type LoginBodyType = {
  tenant_slug: string;
  email: string;
  password: string;
};

export async function authRoutes(app: FastifyInstance, db: Database, expiresIn: string) {
  app.post<{ Body: LoginBodyType }>('/api/v1/auth/login', {
    schema: { body: LoginBody },
  }, async (request, reply) => {
    const user = await authenticateUser(
      db,
      request.body.tenant_slug,
      request.body.email,
      request.body.password,
    );

    if (!user) {
      return reply.code(401).send({
        error: { code: 'INVALID_CREDENTIALS', message: 'Credenciais inválidas', request_id: request.id },
      });
    }

    const token = await reply.jwtSign({
      sub: user.user_id,
      tenantId: user.tenant_id,
      role: user.role,
      email: user.email,
    }, { expiresIn });

    return {
      access_token: token,
      token_type: 'Bearer',
      expires_in: expiresIn,
      user: { id: user.user_id, email: user.email, tenant_id: user.tenant_id, role: user.role },
    };
  });

  app.get('/api/v1/me', { onRequest: [app.authenticate] }, async (request) => ({
    id: request.user.sub,
    email: request.user.email,
    tenant_id: request.user.tenantId,
    role: request.user.role,
  }));
}

