# Tarefa 005 — Dispatch n8n: concorrência e idempotência

Status: **pendente**  
Prioridade: **crítica**  
Dependências: Tarefa 003

## Objetivo

Garantir que múltiplos workers/n8n não retirem o mesmo destinatário, que retries não dupliquem mensagens e que callbacks possam chegar fora de ordem.

## Escopo

- [ ] Substituir autenticação de usuário por credencial de serviço com escopos mínimos.
- [ ] Implementar claim/lease atômico de jobs com expiração.
- [ ] Usar transação e `FOR UPDATE SKIP LOCKED` ou mecanismo equivalente.
- [ ] Definir chave idempotente estável por campanha/destinatário/tentativa lógica.
- [ ] Registrar tentativa, lease owner, lease expiry e resposta do provedor.
- [ ] Implementar retry com backoff e limite.
- [ ] Criar dead-letter e requeue administrativo auditado.
- [ ] Tornar callbacks monotônicos e tolerantes a eventos fora de ordem.
- [ ] Impedir que cancelamento concorra com envio já reclamado sem estado explícito.
- [ ] Criar testes com dois consumidores concorrentes e callbacks duplicados.

## Critérios de aceite

- Dois consumidores paralelos não recebem o mesmo job válido.
- Perda do consumidor libera o job após lease sem duplicação silenciosa.
- Cinco retries lógicos resultam em no máximo uma mensagem aceita pelo provedor.
- Credencial do n8n não acessa CRM, usuários ou configuração administrativa.
- Toda intervenção manual fica em auditoria.

