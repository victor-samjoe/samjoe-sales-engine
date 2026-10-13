# Análise de lacunas

## Lacunas bloqueadoras do Sales Engine

1. Não existia backend, banco, migrations, autenticação ou API do Sales Engine.
2. O app de pedidos atual não publica eventos padronizados para um CRM externo.
3. Não existe identificador SKU consistente comprovado entre pedido, catálogo e sistema de custos.
4. Consentimento promocional e opt-out não possuem trilha própria e imutável.
5. Pedidos e pagamentos vivem em planilhas/Apps Script; faltam contrato de evento e reconciliação.
6. Não há mecanismo persistente de idempotência para eventos entre produtos.
7. O sistema de custos existente não está pronto para multi-tenancy nem integração HTTP segura.
8. Não há identidade compartilhada entre produtos; compartilhá-la agora criaria acoplamento prematuro.

## Riscos do legado

- Repositório do pedido possui mudanças locais não commitadas.
- Apps Script concentra muitas regras em um arquivo grande e depende de Script Properties.
- Dados financeiros do sistema Python usam ponto flutuante.
- O Worker Cloudflare atual depende da disponibilidade e das cotas do Apps Script.
- Reenvio de WhatsApp após timeout pode duplicar mensagens.
- Telefones, pedidos e clientes podem ter formatos divergentes entre Sheets, n8n e Evolution.

## Decisões para o Checkpoint 1

- Criar API independente em TypeScript/Fastify.
- Usar PostgreSQL desde o começo, em banco exclusivo.
- UUID em todas as entidades e `tenant_id` obrigatório nos dados comerciais.
- Dinheiro em centavos inteiros.
- JWT próprio temporário e memberships por tenant.
- Testes com banco PostgreSQL efêmero ou compatível; nenhum dado real.
- Manter endpoints de integração definidos, mas não ativar callbacks externos ainda.
- Não modificar SamJoE Food legado, n8n, Evolution, planilhas ou sistema de custos.

## Pendências para checkpoints seguintes

- Definir evento canônico de pedido e estratégia de replay.
- Mapear SKUs e status do Apps Script para o contrato novo.
- Criar importação `dry_run` de contatos/pedidos.
- Definir adaptador de custos e política de snapshots.
- Criar frontend administrativo.
- Definir HMAC, rotação de segredo e proteção contra replay.
- Planejar migração gradual do pedido para o SamJoE Food definitivo.

