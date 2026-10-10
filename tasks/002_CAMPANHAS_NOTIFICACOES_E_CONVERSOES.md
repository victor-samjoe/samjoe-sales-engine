# Tarefa 002 — Campanhas, elegibilidade, notificações e conversões

Status: **em andamento**  
Prioridade: **alta**  
Dependências: Checkpoint 1 (autenticação, contatos, consentimentos e produtos)

## Objetivo

Permitir criar campanhas de WhatsApp, analisar previamente quem pode recebê-las, aprovar um público congelado e registrar todo o ciclo de envio. As conversões poderão ser importadas opcionalmente do SamJoE FoodApp por uma API desacoplada.

O envio real só poderá ser habilitado depois que elegibilidade, relatório pré-disparo, idempotência e auditoria estiverem cobertos por testes.

## Decisões fechadas

- O histórico de notificações será imutável; `contacts.last_outbound_at` e `contacts.next_eligible_at` serão apenas projeções para consulta rápida.
- Falha de envio não conta como recebimento.
- Recebimento será contabilizado por destinatário/campanha, evitando contagem dupla entre eventos `delivered` e `read`.
- O público é congelado antes da aprovação. Mudanças no conteúdo ou nas regras invalidam o relatório anterior.
- Imagens e vídeos ficam em armazenamento de objetos; o banco guarda URL e metadados.
- A integração com o FoodApp é opcional e ocorre somente por API autenticada e idempotente.
- Sem integração de vendas, o dashboard exibirá “conversões indisponíveis”, nunca uma taxa enganosa de 0%.
- A atribuição inicial será last-touch: última campanha recebida antes da compra, dentro da janela configurada.

## Critérios de elegibilidade

Um contato só pode entrar no snapshot quando:

- possui telefone E.164 válido;
- não está bloqueado e não possui `do_not_contact`;
- o evento de consentimento mais recente para `whatsapp/marketing` é `granted`;
- `next_eligible_at` está vazio ou no passado;
- não excedeu o limite de frequência definido na campanha;
- atende às regras de etapa, tag e origem;
- atende à regra de inclusão/exclusão de clientes já convertidos.

Toda exclusão precisa ter um motivo explícito no relatório.

## Relatório obrigatório antes do envio

O preflight deve retornar:

- total de contatos avaliados;
- elegíveis e excluídos por motivo;
- nunca notificados;
- notificados exatamente uma vez;
- notificados exatamente duas vezes;
- notificados três vezes ou mais;
- notificados três vezes ou mais e ainda sem conversão;
- contatos já convertidos;
- taxa histórica de entrega e conversão quando os dados existirem;
- receita, custo e margem atribuídos;
- faixas de exposição versus conversão;
- lista nominal com motivo de inclusão/exclusão.

## Fases de implementação

### Fase 1 — Fundação e preflight

- [ ] Criar migração de campanhas, ativos, snapshots, eventos e conversões.
- [ ] Criar cadastro/listagem de campanhas em rascunho.
- [ ] Criar motor de elegibilidade.
- [ ] Gerar snapshot de destinatários e relatório pré-disparo.
- [ ] Impedir preflight em campanha fora de rascunho/análise.
- [ ] Cobrir isolamento por tenant e consentimento em testes.

### Fase 2 — Interface do CRM

- [ ] Adicionar navegação “Campanhas”.
- [ ] Criar formulário com texto, link, imagem e vídeo.
- [ ] Criar construtor de público e frequência.
- [ ] Exibir relatório e lista nominal antes da confirmação.
- [ ] Invalidar visualmente relatórios antigos após edição.

### Fase 3 — Aprovação e disparo

- [ ] Registrar aprovador, data, hash do snapshot e auditoria.
- [ ] Criar fila idempotente de destinatários.
- [ ] Disponibilizar API para consumo pelo n8n.
- [ ] Receber callbacks da Evolution/n8n.
- [ ] Atualizar `last_outbound_at` e `next_eligible_at` apenas no estado aceito.
- [ ] Implementar retry sem duplicar mensagens.

### Fase 4 — FoodApp e conversões

- [ ] Publicar contrato versionado de eventos do FoodApp.
- [ ] Autenticar chamadas com chave e assinatura HMAC.
- [ ] Aceitar `customer.created`, `customer.updated`, `order.created`, `order.paid`, `order.cancelled` e `order.refunded`.
- [ ] Deduplicar por `external_event_id`.
- [ ] Vincular cliente por ID externo, telefone normalizado e, secundariamente, e-mail.
- [ ] Implementar conciliação manual para vínculos ambíguos.
- [ ] Aplicar atribuição last-touch e reversão em cancelamentos/estornos.

### Fase 5 — Segmentos e inteligência

- [ ] Salvar segmentos reutilizáveis.
- [ ] Criar campanhas específicas a partir de uma faixa do relatório.
- [ ] Exibir conversão em 24h, 2–7 dias e 8–30 dias.
- [ ] Exibir conversão após 1, 2 e 3+ exposições.
- [ ] Calcular ticket, receita e margem por campanha/destinatário.

## Endpoints planejados

- `GET /api/v1/campaigns`
- `POST /api/v1/campaigns`
- `GET /api/v1/campaigns/:id`
- `PATCH /api/v1/campaigns/:id`
- `POST /api/v1/campaigns/:id/preflight`
- `GET /api/v1/campaigns/:id/preflight`
- `POST /api/v1/campaigns/:id/approve`
- `POST /api/v1/campaigns/:id/cancel`
- `GET /api/v1/dispatch/jobs`
- `POST /api/v1/dispatch/events`
- `POST /api/v1/integrations/foodapp/events`

## Regras mínimas de segurança e operação

- Isolamento obrigatório por `tenant_id` em todas as consultas.
- Auditoria em criação, alteração, análise, aprovação, cancelamento e disparo.
- Idempotência tanto no envio quanto nos eventos do FoodApp.
- Segredos nunca ficam no HTML, logs ou banco em texto puro.
- Dados pessoais devem ser mascarados em logs e relatórios exportados.
- Campanhas aprovadas não podem ter público ou conteúdo alterado.

## Estratégia de teste inicial

1. Criar contatos com consentimento concedido, revogado e ausente.
2. Simular contatos sem telefone, bloqueados e em cooldown.
3. Simular 0, 1, 2 e 3+ recebimentos anteriores.
4. Simular conversões e ausência de integração.
5. Gerar preflight e validar totais e motivos.
6. Repetir o preflight e garantir que não haja destinatários duplicados.
7. Validar isolamento entre dois tenants.
8. Somente depois executar disparo controlado para números internos.

## Próxima ação

Implementar a Fase 1, mantendo qualquer endpoint de aprovação ou envio real desabilitado até os testes de elegibilidade e snapshot passarem.
