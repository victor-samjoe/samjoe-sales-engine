# Relatório — Checkpoints 0 e 1

## Checkpoint concluído

- Checkpoint 0: inventário, lacunas, fontes de verdade e arquitetura de integração.
- Checkpoint 1: fundação da API, banco, autenticação, escopo tenant, contatos, consentimentos, produtos e auditoria.

## Arquivos e módulos

- `migrations/001_initial.sql` — schema PostgreSQL inicial.
- `src/core` — configuração, banco e auditoria.
- `src/domain` — normalização de telefone.
- `src/services` — autenticação, contatos, consentimentos e produtos.
- `src/routes` — health, login, identidade, contatos, consentimentos e produtos.
- `scripts/migrate.ts` e `scripts/seed.ts` — preparação reproduzível.
- `tests` — API, autenticação, tenant isolation, opt-out e telefone.
- `docs` — inventário, lacunas, arquitetura, modelo, contratos, operação e privacidade.

## Migrações executadas

Não executadas contra banco persistente. A migration completa foi aplicada em bancos PostgreSQL compatíveis em memória durante cada teste. O Docker Desktop não respondeu a tempo nesta sessão, então a validação contra o container Postgres 17 ficou pendente.

## Comandos de instalação e execução

```text
npm install
docker compose up -d postgres
npm run migrate
npm run seed
npm run dev
```

## Testes executados

- `npm run typecheck`: aprovado.
- `npm test`: 2 arquivos, 9 testes aprovados.
- `npm run build`: aprovado.
- `npm audit`: 0 vulnerabilidades após atualizar Vitest para 5.0.3.

## Demonstração local

O app pode ser iniciado após PostgreSQL, migration e seed. O endpoint público de verificação é `GET /health`; os demais exigem JWT obtido em `POST /api/v1/auth/login`.

## Segurança e efeitos externos

- Nenhum WhatsApp enviado.
- Nenhuma cobrança processada.
- Nenhum arquivo do FoodApp legado alterado.
- Nenhuma planilha ou dado pessoal importado.
- Nenhum segredo real incluído.

## Limitações

- Painel Next.js ainda não pertence ao Checkpoint 1 implementado.
- PostgreSQL real precisa ser validado quando o Docker estiver disponível.
- OpenAPI, refresh token e recuperação de senha ainda não foram implementados.
- Integrações FoodApp, custos e n8n permanecem somente documentadas.

## Próximo checkpoint

Checkpoint 2: importação CSV com `dry_run`, abordagem manual, pedidos manuais/integrados, dashboard básico e exportações — sempre sem disparos automatizados.

