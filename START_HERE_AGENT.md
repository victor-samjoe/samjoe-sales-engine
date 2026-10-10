# Início rápido para o agente local

Você atuará como engenheiro responsável pelo **SamJoE Sales Engine**.

Leia nesta ordem:
1. `SPEC_SAMJOE_SALES_ENGINE_v1.0.md` — escopo, arquitetura, regras, modelos, integrações, testes e critérios de aceite.
2. `AGENT_IMPLEMENTATION_PLAN.md` — checkpoints e prioridades.

**Missão:** construir um motor comercial independente em Node.js, TypeScript e Fastify para a SamJoE Confeitaria, deixando n8n como adaptador de WhatsApp. O FoodApp e o Sales Engine são produtos vendáveis separados e se integram somente por APIs/eventos versionados. Reaproveitar o app de pedidos, sistema de custos, planilhas e fluxos existentes após inspecionar os repositórios. Primeiro MVP: contatos, consentimento, projeções de pedidos, campanhas em dry-run e relatórios; depois mensageria, recorrência e indicações. SaaS somente após validação real.

**Faça agora:**
- Inventarie os projetos locais que eu disponibilizar, tecnologias, bancos, APIs, arquivos de configuração e recursos em produção.
- Identifique componentes que podem ser reutilizados e riscos de alteração.
- Gere `docs/INVENTARIO.md`, `docs/GAPS.md` e plano de implementação específico aos arquivos encontrados.
- Implemente somente o **Checkpoint 1** após o inventário, com testes, sem mensagens reais e sem tocar produção.
- Ao final, entregue relatório do que foi feito, como executar e o que falta.

**Restrições:** não invente endpoints que não existam em integrações atuais; proponha um adaptador quando faltar uma API. Não salve credenciais no git nem dados pessoais em logs. Não inicie WhatsApp comercial sem adesão registrada. Não duplique pedidos/pagamentos/benefícios. Mantenha dados e negócio separados por tenant desde o início. Não priorize estética, funcionalidades avançadas ou refatorações sem relação com o MVP.
