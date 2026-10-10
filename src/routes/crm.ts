import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';

const publicDirectory = resolve(process.cwd(), 'public');

async function publicFile(name: string) {
  return readFile(resolve(publicDirectory, name), 'utf8');
}

export async function crmRoutes(app: FastifyInstance) {
  app.get('/', async (_request, reply) => {
    return reply.type('text/html; charset=utf-8').send(await publicFile('index.html'));
  });

  app.get('/styles.css', async (_request, reply) => {
    return reply.type('text/css; charset=utf-8').send(await publicFile('styles.css'));
  });

  app.get('/app.js', async (_request, reply) => {
    return reply.type('application/javascript; charset=utf-8').send(await publicFile('app.js'));
  });
}
