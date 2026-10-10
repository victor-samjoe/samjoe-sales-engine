# Privacidade e segurança — base inicial

- Dados pessoais são isolados por `tenant_id`.
- Telefones são normalizados, mas não devem aparecer completos nos logs.
- Consentimentos são eventos imutáveis; revogação atualiza imediatamente a projeção `do_not_contact`.
- Senhas usam bcrypt; tokens JWT exigem segredo forte fora do repositório.
- Testes e seeds usam somente identidades fictícias.
- O projeto não importa listas, planilhas ou bancos reais automaticamente.
- Integrações futuras exigirão assinatura HMAC, proteção contra replay e retenção mínima de payload.

