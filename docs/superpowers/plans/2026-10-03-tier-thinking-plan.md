# Plano: thinking nullable por tier

Especificação aprovada: [thinking por tier](../specs/2026-10-03-tier-thinking-design.md). A skill writing-plans não está disponível; plano registrado diretamente. Sem testes live/chamadas de modelo.

1. Ampliar Config para entrada string ou objeto model/thinking. Validar todos os níveis do pi e distinguir null de omissão. Preservar merge por entrada inteira e seleção de modelo existente.
2. Resolver thinking após a seleção do modelo, usando o snapshot do principal apenas para herança; null vira off. Override model explícito não recebe thinking de tier.
3. Expor thinking solicitado na projeção de tarefas/outputSchema, reutilizando persistência e argumentos CLI existentes.
4. Testar compatibilidade, níveis válidos, objetos inválidos, merge, concorrência, CLI, snapshots, reload, status/follow-up e configuração inválida sem panes.
5. Atualizar READMEs e skill: null/off/omissão, substituição por entrada inteira, níveis suportados e thinking solicitado versus efetivo.
6. Rodar npm test, npm run check e git diff --check; revisar diff sem criar configurações pessoais.

## Resultado

Etapas concluídas. Resolução de thinking distingue explicitamente null/off de omissão; formato string continua compatível. Resultados/status/follow-ups expõem o thinking solicitado, sem prometer nível efetivo do provider. A revisão confirmou que não há clamp próprio nem mutação de defaults compartilhados.

- `npm test`: 55 testes passaram (incluindo as 720 ordens de remoção de panes).
- `npm run check`: passou.
- `git diff --check`: passou.
- Validação inclui exemplos dos dois READMEs e da skill, arquivos temporários, spawns concorrentes, snapshot do principal durante I/O, persistência e reload.
- Não foram criados arquivos pessoais de configuração nem executados testes live, chamadas de modelo ou medições reais de custo/latência.
