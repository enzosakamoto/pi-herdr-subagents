# Verificação: layout na mesma tab

Implementação da [especificação aprovada](../specs/2026-10-03-same-tab-layout-design.md), conforme [plano](2026-10-03-same-tab-layout-plan.md).

## Implementação

- `src/layout-geometry.ts`: leitura/validação da árvore BSP completa, subárvore dedicada, transformações puras, simulação de transições e mínimo 3×3. Arredondamento/comparação de ratios usam a representação f32 do Herdr 0.9.3. O preflight usa o tamanho atual e é repetido antes de cada etapa.
- `src/layout-state.ts`: registro versionado, identidades/papéis, escopo de sessão/tarefas participantes, foco e intenções. O histórico determinístico é reconstruído ao carregar: IDs de auxiliares não podem ser IDs já presentes na árvore original nem inventar operações de close.
- `src/layout.ts`: splits locais com no-focus, swaps explícitos com filhos como origem e fechamento somente de auxiliares verificados. Confere novamente topologia/foco após persistir a intenção e antes de enviar o comando. Sem pane.move, tab.create, workspace.create ou layout.apply.
- `src/tasks.ts`: journal privado atômico (modo 0600), reserva nova reconectada mesmo quando ainda não nasceu no momento da interrupção, cancelamento comprovado de shell sem agente/prompt e preservação das regras de resultado/follow-up/quiescência. Captura de foco de fechamento do filho fica no registro da tarefa. Requests após stop são recusados antes de chamar a CLI.
- `src/extension.ts`: entries de layout no ramo ativo; progresso/tombstone do disco só substitui a entry do ramo quando o ID de transação coincide. Outra sessão/ramo não adota auxiliares.
- READMEs, skill e descrição da ferramenta: mesma tab, auxiliares, mínimo geométrico, foco transitório obrigatório, recuperação conservadora e legado.

## Testes

`npm test`: **87 testes passaram**. `npm run check` e `git diff --check`: passaram.

Cobertura preservada/ampliada:

- Crescimento 0–6, as 720 ordens de fechamento e proporção local final 50/50, colunas/linhas e remoção de auxiliares.
- Panes externos nas quatro direções, referência com oito panes, dimensões atuais, zoom, principal/filhos movidos ou substituídos e ocupante externo na região própria.
- Recusa explícita em cada uma das 16 mutações da reconstrução 5→6; restore do journal retoma o frame sem reiniciar workers.
- Swap/close aplicados com resposta perdida, inclusive indisponibilidade antes da consulta: operação aplicada não é repetida. Split com ID perdido e swap não comprovado permanecem pendentes, sem adoção/reenvio.
- changed:false não confirma transferência. Uma troca externa que coincide com o destino durante a persistência não é desfeita nem aceita como sucesso da operação recusada.
- Foco transitório realista no fake; restauração no principal, em cada filho, em pane externo e em outra tab com pane único. Mudança externa observada pausa a sequência; filho selecionado fechado volta ao principal.
- Guard geométrico antes do primeiro split e encolhimento no meio da transação; conservação do frame e retomada após ampliar.
- Auxiliar com terminal substituído, novo agente, foreground ocupado ou exec de outro shell mantendo o PID: não é fechado.
- Hook fake de sidebar em tab.created não é disparado; tabs antigas com sidebars permanecem intactas. Inserção por hook durante swap interrompe o controle sem fechar o novo pane.
- Startup interrompido antes do nascimento da reserva e entre persistência do nascimento e callback do ramo: tarefa recebe somente seu shell conhecido, sem start/prompt por recuperação; cancelamento mantém confirmação de follow-up antes de fechar.
- Journal de outro ramo/sessão, versão/histórico inconsistentes e tentativas de registrar shell preexistente como auxiliar são recusados. Ramo sem entry de layout não adota o journal que ficou no disco.
- Seleção de modelo/thinking, limite de seis, integração de lifecycle simulada, coleta/entrega de resultados, contabilidade e schemas/discovery continuam cobertos.

As esperas locais de convergência no fake usam até 10 segundos: o antigo teto de 3 segundos apresentou timeout sob a carga paralela das 720 permutações e fsyncs. O teste de cancelamento passou isoladamente; suas asserções de Escape, quiescência, correlação e fechamento continuam inalteradas. Não se trata de ampliar um timeout de produção nem de medir latência real.

## Limites e autorização

- **Não houve novo teste real de splits/swaps, continuidade de processos ou foco.** Isso exige autorização separada para ambiente Herdr isolado, preferencialmente sem chamadas de modelo.
- Nenhum pane/tab da sessão atual foi alterado; as quatro tabs residuais continuam intocadas. Nenhuma mudança em herdr-sidebar, servidor, configurações pessoais ou integração pi.
- Não se usou delegação live nesta implementação: a ferramenta carregada ainda tinha o controlador anterior de staging. A validação usa Fake/fixtures locais.
- A CLI não oferece compare-and-swap. Persistência e reconsultas reduzem a janela de corrida, mas não tornam geometria/foco atômicos contra intervenção concorrente.
- O foreground precisa ser um shell reconhecido; PID, nome e argumentos disponíveis são conferidos. Shells customizados não reconhecidos e informação insuficiente conservam o pane para intervenção. O mínimo 3×3 não garante legibilidade confortável do pi.
- O diagnóstico/teste anterior com staging permanece histórico. Esta alteração elimina o gatilho observado de tab.created, não promete impedir hooks arbitrários de foco de outros plugins.
