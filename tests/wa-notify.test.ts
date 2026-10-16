import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Database } from '../src/core/db.js';
import { processSamJoeFoodEvent } from '../src/services/samjoe-food-service.js';
import { sendOrderStatusWhatsApp } from '../src/services/wa-notify.js';
import { createTestDatabase, seedTestTenant } from './helpers/test-db.js';

describe('Respostas em Tempo Real', () => {
  let db: Database;
  let tenantId: string;

  beforeEach(async () => {
    db = await createTestDatabase();
    ({ tenantId } = await seedTestTenant(db));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await (db as Database & { end(): Promise<void> }).end();
  });

  async function configure(settings: Record<string, unknown>) {
    await db.query(
      `UPDATE tenants SET settings_json = $1::jsonb WHERE id = $2`,
      [JSON.stringify(settings), tenantId],
    );
  }

  it('não envia quando a automação está desativada', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await configure({ wa_automation_enabled: false, wa_evolution_url: 'https://evolution.test' });

    const result = await sendOrderStatusWhatsApp(db, tenantId, '42', 'CONFIRMED', '(11) 99999-9999');

    expect(result).toEqual({ kind: 'skipped', reason: 'automation_disabled' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('normaliza status e telefone antes de enviar pela Evolution', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ key: { id: 'msg-123' } }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    await configure({
      wa_automation_enabled: true,
      wa_evolution_url: 'https://evolution.test/',
      wa_instance_name: 'minha instancia',
      wa_api_key: 'secret',
    });

    const result = await sendOrderStatusWhatsApp(db, tenantId, 'ABC-42', ' confirmed ', '(11) 99999-9999');

    expect(result).toEqual({ kind: 'sent', providerMessageId: 'msg-123' });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://evolution.test/message/sendText/minha%20instancia');
    expect(init.headers).toMatchObject({ apikey: 'secret' });
    expect(JSON.parse(String(init.body))).toMatchObject({
      number: '5511999999999',
      text: expect.stringContaining('ABC-42'),
    });
  });

  it('expõe falha HTTP da Evolution em vez de fingir sucesso', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 401 })));
    await configure({ wa_automation_enabled: true, wa_evolution_url: 'https://evolution.test' });

    const result = await sendOrderStatusWhatsApp(db, tenantId, '42', 'CONFIRMED', '+5511999999999');

    expect(result).toEqual({ kind: 'failed', reason: 'evolution_http_401' });
  });

  it('aguarda o envio ao processar uma mudança de status da loja', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ key: { id: 'status-1' } }), { status: 200 })));
    await configure({ wa_automation_enabled: true });

    const result = await processSamJoeFoodEvent(db, tenantId, {
      event_id: 'status-event-1',
      event_type: 'order.status_changed',
      occurred_at: new Date().toISOString(),
      customer: { external_id: 'customer-1', phone: '(11) 98888-7777' },
      order: { external_id: 'order-1', ref: 'PED-99', total_cents: 5000, to_status: 'in_preparation' },
    }, 'https://evolution.test', 'env-secret');

    expect(result.notification).toEqual({ kind: 'sent', providerMessageId: 'status-1' });
  });

  it('avisa o cliente quando o pedido é cancelado sem duplicar o # da referência', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ key: { id: 'cancel-1' } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await configure({ wa_automation_enabled: true });

    const result = await processSamJoeFoodEvent(db, tenantId, {
      event_id: 'cancel-status-event-1',
      event_type: 'order.status_changed',
      occurred_at: new Date().toISOString(),
      customer: { external_id: 'customer-cancel-1', phone: '(11) 98888-7777' },
      order: { external_id: 'order-cancel-1', ref: '#S002', total_cents: 1900, to_status: 'CANCELLED' },
    }, 'https://evolution.test', 'env-secret');

    expect(result.notification).toEqual({ kind: 'sent', providerMessageId: 'cancel-1' });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sent = JSON.parse(String(init.body)) as { text: string };
    expect(sent.text).toContain('pedido #S002 foi cancelado');
    expect(sent.text).not.toContain('##S002');
  });

  it('marca o pedido como aberto assim que ele é criado', async () => {
    const contactId = randomUUID();
    await db.query(
      `INSERT INTO contacts (id, tenant_id, full_name, phone_e164, origin, stage)
       VALUES ($1, $2, 'Cliente Pedido', '+5511988887777', 'samjoe_food', 'prospect')`,
      [contactId, tenantId],
    );
    await configure({ wa_automation_enabled: false });

    await processSamJoeFoodEvent(db, tenantId, {
      event_id: 'created-context-1',
      event_type: 'order.created',
      occurred_at: new Date().toISOString(),
      customer: { external_id: 'customer-context-1', phone: '(11) 98888-7777' },
      order: { external_id: 'order-context-1', ref: 'PED-101', total_cents: 5000 },
    });

    const context = await db.query<{ open_order_ref: string; open_order_status: string }>(
      `SELECT open_order_ref, open_order_status FROM contacts WHERE id = $1`,
      [contactId],
    );
    expect(context.rows[0]).toMatchObject({
      open_order_ref: 'PED-101',
      open_order_status: 'ORDER_RECEIVED',
    });
  });

  it('cria o contato e preserva o contexto quando o pedido é de um cliente novo', async () => {
    await configure({ wa_automation_enabled: false });

    const result = await processSamJoeFoodEvent(db, tenantId, {
      event_id: 'created-new-customer-1',
      event_type: 'order.created',
      occurred_at: new Date().toISOString(),
      customer: { external_id: 'customer-new-1', phone: '(11) 97777-6655', name: 'Cliente Novo' },
      order: { external_id: 'order-new-1', ref: 'PED-NEW', total_cents: 6500 },
    });

    expect(result.contact_id).toBeTruthy();
    const context = await db.query<{
      full_name: string; open_order_ref: string; open_order_status: string;
    }>(
      `SELECT full_name, open_order_ref, open_order_status
         FROM contacts WHERE tenant_id = $1 AND phone_e164 = '+5511977776655'`,
      [tenantId],
    );
    expect(context.rows[0]).toMatchObject({
      full_name: 'Cliente Novo',
      open_order_ref: 'PED-NEW',
      open_order_status: 'ORDER_RECEIVED',
    });
  });

  it('limpa somente o contexto do mesmo pedido ao cancelar', async () => {
    const contactId = randomUUID();
    await db.query(
      `INSERT INTO contacts
         (id, tenant_id, full_name, phone_e164, origin, stage, open_order_ref, open_order_status)
       VALUES ($1, $2, 'Cliente Pedido', '+5511988887777', 'samjoe_food', 'prospect', 'PED-102', 'CONFIRMED')`,
      [contactId, tenantId],
    );

    await processSamJoeFoodEvent(db, tenantId, {
      event_id: 'cancel-context-1',
      event_type: 'order.cancelled',
      occurred_at: new Date().toISOString(),
      customer: { external_id: 'customer-context-2', phone: '(11) 98888-7777' },
      order: { external_id: 'order-context-2', ref: 'PED-102', total_cents: 5000 },
    });

    const context = await db.query<{ open_order_ref: string | null; open_order_status: string | null }>(
      `SELECT open_order_ref, open_order_status FROM contacts WHERE id = $1`,
      [contactId],
    );
    expect(context.rows[0]).toMatchObject({ open_order_ref: null, open_order_status: null });
  });

  it('mantém e retorna separadamente dois pedidos em aberto do mesmo cliente', async () => {
    const contactId = randomUUID();
    await db.query(
      `INSERT INTO contacts (id, tenant_id, full_name, phone_e164, origin, stage)
       VALUES ($1, $2, 'Cliente Dois Pedidos', '+5511966665544', 'samjoe_food', 'prospect')`,
      [contactId, tenantId],
    );
    await configure({ wa_automation_enabled: false });

    for (const [externalId, ref] of [['order-multi-1', 'PED-201'], ['order-multi-2', 'PED-202']] as const) {
      await processSamJoeFoodEvent(db, tenantId, {
        event_id: `created-${externalId}`,
        event_type: 'order.created',
        occurred_at: new Date().toISOString(),
        customer: { external_id: 'customer-multi-1', phone: '(11) 96666-5544' },
        order: { external_id: externalId, ref, total_cents: 5000 },
      });
    }

    const both = await db.query<{ external_order_id: string; order_ref: string; status: string }>(
      `SELECT external_order_id, order_ref, status
         FROM se_contact_open_orders
        WHERE tenant_id = $1 AND contact_id = $2
        ORDER BY order_ref`,
      [tenantId, contactId],
    );
    expect(both.rows).toEqual([
      { external_order_id: 'order-multi-1', order_ref: 'PED-201', status: 'ORDER_RECEIVED' },
      { external_order_id: 'order-multi-2', order_ref: 'PED-202', status: 'ORDER_RECEIVED' },
    ]);

    await processSamJoeFoodEvent(db, tenantId, {
      event_id: 'completed-order-multi-1',
      event_type: 'order.status_changed',
      occurred_at: new Date().toISOString(),
      customer: { external_id: 'customer-multi-1', phone: '(11) 96666-5544' },
      order: {
        external_id: 'order-multi-1', ref: 'PED-201', total_cents: 5000,
        from_status: 'IN_PREPARATION', to_status: 'COMPLETED',
      },
    });

    const remaining = await db.query<{ external_order_id: string; order_ref: string }>(
      `SELECT external_order_id, order_ref
         FROM se_contact_open_orders
        WHERE tenant_id = $1 AND contact_id = $2`,
      [tenantId, contactId],
    );
    expect(remaining.rows).toEqual([{ external_order_id: 'order-multi-2', order_ref: 'PED-202' }]);

    const legacyContext = await db.query<{ open_order_ref: string; open_order_status: string }>(
      `SELECT open_order_ref, open_order_status FROM contacts WHERE id = $1`,
      [contactId],
    );
    expect(legacyContext.rows[0]).toMatchObject({
      open_order_ref: 'PED-202',
      open_order_status: 'ORDER_RECEIVED',
    });
  });

  it('confirma o pedido no WhatsApp quando o pagamento é aprovado', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ key: { id: 'paid-1' } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await configure({ wa_automation_enabled: true });

    const result = await processSamJoeFoodEvent(db, tenantId, {
      event_id: 'paid-event-1',
      event_type: 'order.paid',
      occurred_at: new Date().toISOString(),
      customer: { external_id: 'customer-paid-1', phone: '(11) 97777-6666' },
      order: { external_id: 'order-paid-1', ref: 'PED-100', total_cents: 5000 },
    }, 'https://evolution.test', 'env-secret');

    expect(result.notification).toEqual({ kind: 'sent', providerMessageId: 'paid-1' });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      number: '5511977776666',
      text: expect.stringContaining('confirmado'),
    });
  });
});
