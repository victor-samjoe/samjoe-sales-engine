# Roteiro de execução paralela — 16/10/2026

Objetivo: avançar Sales Engine e Food App simultaneamente sem duas pessoas editarem os mesmos arquivos.

## Bloco do GPTinho — Sales Engine

Responsabilidade exclusiva: `E:\SamJoE Sales Engine`.

1. Concluir preparação das URLs de produção.
   - Remover sugestões visíveis de `localhost`.
   - Exigir URL pública da loja no assistente de conexão.
   - Usar a origem pública do Sales Engine nos webhooks.
2. Corrigir a infraestrutura de testes antes de validar campanhas.
   - Fazer o Vitest ignorar `dist/**` e arquivos JavaScript gerados.
   - Alinhar o banco em memória com `se_consent_events` e com o tipo `samjoe_food`.
   - Resolver o uso de `unnest` incompatível com `pg-mem` no ambiente de teste, sem piorar a consulta de produção.
3. Validar arquivamento e exclusão de campanhas.
   - Arquivar preservando histórico.
   - Excluir somente quando nenhum destinatário tiver sido disparado.
   - Cobrir permissão, auditoria e mensagens de erro.
4. Validar WhatsApp já implementado.
   - QR Code cria/reutiliza a instância.
   - Flag de automação configura webhook do n8n.
   - Alteração do Kanban envia atualização.
   - Um ou vários pedidos em aberto retornam contexto correto.
5. Preparar deploy somente depois da suíte limpa e de autorização explícita.

Arquivos reservados para este bloco:

- `src/**`
- `tests/**`
- `public/**`
- `migrations/**`
- `n8n/**`
- `wrangler.toml`
- `package.json`
- `tarefas.txt` do Sales Engine

## Bloco do Claudinelson — Food App

Responsabilidade exclusiva: `E:\SamJoE FoodApp`. Não alterar arquivos do Sales Engine.

### Parte A — editor visual, itens Admin 14–16 e Loja 27

1. Antes de editar, ler `tarefas.txt`, `AGENTS.md` e verificar o worktree.
2. Tratar os quatro itens como um único modelo de configuração:
   - opacidade da camada fosca, de 0% a 90%;
   - posição e tamanho do carrossel;
   - formato/proporção do carrossel;
   - escala e ponto focal individual de cada imagem.
3. Criar migration aditiva com padrões compatíveis com lojas antigas.
4. Atualizar contrato da API pública e administrativa.
5. Criar controles no Admin com prévia em tempo real.
6. Aplicar exatamente os mesmos valores na vitrine pública.
7. Testar desktop e larguras de 360, 390 e 430 px.
8. Não aplicar migration nem fazer deploy sem autorização.

Arquivos esperados:

- `apps/web/app/admin/page.tsx`
- `apps/web/app/admin/admin.module.css`
- `apps/web/app/storefront.tsx`
- `apps/web/app/storefront.module.css`
- `apps/api/src/catalog.ts`
- `apps/api/src/catalog-admin.ts`
- nova migration, sem modificar migrations já aplicadas
- testes específicos de catálogo/admin

### Parte B — cache e retomada do pedido, item Admin 17

Executar somente depois da Parte A:

1. Mapear separadamente cache de catálogo, carrinho, checkout e pagamento.
2. Preservar localmente apenas carrinho e dados não sensíveis do formulário.
3. Ao retornar à aba, buscar novamente catálogo, preços, disponibilidade e situação da loja.
4. Se existir pedido criado, consultar o pedido pelo identificador público antes de restaurar a tela.
5. Nunca reutilizar preço, estoque ou status exclusivamente do cache local.
6. Testar retorno após 1, 5 e 30 minutos, atualização da página e fechamento/reabertura.
7. Registrar no `tarefas.txt` o que foi implementado e o que depende de validação real.

## Regra de entrega entre as frentes

Cada responsável deve informar:

- arquivos alterados;
- migrations criadas;
- testes executados e resultado;
- itens do `tarefas.txt` atualizados;
- pendências antes de deploy.

Nenhuma frente deve publicar enquanto a outra estiver publicando. O deploy final deve ser sequencial e ter smoke test dos dois produtos.
