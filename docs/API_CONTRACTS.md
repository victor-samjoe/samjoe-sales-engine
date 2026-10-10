# Contratos de API — Checkpoint 1

Prefixo: `/api/v1`.

## Público

- `GET /health`: saúde do processo e conectividade com o banco.
- `POST /api/v1/auth/login`: autenticação por tenant, e-mail e senha.

## Autenticado

- `GET /api/v1/me`: identidade e escopo atual.
- `GET|POST /api/v1/contacts`: lista e cria contatos do tenant.
- `POST /api/v1/contacts/:id/consents`: registra concessão/revogação.
- `GET|POST /api/v1/products`: lista e cria projeções de produtos.

Erros usam `{ "error": { "code", "message", "request_id" } }`. A documentação OpenAPI e integrações externas serão adicionadas nos checkpoints correspondentes.

