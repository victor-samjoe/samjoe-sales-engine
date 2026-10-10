# Arquitetura inicial

## Contextos independentes

```text
FoodApp                         Sales Engine
catálogo                        CRM/consentimento
carrinho/checkout   eventos     campanhas/fila
pedidos/pagamentos ---------->  recorrência/indicação
entrega                         relatórios comerciais
    |                               |
localização                    n8n/WhatsApp
    |
sistema de custos ----------> snapshots por SKU
```

Cada produto possui repositório, banco, autenticação, deploy e ciclo de release próprios. Não há leitura direta entre bancos.

## Sales Engine

```text
Next.js Admin
    -> Fastify API `/api/v1`
        -> PostgreSQL `sales_engine`
        -> worker/agendador TypeScript
        -> adaptadores versionados
             -> FoodApp
             -> sistema de custos
             -> n8n
```

O Checkpoint 1 implementa somente API, banco e domínio fundamental. O painel, workers e adaptadores externos ficam desacoplados e não executam efeitos reais.

## Regras estruturais

- Toda consulta comercial é filtrada por `tenant_id` derivado do JWT.
- IDs recebidos nunca substituem o tenant autenticado.
- Eventos externos usam `event_id`, `payload_version` e índice único.
- Escritas críticas aceitam `Idempotency-Key` quando o endpoint for implementado.
- Consentimentos são append-only; o estado atual é derivado ou projetado.
- Auditoria registra ator, ação, entidade e metadados mínimos.
- Logs não registram tokens, senhas, telefone completo ou conteúdo integral de mensagens.
- Datas persistidas em UTC; apresentação usa o timezone do tenant.

## Deploy previsto

```text
Cloudflare DNS/WAF
    -> cloudflared
        -> proxy interno
            -> sales-web
            -> sales-api
            -> sales-worker
        -> PostgreSQL em rede privada
```

PostgreSQL, Redis e painéis internos não serão expostos diretamente. Redis será adicionado apenas quando métricas demonstrarem necessidade; a fila inicial será transacional no PostgreSQL.

## Contrato inicial com FoodApp

O endpoint reservado é `POST /api/v1/integrations/orders/events`. Durante a migração, o emissor pode ser um adaptador do Apps Script/Worker. No FoodApp definitivo, a API publica diretamente.

Eventos mínimos planejados: `order.created`, `order.confirmed`, `order.paid`, `order.cancelled`, `order.refunded` e `order.fulfilled`.

