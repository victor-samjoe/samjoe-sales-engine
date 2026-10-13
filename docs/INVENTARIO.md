# Inventário técnico — SamJoE Sales Engine

Data: 2026-10-10

## Produto novo

- Diretório: `E:\SamJoE Sales Engine`.
- Estado inicial: documentação v1.1, sem código de aplicação.
- Papel: CRM, consentimento, campanhas, recorrência, indicações e inteligência comercial.
- Stack decidida: Node.js, TypeScript, Fastify, PostgreSQL e Next.js.

## SamJoE Food e pedido atual

### Especificação do produto

- Diretório: `E:\SamJoE SamJoE Food`.
- A spec define plataforma multi-tenant, frontend Next.js, API Node.js/TypeScript, PostgreSQL, Redis, R2, n8n, Evolution e Mercado Pago.
- Ainda não havia aplicação implementada nesse diretório no início deste inventário.

### Legado em produção/desenvolvimento

- Diretório: `E:\SamJoE\Bolo_Pote_Docker_n8n_Evolution`.
- Repositório Git existente com alterações locais não commitadas; não modificar durante o Checkpoint 1.
- Apps Script:
  - `MVP_Operacao_Web_V3.gs`: pedidos, clientes, catálogo, frete, rotas, estados e Mercado Pago;
  - `Frontend_Externo.gs`: contrato público do frontend;
  - `Sistema_Entregas.gs`: cálculo e otimização de rotas;
  - `PedidoForm.html` e `PainelMVP.html`: pedido público e operação.
- Cloudflare Pages/Worker em `cloudflare-app`; o Worker atual é um proxy para Apps Script.
- Contratos públicos encontrados: `public_menu`, `public_validate_address`, `public_submit_order` e `public_product_image`.
- Dados operacionais atuais: Google Sheets; há exportações `.xlsx` em `Planilhas`.
- Integrações: Mercado Pago, Google Maps/Routes, Google Drive, n8n e Evolution API.
- Infra: Docker Compose local e configuração de produção com PostgreSQL separados para n8n/Evolution, Redis e proxy Caddy.

## Custos e produção

### Aplicativo Python existente

- Diretório: `E:\SISTEMA SAMJOE`.
- Stack: Streamlit, SQLAlchemy e SQLite (`sistema_samjoe.db`).
- Domínios implementados: matérias-primas, fichas técnicas, compras, lotes, estoque, vendas, custos, precificação e relatórios.
- Limitações: valores financeiros em `Float`, IDs inteiros, ausência de `tenant_id`, autenticação incompleta, banco fixado em código, sem migrations e teste funcional destrutivo.
- Decisão: não usar seu banco como dependência direta. Criar adaptador de snapshots por SKU e planejar migração própria do módulo de custos.

### Calculadora Apps Script

- Diretório: `E:\SamJoE Custos e Relatorios\SamJoE_Codigo_AppsScript`.
- Calculadora client-side para cenário de custos, persistida em `localStorage`, sem banco compartilhado.
- Pode exportar CSV/JSON; será uma fonte de importação, não sistema de registro do CRM.

## Raio de atendimento

- Diretório: `E:\SamJoE Raio de Atendimento\samjoe-localizacao-mvp`.
- Serviço JavaScript/Cloudflare Worker com regras de área, CEP e rotas, acompanhado de testes.
- Decisão: SamJoE Food consome esse serviço para cotação/validação. Sales Engine recebe somente dados consolidados do pedido.

## n8n e WhatsApp

- n8n e Evolution já existem na stack do app legado.
- Há workflow exportado de pedido estruturado por WhatsApp.
- Decisão: n8n permanece adaptador de transporte. Consentimento, elegibilidade, frequência, campanha e recompensa pertencem ao Sales Engine.
- Nenhum envio real será ativado por padrão.

## Segredos e dados pessoais

- Existem arquivos `.env` no legado; conteúdo não foi copiado.
- Planilhas e bancos existentes podem conter dados pessoais e não serão incluídos neste repositório.
- O novo projeto usará apenas `.env.example` e dados fictícios em testes/seeds.

## Fontes de verdade propostas

| Domínio | Fonte de verdade |
|---|---|
| Catálogo, preço, pedido, pagamento e entrega | SamJoE Food |
| Contato CRM, consentimento, campanha e indicação | Sales Engine |
| Ingredientes, ficha técnica, lote e custo efetivo | Sistema de custos |
| Transporte WhatsApp | n8n + provedor |
| Área e cotação de entrega | SamJoE Food/serviço de localização |

