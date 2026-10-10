# Modelo de dados — Checkpoint 1

- `tenants`: empresa, slug, timezone e estado.
- `users`: identidade administrativa e hash de senha.
- `memberships`: associação de usuário ao tenant com papel.
- `contacts`: cadastro CRM, telefone E.164, estágio e bloqueio de contato.
- `consent_events`: concessões e revogações imutáveis por canal/finalidade.
- `products`: projeção comercial mínima por SKU; não substitui o catálogo do FoodApp.
- `audit_logs`: trilha de alterações administrativas.
- `schema_migrations`: controle das migrations SQL.

Todos os dados comerciais usam UUID e `tenant_id`. Valores monetários usam centavos inteiros. A unicidade de telefone e SKU é por tenant.

