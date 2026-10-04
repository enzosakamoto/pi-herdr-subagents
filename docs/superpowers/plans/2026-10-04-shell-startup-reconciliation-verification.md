# Verificação do ajuste de startup/reconciliação

Design aprovado: [shell-startup-reconciliation-design](../specs/2026-10-04-shell-startup-reconciliation-design.md), commit `b53e4f9`. [Plano](2026-10-04-shell-startup-reconciliation-plan.md).

## Resultado

- `npm test`: **100 testes passaram** (87 anteriores + 13 regressões).
- `npm run check`: passou.
- `git diff --check`: passou.
- Os testes de regressão foram executados antes da correção e reproduziram as falhas de foreground imediato, argumentos opcionais, cinco reservas interrompidas e referências desaparecidas.

## Mudanças

- `src/layout.ts`: identidade de pane/agente separada da prova de foreground. `awaitShell` mantém delays limitados, consulta identidade a cada tentativa e aguarda dados/foreground comprováveis. Shell conhecido não perde seu fingerprint. PID positivo, nome e argumentos explicitamente diferentes continuam recusados; dados capturados temporariamente ausentes não autorizam mutação. Reservas sem fingerprint também precisam de foreground comprovado antes de serem validadas para layout.
- `startAgent` recebe callback de persistência anterior ao comando; `launchAttempted` é escrito após a espera de shell. Continua sendo intenção, não confirmação de launch.
- `src/tasks.ts`: status e restore consultam pane.get de reservas sem agente/submissão/resultado. Somente pane_not_found não incerto remove o vínculo e marca failed. Pane movido/substituído ou consulta incerta permanece retido. Restore conclui essa reconciliação antes de iniciar observação/handshake, sem relaunch.
- Participantes de journal pendente não são apagados por essa reconciliação; continuam exigindo prova/reconciliação da transação original. Nenhum close/compact/pane adoption é usado para remover referências desaparecidas.
- `tests/fake.ts`: foreground configurável por pane e contador de consultas; simula condições transitórias em vez de sempre devolver shell imediatamente pronto.
- READMEs descrevem as esperas limitadas e a remoção exclusivamente lógica de referências desaparecidas.

## Regressões

1. Foreground adicional temporário: aguarda e envia exatamente um agent.start.
2. Argumentos conhecidos temporariamente ausentes: espera e preserva fingerprint.
3. PID/group/processos temporariamente desconhecidos (null/zero): espera por prova completa.
4. Argumentos inicialmente indisponíveis que depois aparecem: não troca o fingerprint.
5. Foreground permanentemente ocupado: timeout sem intenção de launch nem start/prompt/mutação.
6. PID/nome/argv0/argv explicitamente alterados: recusa imediata, inclusive exec no mesmo PID.
7. Terminal substituído/agente inesperado: não são tratados como condições de espera.
8. Cinco reservas concorrentes com foreground transitório na confirmação dos slots: cinco starts/prompts, layout final sem pendência/auxiliares.
9. Reserva definitivamente desaparecida: status apaga somente o vínculo e permite novo spawn.
10. Restore com launchAttempted=true e handshake ausente: consulta existência antes da handshake e elimina o vínculo desaparecido.
11. Terminal/tab alterado ou erro incerto (inclusive pane_not_found incerto): retém vínculo e não controla o ocupante.
12. Stop durante espera: impede intenção/launch e requests posteriores.
13. Worker desaparecido em journal pendente: mantém o vínculo/registro, sem executar novas mutações.

## Evidência e limites

O histórico real comprova aborto local antes de agent.start no primeiro pedido e interrupção do primeiro auxiliar no segundo. Não há snapshot ofensivo original: foreground de inicialização do zsh/indisponibilidade transitória de campos são mecanismos compatíveis e reproduzidos, não identificação definitiva do subprocesso real que estava ativo.

Nesta implementação não foram manipulados panes reais, configurações pessoais, sidebar ou integrações. A tentativa autorizada de subagente investigador ocorreu antes do ajuste e não iniciou agente: foi recusada pela referência antiga wB:p1M já inexistente. Os testes de cinco agentes nesta verificação são simulados, sem chamadas a modelos.

Esse era o estado antes do reload. Teste live iniciado após o usuário confirmar o reload, conforme evidência abaixo.

## Teste real após reload (2026-10-04, 01:35Z)

Cinco pedidos tier low, resolução `openai-codex/gpt-6-luna`, thinking solicitado low. Todos fizeram handshake, tiveram submitted=true e produziram result.json/settled.json, sem diagnóstico de startup/layout. O journal terminou com record=null. Não inferimos launch de launchAttempted: sessões pi reais registram os prompts e as respostas.

| tarefa | pane | leitura solicitada | resultado |
|---|---|---|---|
| 9fef579e-52e5-4425-a603-2b7f28e22362 | wB:p1W | README.md | resposta com quatro pontos |
| 452925ac-13ec-4e16-87a9-2f089f2bd60b | wB:p1Y | README.pt-BR.md | resposta com quatro orientações |
| 232dee21-fa75-4550-8ba4-f2a36a1705cc | wB:p21 | package.json e src/herdr.ts | pediu os arquivos sem chamar read; não cumpriu a leitura, apesar do transporte/startup funcionar |
| 8edfecda-75d9-426c-bde7-2210b3710076 | wB:p23 | tests/shell-startup.test.ts | chamou read e listou dois títulos; números de linha inexatos |
| add48360-9292-4959-ad2e-413b0be15af4 | wB:p2A | esta verificação | resumiu os resultados/limites anteriores |

A presença simultânea dos cinco panes é comprovada; não equivale a afirmar que os cinco modelos estavam trabalhando simultaneamente (alguns já tinham resultado retido enquanto os seguintes iniciavam).

Layout capturado: tab wB:t1, área 174×53, sidebar wB:p18 em x=0 com 32×53, região própria em x=32 com 142×53. Principal wB:p1 em 71×53; filhos ocupam os outros 71×53, divididos em colunas de 36 e 35 células. Sem auxiliar residual. O primeiro snapshot mostrou foco transitório no filho p23; o snapshot depois de record=null mostrou foco local de volta a p1. Uma outra tab wB:tJ apareceu durante o teste: não atribuir sua origem à extensão sem evidência; não foi adotada/manipulada por nós.

Restore também reconciliou os antigos vínculos wB:p1M/wB:p1P como failed com pane_not_found definitivo; deixaram de bloquear o novo lote.

Na primeira coleta todos estavam completed, notified=false e com seus panes retidos: os follow-ups ainda estavam na fila da sessão principal. Isso era retenção de resultado prevista, não prova de cleanup bem-sucedido.

### Entrega e limpeza confirmadas

Após os cinco follow-ups entrarem no transcript, status confirmou todos como completed, submitted=true, notified=true e sem pane. O primeiro e o terceiro conservaram um diagnóstico de mudança externa de foco; a limpeza pausou e foi reconciliada por status, sem bypass, reenvio de prompt ou close/swap manual. Não declarar que toda a limpeza ocorreu sem intervenção de status.

Snapshot final: somente sidebar wB:p18 (32×53) e principal wB:p1 (142×53) na tab wB:t1, mesma geometria do baseline. Foco local no principal e tab principal selecionada. layout.json tem record=null (transactionId 13602554-1627-4c14-82c3-21d0c85e37df). Sem worker/auxiliar residual na região própria. A tab externa wB:tJ permaneceu intocada; nenhuma tab hs-staging foi observada.

Resultado live: startup, recebimento de prompts, coleta/persistência, entrega e fechamento dos cinco panes comprovados. Quatro leituras realizadas; uma tarefa respondeu pedindo arquivos sem ler, e outra citou linhas inexatas. O estado completed é término da sessão, não garantia de qualidade da resposta.
