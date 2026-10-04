# Layout incremental de filhos, sem swaps ou panes auxiliares

## Objetivo e aprovação

Substituir a reconstrução da grade em cada spawn/compactação por operações incrementais na região do principal. O usuário demonstrou a criação de seis panes e aprovou as regras de fechamento e de reabertura de uma coluna descritas abaixo. Autorizou registrar o desenho, implementar e criar panes para testes. Esta especificação escrita foi revisada e aprovada pelo usuário antes da implementação.

Este desenho substitui o algoritmo e o formato estável de `2026-10-03-same-tab-layout-design.md`. Permanecem as regras de propriedade, sessão/ramo ativo, identidade de terminal/agente, entrega de resultados antes do fechamento, limite de seis filhos, ausência de filas/recursão e isolamento de panes externos.

## Contrato de geometria

- A região administrada U é a subárvore BSP dedicada que contém somente o principal e seus filhos próprios. Panes externos, inclusive a sidebar do usuário, ficam fora de U e nunca são alvos de splits, ajustes de proporção ou fechamento.
- Sem filhos, o principal ocupa U inteira. Com filhos, ocupa a metade esquerda de U no estado estável.
- Os filhos compartilham a metade direita: uma ou duas colunas, cada uma com até três panes e alturas equilibradas. Duas colunas têm a mesma largura.
- O número de colunas segue o histórico de splits/fechamentos, não apenas o total de filhos. Dois ou três filhos podem continuar em duas colunas quando nenhum desses ramos ficou vazio.
- Fechamentos não transferem sobreviventes entre colunas. A ordem vertical dos sobreviventes é preservada.
- Geometria deriva do snapshot atual, não de dimensões absolutas congeladas. Admitir diferenças de uma célula por arredondamento; planejar com a aritmética f32 do Herdr e conferir o resultado real.
- O estado estável é validado por topologia permitida e geometria, não por igualdade com uma árvore canônica montada a partir da ordem das tarefas.

## Criação e escolha da coluna

A sequência inicial é:

| Filho | Operação |
| --- | --- |
| 1 | Split do principal à direita em 0.5 |
| 2 | Split do primeiro filho à direita em 0.5 |
| 3 | Split do filho 1 para baixo |
| 4 | Split do filho 2 para baixo |
| 5 | Split do filho 3 para baixo; equilibrar a coluna esquerda |
| 6 | Split do filho 4 para baixo; equilibrar a coluna direita |

Isso produz colunas `[1, 3, 5]` e `[2, 4, 6]`.

Com duas colunas, acrescentar o novo pane abaixo do último pane da coluna com menos filhos; em empate, escolher a esquerda. Com uma coluna contendo somente um filho, dividir esse filho à direita. Com uma coluna contendo dois ou três filhos, reabrir a segunda coluna conforme a seção seguinte. Nenhum spawn reorganiza os filhos vivos para restaurar uma numeração visual.

Cada spawn cria exatamente um pane, destinado à nova tarefa. Não criar shells auxiliares, slots vazios, tabs ou workspaces de staging. O split pode ter como alvo um filho vivo: isso altera sua geometria, não escreve em seu terminal. Validar a identidade desse filho; não exigir foreground de shell para fazer um split ao lado de um agente em trabalho. A nova reserva, por outro lado, precisa alcançar foreground de shell comprovado antes de iniciar pi.

Concluir e confirmar os ajustes de layout e persistir a propriedade da nova reserva antes de iniciar o agente. Preservar as garantias existentes de prontidão, launch intent, atividade após prompt e ausência de reenvio automático.

## Fechamento

Depois da persistência e entrega do resultado e das verificações de quiescência existentes:

1. Validar a identidade e propriedade do filho e a subárvore administrada.
2. Persistir a intenção de fechamento vinculada à tarefa e fechar somente o pane concluído.
3. Confirmar/persistir o fechamento antes de ajustar sobreviventes. Resposta perdida exige comprovar a ausência do mesmo pane e sua identidade registrada; não reenviar o close às cegas nem confundir fechamento incerto com sucesso.
4. Equilibrar as alturas da coluna afetada: três panes passam a dois em 50/50; dois passam a um com toda a altura.
5. Se a coluna esvaziar, o colapso nativo remove seu ramo. Ajustar os cortes restantes para principal 50% / coluna sobrevivente 50%.
6. Se não houver sobreviventes, o principal recupera U inteira; não reconstruir layout.

A outra coluna conserva sua organização vertical. Uma falha de ajuste depois do fechamento conserva o resultado e a pendência; não reabre o filho, não inicia outro agente e não fecha sobreviventes para corrigir a aparência.

## Reabertura de coluna sem swaps

Quando U contém principal à esquerda e uma coluna com vários filhos à direita:

1. Ajustar o corte existente para 0.75: principal com 75% de U, coluna existente com 25%.
2. Dividir o principal à direita em 2/3. Seu novo ramo ocupa 75% de U; portanto o principal termina com 50% e o novo filho com 25%.

Resultado visual:

```text
Antes:  [ Principal 50% ][ Coluna existente 50% ]
Depois: [ Principal 50% ][ Nova coluna 25% ][ Existente 25% ]
```

O usuário aceitou que a nova coluna apareça à esquerda da existente. Os sobreviventes mantêm seus panes, terminais, processos e ordem vertical, mas sua coluna passa a ocupar o quarto direito de U. Durante a transição o principal fica temporariamente maior, não menor.

A árvore BSP fica diferente da montagem inicial: o corte externo interno a U é 0.75 e o ramo que contém o principal tem corte 2/3. Continuar exigindo a subárvore dedicada U; não exigir que o principal seja sempre a folha esquerda imediata de um corte 0.5, nem que todos os filhos sejam sempre uma única subárvore irmã dele. Permitir somente uma ou duas colunas de filhos com divisões verticais, com o principal à esquerda; não aceitar qualquer árvore arbitrária como forma de contornar a validação.

## Ajustes de proporção e transporte

O schema instalado do Herdr 0.9.3, protocolo 22, expõe `layout.set_split_ratio` com `tab_id`, `path:boolean[]` e `ratio`. Usar essa operação nativa para ajustar precisamente os nós internos registrados no plano. Esta é uma ampliação explícita da superfície permitida: a especificação anterior proibia ajustes de ratio pelo socket.

O transporte fica em `src/herdr.ts`, atrás da interface de controle utilizada também pelo fake. Usar somente o endpoint da sessão Herdr selecionada; testes isolados devem fornecer seu endpoint explicitamente, sem herdar silenciosamente o socket da sessão do usuário. Não adicionar uma API genérica de controle ou fallback para outra sessão. Vincular cada operação à tab validada e ao caminho do nó comprovado pelo snapshot. Aplicar limites de leitura/tempo e distinguir rejeição explícita de resultado incerto, como no transporte CLI existente.

Nunca usar `layout.apply`, `pane.swap`, `pane.move`, recriação de terminais, reinício de workers ou tabs de staging. Não trocar silenciosamente para uma reconstrução caso um ajuste seja recusado.

## Planejamento, propriedade e recuperação

- Manter serialização do ciclo completo de layout e reserva. O planejador puro em `src/layout-geometry.ts` identifica as colunas atuais, escolhe o alvo e projeta splits e ajustes de ratio, incluindo os estados intermediários.
- Exigir pelo menos 3×3 células para principal e filhos em todos os passos. Falta de espaço antes do primeiro comando não autoriza criar uma reserva parcial; redução de janela durante a transição interrompe a operação e conserva evidências.
- Introduzir journal incremental versionado em `src/layout-state.ts`, com proprietário de sessão/ramo, principal e participantes, snapshot inicial que identifica as colunas e sua ordem, plano determinístico, fase confirmada, nova reserva quando existente e intenção before/after da próxima operação.
- Preservar a proveniência disco–ramo: o progresso em disco só pode avançar um journal do ramo ativo com o mesmo transactionId. Sem vínculo do ramo, o registro em disco não é adotado.
- Validar o journal pelo replay do plano derivado do snapshot inicial, não confiar em uma lista arbitrária de comandos persistida. Só uma reserva nova pode ser acrescentada pelo split; nenhuma operação pode apontar para pane externo ou nó fora de U.
- Persistir intenção antes de cada mutação; registrar o ID retornado pelo split antes de qualquer ajuste posterior. Confirmar identidade e árvore após cada operação. Persistir a reserva com sua tarefa antes do launch, inclusive se o split suceder mas o ajuste seguinte falhar.
- Um split com resposta perdida e sem ID durável continua bloqueado para intervenção: não adotar um pane descoberto apenas pelo delta de IDs. Um ajuste com resposta perdida pode ser confirmado pelo mapa before/after; não reenviar cegamente uma operação incerta.
- Preservar `reservedPane`, `reservedTaskId`, callback de propriedade e `recover()` usados pelo gerenciador. A recuperação nunca relança um agente ou repete um prompt já tentado.
- Journals antigos de reconstrução v1 pendentes não são executados pelo controlador sem swaps: conservar os registros e emitir diagnóstico de reconciliação manual. Tarefas antigas estáveis na mesma tab podem continuar após validação das identidades e da topologia permitida. Não adotar auxiliares de outro ramo ou staging legado.
- Não manipular foreground do agente para fazer splits/ajustes. Preservar a comprovação de shell da reserva nova e as verificações de substituição de ocupante.
- Splits usam no-focus; ajustes de ratio não devem selecionar panes. Não sobrescrever uma seleção feita pelo usuário durante a operação. Manter o tratamento de fechamento do filho selecionado: retornar ao principal somente com prova do efeito de foco do fechamento e sem sobrescrever uma seleção posterior observada.
- A CLI/API não oferece compare-and-swap transacional. Revalidar antes de mutações e rejeitar intervenções observáveis, sem prometer atomicidade contra alterações concorrentes.

## Componentes e documentação

- `src/layout-geometry.ts`: inspeção das topologias permitidas, plano incremental, balanceamento e preflight.
- `src/layout-state.ts`: validação/versionamento/replay do journal e política de legado.
- `src/layout.ts`: execução/reconciliação do plano, callbacks de reserva, fechamento e foco, preservando as verificações de identidade e shell existentes.
- `src/herdr.ts`: ajuste de ratio pelo endpoint vinculado à sessão.
- `src/tasks.ts` e `src/extension.ts`: somente adaptações de integração/versionamento necessárias; não alterar tiers, thinking, resultados ou comportamento de modelo.
- READMEs, descrição da ferramenta e skill do projeto: explicar crescimento incremental, colunas dependentes do histórico, fechamento local, reabertura pela esquerda e ausência de auxiliares/swaps/staging.

## Verificação e aceite

Baseline antes das mudanças: `npm test` passou com 100 testes; `npm run check` passou.

1. Crescimento 0–6 reproduz a ordem demonstrada; exatamente um split por spawn e nenhum comando proibido ou pane auxiliar.
2. Todas as 720 ordens de fechamento preservam identidades e ordem vertical, equilibram cada coluna e devolvem U inteira ao principal ao final. Não exigir uma coluna só porque o total ficou menor que quatro.
3. Sequências intercaladas de spawn/close, esvaziamento de cada coluna, reabertura com dois e três sobreviventes e retornos repetidos a seis filhos. Verificar largura 50/25/25 e a nova coluna à esquerda nesses casos.
4. Panes externos nas quatro direções, múltiplos panes externos, principal deslocado e redimensionamento de janela/ancestrais. IDs, terminais e geometria externa permanecem preservados; nenhum mutante controla pane/nó externo.
5. Preservar agentes trabalhando e sua identidade durante splits de panes vivos; reserva nova comprovada como shell antes de start. Retenção de resultados, entrega diferida e uso contabilizado uma vez permanecem intactos.
6. Falhas antes/depois de cada split e ajuste, rejeição explícita, resposta perdida, persistência interrompida e retomada de ramo correto. Journal inválido, slot não comprovado, pane substituído, zoom e região contaminada bloqueiam controle.
7. Foco de principal, filho e pane externo permanece durante splits/ajustes; fechamento do selecionado respeita fallback e mudanças externas posteriores. Nenhum efeito de foco de swap existe.
8. Journals legados pendentes são preservados e bloqueados; tarefas legadas estáveis são validadas sem reconstrução.
9. `npm test`, `npm run check` e `git diff --check` passam. Testes reais em sessão Herdr isolada autorizada verificam ajuste de ratio, topologia alternativa, processos/PIDs, foco e panes externos. Não fazer chamadas reais de modelo nos testes por padrão.
10. Testes reais criam/controlam somente seus próprios recursos e limpam somente recursos comprovadamente seus. A sessão atual e seus panes externos não são usados como laboratório, nem seu servidor é reiniciado ou parado.

## Fora de escopo

Mudanças na sidebar, protocolo/servidor Herdr, configurações pessoais, adoção de panes existentes, proporções configuráveis, limpeza de staging antigo, filas, recursão e melhorias não relacionadas ao controlador de layout.
