import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';

const ALLOWED_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
};

const MAX_BYTES = 50 * 1024 * 1024; // 50 MB

export async function uploadRoutes(app: FastifyInstance) {
  const uploadsDir = path.join(process.cwd(), 'public', 'uploads');
  await mkdir(uploadsDir, { recursive: true });

  app.post('/api/v1/uploads/media', {
    onRequest: [app.authenticate],
  }, async (request, reply) => {
    const data = await request.file({ limits: { fileSize: MAX_BYTES } });
    if (!data) {
      return reply.code(400).send({ error: { code: 'NO_FILE', message: 'Nenhum arquivo enviado' } });
    }

    const mime = data.mimetype;
    const ext = ALLOWED_MIME[mime];
    if (!ext) {
      data.file.resume();
      return reply.code(415).send({
        error: { code: 'UNSUPPORTED_MEDIA', message: `Tipo não suportado: ${mime}. Use JPEG, PNG, WebP, GIF ou MP4.` },
      });
    }

    const assetType = mime.startsWith('video/') ? 'video' : 'image';
    const filename = `${randomUUID()}${ext}`;
    const dest = path.join(uploadsDir, filename);

    await pipeline(data.file, createWriteStream(dest));

    if (data.file.truncated) {
      return reply.code(413).send({ error: { code: 'FILE_TOO_LARGE', message: 'Arquivo excede 50 MB' } });
    }

    const url = `/uploads/${filename}`;
    return reply.code(201).send({ data: { url, assetType, mime } });
  });
}
