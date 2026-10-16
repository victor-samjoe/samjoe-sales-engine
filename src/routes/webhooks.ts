import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../core/db.js';
import { processDispatchEvent } from '../services/dispatch-service.js';

// Maps Evolution API message status codes to CRM delivery_status values.
const EVOLUTION_STATUS_MAP: Record<string, 'delivered' | 'read' | 'failed'> = {
  DELIVERY_ACK: 'delivered',
  READ: 'read',
  PLAYED: 'read',
  ERROR: 'failed',
};

export async function webhookRoutes(app: FastifyInstance, db: Database) {
  // Evolution API sends message update events here.
  // Configure Evolution with: POST /webhook/set/{instance} → url: https://sales.samjoe.com.br/api/v1/webhooks/evolution
  app.post('/api/v1/webhooks/evolution', async (request, reply) => {
    const body = request.body as {
      event?: string;
      instance?: string;
      data?: unknown;
    };

    if (!body || body.event !== 'messages.update') {
      return reply.code(200).send({ accepted: false, reason: 'not_messages_update' });
    }

    const updates = Array.isArray(body.data) ? body.data : [body.data];
    const results = [];

    for (const update of updates) {
      const u = update as {
        key?: { remoteJid?: string; id?: string; fromMe?: boolean };
        update?: { status?: string };
      };

      const providerMessageId = u?.key?.id;
      const rawStatus = u?.update?.status;
      if (!providerMessageId || !rawStatus) continue;

      const eventType = EVOLUTION_STATUS_MAP[rawStatus];
      if (!eventType) continue;

      // Look up the campaign_recipient by provider_message_id (set by n8n Confirmar Envio node).
      const recipientResult = await db.query<{ id: string; tenant_id: string }>(
        `SELECT id, tenant_id FROM campaign_recipients
          WHERE provider_message_id = $1 LIMIT 1`,
        [providerMessageId],
      );
      const recipient = recipientResult.rows[0];
      if (!recipient) {
        results.push({ provider_message_id: providerMessageId, status: 'not_found' });
        continue;
      }

      const result = await processDispatchEvent(db, recipient.tenant_id, {
        recipientId: recipient.id,
        eventType,
        provider: 'evolution_whatsapp',
        externalEventId: `evolution_${rawStatus}_${providerMessageId}`,
        providerMessageId,
        occurredAt: new Date().toISOString(),
      });

      results.push({ provider_message_id: providerMessageId, status: result.kind });
    }

    return { accepted: true, results };
  });
}
