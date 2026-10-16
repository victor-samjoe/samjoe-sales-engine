import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

type RouterResult = {
  json: {
    hasOpenOrder: boolean;
    openOrders: Array<{ ref: string; status: string; statusLabel: string }>;
    orderStatusMessage: string;
  };
};

async function runMergeNode(openOrders: Array<{ ref: string; status: string }>): Promise<RouterResult> {
  const workflow = JSON.parse(await readFile('n8n/wa-router.json', 'utf8')) as {
    nodes: Array<{ name: string; parameters?: { jsCode?: string } }>;
  };
  const code = workflow.nodes.find((node) => node.name === 'Mesclar e detectar opt-out1')?.parameters?.jsCode;
  if (!code) throw new Error('Nó de contexto do WhatsApp não encontrado');

  const execute = new Function('$input', '$', code) as (
    input: { first(): { json: unknown } },
    lookup: (name: string) => { first(): { json: unknown } },
  ) => RouterResult[];

  return execute(
    { first: () => ({ json: { data: { exists: true, openOrders } } }) },
    () => ({ first: () => ({ json: { phone: '+5511999999999', phoneRaw: '5511999999999', text: 'oi', pushName: 'Cliente' } }) }),
  )[0]!;
}

describe('WA Router - contexto de pedidos', () => {
  it('responde no singular quando existe um pedido aberto', async () => {
    const result = await runMergeNode([{ ref: 'PED-301', status: 'IN_PREPARATION' }]);

    expect(result.json.hasOpenOrder).toBe(true);
    expect(result.json.orderStatusMessage).toContain('Seu pedido *PED-301*');
    expect(result.json.orderStatusMessage).toContain('Em preparo');
  });

  it('lista todos os pedidos quando existem dois ou mais abertos', async () => {
    const result = await runMergeNode([
      { ref: 'PED-301', status: 'IN_PREPARATION' },
      { ref: 'PED-302', status: 'READY_FOR_PICKUP' },
    ]);

    expect(result.json.hasOpenOrder).toBe(true);
    expect(result.json.orderStatusMessage).toContain('2 pedidos em aberto');
    expect(result.json.orderStatusMessage).toContain('• *PED-301* — Em preparo');
    expect(result.json.orderStatusMessage).toContain('• *PED-302* — Pronto para retirada');
  });
});
