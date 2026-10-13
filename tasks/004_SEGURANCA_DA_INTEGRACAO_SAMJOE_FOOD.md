# Tarefa 004 — Segurança da integração com o SamJoE Food

Status: **pendente**  
Prioridade: **crítica**  
Dependências: Tarefa 003 e contrato conjunto SamJoE Food/Sales Engine

## Objetivo

Substituir o webhook experimental por um protocolo de serviço-a-serviço versionado, autenticado, rotacionável e resistente a replay.

## Problemas que precisam ser resolvidos

- timestamp validado, mas não vinculado à assinatura atual;
- HMAC cobre apenas o corpo;
- segredo armazenado em `settings_json` sem proteção adequada;
- `x-tenant-id` usa identidade interna como roteamento público;
- idempotência não é uniforme para todos os tipos de evento;
- não há versionamento formal, inbox ou política de compatibilidade.

## Escopo

- [ ] Adotar envelope versionado compartilhado com o SamJoE Food.
- [ ] Assinar versão, timestamp, método, caminho, identificador público da conexão e hash do corpo.
- [ ] Usar identificador opaco da conexão em vez de confiar em UUID interno vindo do cliente.
- [ ] Criar nonce/event ID persistido e janela de replay configurável.
- [ ] Criar `integration_inbox_events` com estado, tentativa, erro e resultado.
- [ ] Deduplicar todos os eventos antes de efeitos comerciais.
- [ ] Armazenar segredos cifrados ou por referência a secret manager.
- [ ] Suportar rotação com chave atual/anterior e prazo limitado.
- [ ] Mascarar PII e assinatura em logs.
- [ ] Aplicar limites de tamanho, rate limit e timeout.
- [ ] Criar testes com assinatura alterada, timestamp reescrito, tenant trocado, replay e evento fora de ordem.

## Critérios de aceite

- Alterar qualquer componente assinado invalida a requisição.
- Repetir o mesmo evento produz exatamente um efeito.
- Segredo não aparece em resposta, log ou texto puro no banco.
- Rotação não exige indisponibilidade.
- Eventos inválidos são observáveis sem vazar payload sensível.

