# Operação local — Checkpoint 1

1. Copie `.env.example` para `.env` e troque todos os valores de bootstrap.
2. Inicie PostgreSQL com `docker compose up -d postgres` ou forneça `DATABASE_URL` equivalente.
3. Execute `npm run migrate`.
4. Execute `npm run seed` uma vez para criar tenant e owner.
5. Inicie com `npm run dev`.
6. Verifique `GET http://localhost:4010/health`.

Para parar o banco local sem apagar dados: `docker compose stop postgres`. Não use remoção de volume sem backup e decisão explícita.

Nenhum job de campanha ou integração externa é ativado neste checkpoint.

