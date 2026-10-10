# SamJoE Sales Engine

Produto independente de CRM, consentimento, campanhas, recorrência, indicações e inteligência comercial da SamJoE.

O Sales Engine será usado inicialmente pela SamJoE Confeitaria, mas terá repositório, banco, deploy e contrato comercial próprios. O FoodApp permanece responsável por catálogo, checkout, pedidos, pagamentos e entregas.

## Documentos

1. `SPEC_SAMJOE_SALES_ENGINE_v1.1.md` — fonte de verdade do produto e da arquitetura.
2. `AGENT_IMPLEMENTATION_PLAN.md` — checkpoints incrementais.
3. `START_HERE_AGENT.md` — instrução curta para iniciar o trabalho.

## Stack decidida

- Node.js LTS;
- TypeScript estrito;
- Fastify;
- PostgreSQL;
- Next.js para o painel;
- Vitest;
- Docker Compose e Cloudflare Tunnel;
- n8n apenas como adaptador de mensageria.

Python pode ser usado em serviços especializados de IA, previsão, análise ou otimização, integrados por contrato versionado. Ele não faz parte obrigatória do núcleo do CRM.

## Integração com o FoodApp

```text
FoodApp -- eventos de pedidos --> Sales Engine
Sales Engine -- consulta contratada --> FoodApp
Sales Engine -- solicitação assinada --> n8n --> WhatsApp
Sistema de custos -- snapshot por SKU --> Sales Engine
```

Nenhum produto acessa diretamente o banco do outro. Toda escrita externa deve ser autenticada, versionada e idempotente.

## Desenvolvimento local

Pré-requisitos: Node.js 22+, npm e PostgreSQL 17+ ou Docker.

```powershell
Copy-Item .env.example .env
npm install
docker compose up -d postgres
npm run migrate
npm run seed
npm run dev
```

Antes de executar `seed`, substitua a senha de bootstrap no `.env`. A API inicia em `http://localhost:4010`; `GET /health` é o único endpoint operacional público além do login.

## Verificação

```powershell
npm run typecheck
npm test
npm run build
```

O Checkpoint 1 não possui envio de WhatsApp, cobrança externa nem escrita no FoodApp. Todos os testes usam dados fictícios.
