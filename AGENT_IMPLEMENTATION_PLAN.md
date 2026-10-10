# Plano de implementação — SamJoE Sales Engine

**Fonte da verdade:** `SPEC_SAMJOE_SALES_ENGINE_v1.0.md`. Este plano orienta a implementação; em conflitos, sinalizar ao responsável em vez de improvisar.

## Modo de trabalho do agente

Para cada tarefa: inventariar dependências → implementar o menor incremento útil → escrever testes → rodar testes → documentar → apresentar checkpoint. Não executar envios reais nem migrar banco de produção automaticamente. Preferir commits pequenos e reversíveis.

## Checkpoint 0 — Inventário e decisões (obrigatório)

- [ ] Listar repositórios, banco(s), serviços, variáveis e integrações existentes.
- [ ] Localizar app de pedidos, Apps Script/Sheets, sistema de custos e n8n/Evolution.
- [ ] Mapear fontes da verdade e formatos de pedido, produto, custo e cliente.
- [ ] Identificar como testar sem dados reais.
- [ ] Confirmar banco PostgreSQL próprio do Sales Engine, separado dos bancos do FoodApp, n8n e Evolution.
- [ ] Confirmar destino do backend Node.js/Fastify na VPS e publicação por Cloudflare Tunnel; Pages não substitui a API.
- [ ] Entregar `docs/INVENTARIO.md`, `docs/GAPS.md`, `docs/ARCHITECTURE.md`.

**Aceite:** nenhum serviço modificado; análise concreta e plano por arquivos.

## Checkpoint 1 — Fundação do backend

- [ ] Criar app Node.js/TypeScript/Fastify, configuração e `.env.example`.
- [ ] Banco, migrações, autenticação e escopo tenant.
- [ ] Endpoints health e OpenAPI com autenticação no restante.
- [ ] Modelos básicos `tenants`, `users`, `contacts`, `consent_events`, `products`.
- [ ] CRUD/validação, auditoria, testes e scripts de inicialização.

**Aceite:** testes de isolamento, login, telefones e consentimento passam.

## Checkpoint 2 — CRM e vendas sem WhatsApp automatizado

- [ ] Importação CSV + `dry_run`, validação/deduplicação.
- [ ] Interface/listagem de contatos e anotação de abordagem manual.
- [ ] Cadastro de produtos e custos iniciais/editáveis.
- [ ] Registro manual de pedidos, itens, pagamentos, entrega e origem.
- [ ] CSV export e dashboard básico de caixa/margem.

**Aceite:** registrar 100 prospects fictícios, 10 compras fictícias e obter relatório sem enviar mensagens.

## Checkpoint 3 — Campanhas e fila

- [ ] `campaigns`, `campaign_messages`, preview, aprovação, pausa.
- [ ] Motor de elegibilidade com consentimento, frequência, janela e segmentação.
- [ ] Agendador idempotente e dispatcher em **modo mock**.
- [ ] Trilha de status, deduplicação e tratamento de status `unknown`.
- [ ] Testes: 5 execuções = 1 mensagem por pessoa/campanha; opt-out cancela pendentes.

**Aceite:** simular campanha de 100 contatos, relatório de elegíveis e fila sem mensagens reais.

## Checkpoint 4 — n8n / WhatsApp

- [ ] Workflow `send-message` mínimo, sem regras comerciais.
- [ ] Workflow `receive-events` mínimo, autenticado.
- [ ] Adapter `MessagingProvider` e escolha controlada de provedor.
- [ ] HMAC, timestamp, replay protection e callback idempotente.
- [ ] Testar mock, webhook repetido, evento fora de ordem e falha desconhecida.
- [ ] Criar procedimento operacional para templates/opt-in/opt-out.

**Aceite:** simulação ponta a ponta; integração real só após autorização e verificação de conformidade.

## Checkpoint 5 — Indicações e recorrência

- [ ] Referral codes únicos, registro do indicado, compra qualificadora >= R$ 40.
- [ ] Proibição autoindicação, recompensa única e tratamento de cancelamentos.
- [ ] Desconto/frete corretamente excluídos da compra mínima conforme spec.
- [ ] Recompensa configurável (SKU, custo, prazo), resgate e relatório.
- [ ] Agenda de recompra por preferência e consentimento.

**Aceite:** testes válidos e inválidos de indicação, incluindo reembolso e webhooks duplicados.

## Checkpoint 6 — Integrações e produção

- [ ] Adapter para app de pedidos já existente, com fallback CSV.
- [ ] Adapter para custos e lotes existentes, com snapshots de custo.
- [ ] Relatório de caixa/reserva de lote/retirada familiar.
- [ ] Logs, backups/restauração, métricas e monitoramento de erros.
- [ ] Runbook: iniciar, pausar, testar, importar, recuperar falhas, restaurar backup.

**Aceite:** demonstração ponta a ponta com pedido pago, campanha, indicação e custo de brinde.

## Checkpoint 7 — Preparação SaaS (não fazer antes de validar o negócio)

- [ ] Rever isolamento de tenant em todas as consultas.
- [ ] Medir custos de mensagens, infra e suporte por cliente empresa.
- [ ] Desenhar onboarding, cobrança e limites de plano.
- [ ] Rever processamento multi-instância, fila e índices PostgreSQL sob carga medida.
- [ ] Definir responsabilidades LGPD entre plataforma e empresa cliente.

**Aceite:** documento de arquitetura SaaS e custos, sem necessidade de implementar billing nesta fase.

## Métricas de operação para validar o produto

- Prospects cadastrados vs pessoas que consentiram receber mensagens.
- Clientes abordados, conversão para primeira compra e recompra.
- Produtos/unidades por cliente e ticket médio.
- Receita recebida, margem de contribuição e caixa reservado.
- Taxa de falha de envio, opt-out e reclamações.
- Indicações com pedido efetivamente pago e recompensas resgatadas.

## Relatório esperado ao final de cada checkpoint

```text
Checkpoint concluído:
Arquivos alterados:
Migrações executadas:
Comandos de instalação/execução:
Testes executados e resultados:
Demonstração local:
Riscos e limitações:
Pendências e próximo checkpoint:
```
