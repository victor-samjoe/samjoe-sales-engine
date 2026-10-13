# Tarefa 006 — Contrato, reconciliação, identidade e consentimento

Status: **pendente**  
Prioridade: **alta**  
Dependências: Tarefas 003–005 e contrato canônico do SamJoE Food

## Objetivo

Fechar as regras comerciais da integração sem transformar eventos incompletos em consentimento ou conversão incorreta.

## Escopo

- [ ] Publicar contrato JSON Schema/OpenAPI com exemplos e política de versão.
- [ ] Definir semântica de `customer`, `order`, `payment`, cancelamento e reembolso parcial.
- [ ] Separar notificações operacionais de marketing por canal e finalidade.
- [ ] Não conceder marketing implicitamente em criação de cliente ou pedido.
- [ ] Rever se `order_updates` é consentimento, preferência ou outra base operacional; registrar decisão aprovada.
- [ ] Criar fila de resolução para contatos ambíguos.
- [ ] Definir merge seguro e histórico de vínculos externos.
- [ ] Substituir prefixo curto de campanha por identificador de atribuição sem colisão e verificável.
- [ ] Suportar reversão parcial e total sem destruir o valor original do evento.
- [ ] Criar endpoint/job de reconciliação por cursor ou intervalo.
- [ ] Exibir integração ausente, atrasada ou divergente no painel.

## Critérios de aceite

- Eventos SamJoE Food v1 possuem testes de contrato nos dois projetos.
- Compra não cria consentimento promocional.
- Ambiguidade não vincula automaticamente o cliente errado.
- Reembolso preserva trilha financeira original e registra compensação.
- Reconciliação detecta evento ausente, duplicado e divergente.
- Indisponibilidade do Sales Engine nunca bloqueia o SamJoE Food.

