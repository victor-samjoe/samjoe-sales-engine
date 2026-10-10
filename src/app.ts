import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import sensible from '@fastify/sensible';
import type { Database } from './core/db.js';
import type { AppConfig } from './core/config.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { contactRoutes } from './routes/contacts.js';
import { productRoutes } from './routes/products.js';
import { crmRoutes } from './routes/crm.js';
import { campaignRoutes } from './routes/campaigns.js';
import { dispatchRoutes } from './routes/dispatch.js';
import { integrationRoutes } from './routes/integrations.js';
import { analyticsRoutes } from './routes/analytics.js';

export async function buildApp(options: {
  db: Database;
  config: AppConfig;
  logger?: boolean;
}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger === false ? false : {
      level: options.config.logLevel,
      redact: ['req.headers.authorization', 'password', '*.password', '*.phone_e164'],
    },
    requestIdHeader: 'x-request-id',
  });

  await app.register(sensible);
  await app.register(cors, { origin: false });
  await app.register(jwt, { secret: options.config.jwtSecret });

  app.decorate('authenticate', async function authenticate(request, reply) {
    try {
      await request.jwtVerify();
    } catch {
      return reply.code(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Autenticação necessária', request_id: request.id },
      });
    }
  });

  // Allow POSTs with no body (e.g. /preflight, /approve) regardless of Content-Type.
  // PowerShell and some HTTP clients send application/x-www-form-urlencoded by default.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, body ? body : null);
  });

  app.setErrorHandler((error, request, reply) => {
    const handledError = error as Error & { code?: string; validation?: unknown; statusCode?: number };
    if (handledError.code === '23505') {
      return reply.code(409).send({
        error: { code: 'CONFLICT', message: 'Registro duplicado', request_id: request.id },
      });
    }
    if (handledError.validation) {
      return reply.code(400).send({
        error: { code: 'VALIDATION_ERROR', message: handledError.message, request_id: request.id },
      });
    }
    // Pass through Fastify's own HTTP errors (content-type, media type, etc.) with their status codes.
    if (typeof handledError.statusCode === 'number' && handledError.statusCode < 500) {
      return reply.code(handledError.statusCode).send({
        error: { code: 'VALIDATION_ERROR', message: handledError.message, request_id: request.id },
      });
    }
    request.log.error({ err: error }, 'request failed');
    return reply.code(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'Erro interno', request_id: request.id },
    });
  });

  await healthRoutes(app, options.db);
  await authRoutes(app, options.db, options.config.jwtExpiresIn);
  await contactRoutes(app, options.db);
  await productRoutes(app, options.db);
  await campaignRoutes(app, options.db);
  await dispatchRoutes(app, options.db);
  await integrationRoutes(app, options.db);
  await analyticsRoutes(app, options.db);
  await crmRoutes(app);
  return app;
}
