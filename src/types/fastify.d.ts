import '@fastify/jwt';
import 'fastify';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: {
      sub: string;
      tenantId: string;
      role: 'owner' | 'manager' | 'operator' | 'viewer';
      email: string;
    };
    user: {
      sub: string;
      tenantId: string;
      role: 'owner' | 'manager' | 'operator' | 'viewer';
      email: string;
    };
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: import('fastify').preHandlerHookHandler;
  }
}

