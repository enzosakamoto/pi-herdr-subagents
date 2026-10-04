# Plano: layout na mesma tab

Spec aprovada: [same-tab-layout-design](../specs/2026-10-03-same-tab-layout-design.md). `writing-plans` indisponível localmente; plano direto, como nas alterações anteriores. Sem subagentes nesta implementação: a ferramenta carregada ainda cria staging. Sem mutações reais nesta sessão.

1. Extrair geometria BSP pura: leitura validada do snapshot, subárvore dedicada, transformações split/swap/remove, planejamento de slots, preflight 3×3 e formato final.
2. Implementar registro versionado de operações e controlador same-tab: intenções persistidas, auxiliares próprios, swaps com foco transitório/restauração e closes quiescentes. Reconciliação de aceitação incerta sem repetir swaps.
3. Integrar estado de layout à persistência/ramo ativo em Tasks/extension; retomar apenas propriedade comprovada. Permitir cancelamento de reserva em shell próprio. Não iniciar agentes ou prompts por recuperação de layout.
4. Atualizar Fake para swap/foco, pane list, erro após aceitação e hook de tab criada. Adaptar testes históricos de staging e adicionar testes de recuperação/preflight/intervenção/ramo.
5. Atualizar READMEs, skill e descrição da ferramenta. Registrar cobertura e limitações; rodar testes focados, `npm test`, `npm run check`, `git diff --check`.

Testes reais de swap/processo/foco requerem autorização separada para sessão isolada. Não limpar as tabs residuais da sidebar nem alterar integrações/configurações.
