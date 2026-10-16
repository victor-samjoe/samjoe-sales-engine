export interface WaWebhookConfigInput {
  evolutionUrl: string;
  instanceName: string;
  apiKey: string;
  webhookUrl: string;
}

export async function configureEvolutionWebhook(opts: WaWebhookConfigInput): Promise<void> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.apiKey) headers.apikey = opts.apiKey;

  const res = await fetch(`${opts.evolutionUrl}/webhook/set/${opts.instanceName}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      webhook: {
        url: opts.webhookUrl,
        enabled: true,
        webhookByEvents: false,
        webhookBase64: false,
        events: ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'CONNECTION_UPDATE', 'SEND_MESSAGE'],
      },
    }),
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { message?: string };
    throw new Error(body.message ?? `Erro ao configurar webhook (${res.status})`);
  }
}
