# Tarefa 003 — Estabilização da base atual

Status: **pendente**  
Prioridade: **bloqueadora**  
Dependências: concluir ou pausar de forma consistente a Tarefa 002

## Contexto

A implementação atual avançou além do relatório do Checkpoint 1, mas a árvore possui alterações locais e o `npm run typecheck` falha. A integração com o SamJoE Food não deve ser promovida enquanto a baseline não estiver reproduzível.

## Objetivo

Restabelecer uma baseline verificável, atualizar a documentação e separar trabalho concluído de experimentos locais.

## Escopo

- [ ] Inventariar mudanças locais sem descartá-las.
- [ ] Corrigir todos os erros de TypeScript com `exactOptionalPropertyTypes` e `noUncheckedIndexedAccess`.
- [ ] Garantir que `npm test` encerre de forma determinística.
- [ ] Validar migrations em PostgreSQL real, além do `pg-mem`.
- [ ] Executar `npm run typecheck`, `npm test` e `npm run build` em ambiente limpo.
- [ ] Atualizar `README`, contratos, modelo, changelog e relatório de implementação.
- [ ] Marcar honestamente os itens concluídos e pendentes da Tarefa 002.
- [ ] Criar CI bloqueando merge quando qualquer verificação falhar.

## Critérios de aceite

- Working tree e mudanças pertencentes à tarefa estão compreendidas e documentadas.
- Typecheck, testes e build passam em sequência.
- Migration `001` + `002` funciona em PostgreSQL suportado.
- Documentação descreve o código atual, não apenas o Checkpoint 1.
- Nenhum envio real, cobrança ou chamada ao SamJoE Food é executado.

