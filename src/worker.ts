import pg from 'pg';
import { buildApp } from './app.js';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from './core/config.js';

interface Env {
  HYPERDRIVE: { connectionString: string };
  JWT_SECRET: string;
  JWT_EXPIRES_IN?: string;
  LOG_LEVEL?: string;
  SAMJOE_TECH_SERVICE_KEY?: string;
  ASSETS: { fetch(req: Request): Promise<Response> };
}

interface InjectResult {
  statusCode: number;
  rawPayload: Buffer;
  headers: Record<string, string | string[] | undefined>;
}

let _app: FastifyInstance | null = null;
let _initPromise: Promise<FastifyInstance> | null = null;

async function initApp(env: Env): Promise<FastifyInstance> {
  if (_app) return _app;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    const pool = new pg.Pool({ connectionString: env.HYPERDRIVE.connectionString });
    const config: AppConfig = {
      nodeEnv: 'production',
      host: '0.0.0.0',
      port: 443,
      logLevel: env.LOG_LEVEL ?? 'warn',
      databaseUrl: env.HYPERDRIVE.connectionString,
      jwtSecret: env.JWT_SECRET,
      jwtExpiresIn: env.JWT_EXPIRES_IN ?? '8h',
      serviceKey: env.SAMJOE_TECH_SERVICE_KEY || undefined,
    };
    const app = await buildApp({ db: pool, config, logger: false, workerMode: true });
    _app = app;
    return app;
  })();

  return _initPromise;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Non-API paths → Cloudflare static assets (public/)
    if (!url.pathname.startsWith('/api/') && url.pathname !== '/health') {
      return env.ASSETS.fetch(request);
    }

    const app = await initApp(env);

    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => { headers[key] = value; });

    const injectOpts: Record<string, unknown> = {
      method: request.method,
      url: url.pathname + url.search,
      headers,
    };

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      injectOpts['body'] = await request.text();
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (app.inject(injectOpts as any) as unknown as Promise<InjectResult>);

    const responseHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(result.headers)) {
      if (Array.isArray(value)) {
        responseHeaders[key] = value.join(', ');
      } else if (value !== undefined) {
        responseHeaders[key] = String(value);
      }
    }

    return new Response(result.rawPayload, {
      status: result.statusCode,
      headers: responseHeaders,
    });
  },
};
