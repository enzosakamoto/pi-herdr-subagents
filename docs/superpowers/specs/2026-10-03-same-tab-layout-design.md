# Reorganização de subagentes na mesma tab, sem staging

## Objetivo e decisão aprovada

Eliminar a criação de tabs `hs-staging` durante spawn e compactação, sem modificar código, configuração ou estado da `herdr-sidebar`. O usuário aprovou seguir com o desenho baseado em splits locais, panes auxiliares próprios e swaps na mesma tab. Durante a revisão foi confirmada uma restrição adicional: o swap do Herdr 0.9.3 força foco no pane de origem, sem opção no-focus. O usuário também aprovou explicitamente essa mudança transitória de foco, com restauração ao final. A implementação aguarda a revisão desta especificação.

Este desenho substitui exclusivamente o algoritmo de staging de `2026-10-03-principal-region-layout-design.md`. Permanecem o isolamento da região do principal, proporção local 50/50, duas colunas para 4–6 filhos, máximo de seis subagentes e todas as verificações de identidade e entrega de resultados.

## Evidências e problema observado

No teste real de três filhos, a extensão criou quatro tabs: duas para adicionar o segundo e terceiro filhos, duas para compactar após encerramentos. O hook `tab.created` do plugin `herdr-sidebar` abriu um pane de sidebar em cada uma. Os filhos retornaram à tab principal, mas as tabs não ficaram vazias e não foram removidas pelo Herdr. Cada tab residual contém uma sidebar, não um subagente.

O algoritmo anterior não registra a propriedade das tabs temporárias nem trata panes inseridos por plugins nelas. Seu fake remove uma tab quando o último pane sai, mas não simula hooks de plugins. Um `agent.prompt --wait` também pode ser invalidado por movimentos entre tabs, produzindo `agent_not_running` sem perda do trabalho já submetido.

Nesta alteração, não limpar automaticamente as quatro tabs já existentes: seus panes pertencem ao plugin, não aos registros de auxiliares da nova implementação. Qualquer limpeza dessas tabs é uma operação separada, com autorização explícita.

## Abordagens consideradas

1. **Nova grade local + swaps (escolhida):** não cria tabs/workspaces e não fecha panes externos. Exige auxiliares temporários, preflight geométrico e registro de operações para recuperação.
2. **Reutilizar uma tab de staging e fechá-la explicitamente:** reduz a proliferação, mas mantém o hook de criação e exige controlar panes de plugin que não são filhos nem auxiliares próprios.
3. **Desabilitar/suprimir o hook da sidebar:** fora do escopo; mudaria configuração ou integração de outro componente.

## Contratos confirmados

Herdr instalado: cliente e servidor 0.9.3, protocolo 22, compatíveis. Foram consultados a ajuda CLI, o schema instalado e a documentação Socket API da revisão v0.9.3, sem mutações reais.

- `pane.split` divide uma folha com direção `right` ou `down`, ratio e `--no-focus`.
- `pane.swap --source-pane ID --target-pane ID` funciona na mesma tab, preservando forma da árvore, ratios, IDs e processos. Retorna `swap.changed`, motivos de recusa, foco e snapshot de layout. A implementação da revisão v0.9.3 em `src/app/api/panes.rs:876–881` chama `focus_pane(source_pane_id)` e `switch_workspace_tab` após a troca: ela força foco na origem, sem parâmetro para impedir isso.
- `pane.close` remove uma folha; um ancestral cuja outra ramificação fica vazia colapsa na ramificação sobrevivente.
- Não usar `pane.move`, `tab.create`, `workspace.create`, `layout.apply`, alterações de ratios por socket ou recriação de workers no novo algoritmo.

Preservação e restauração de foco precisam ser verificadas em testes reais isolados antes de afirmar validação ao vivo deste algoritmo. Não é possível manter a garantia anterior de ausência de mudança deliberada de foco durante todos os swaps usando esta API. O efeito transitório foi aprovado explicitamente; a restauração continua sujeita às verificações de identidade e às limitações de concorrência abaixo. A ausência de `tab.created` elimina o gatilho observado, não promete impedir todo efeito de qualquer plugin: swaps também podem disparar hooks de foco. Se outro hook inserir trabalho dentro da região, as verificações devem interromper a operação.

## Geometria e algoritmo

### Estado estável

O principal e os filhos próprios ocupam uma subárvore dedicada de retângulo U. O principal fica à esquerda com 50% de U. À direita, há uma coluna com 1–3 filhos ou duas colunas iguais com 4–6; linhas equilibradas, com tolerância de uma célula. Panes externos ficam fora de U e não são alvos de mutações.

### Primeiro filho e ausência de filhos

Com zero filhos, criar o primeiro dividindo somente o principal à direita em 0.5, como hoje. Sem sobreviventes, não reconstruir nada: fechar o último filho devolve a região inteira ao principal. Se o layout atual já satisfaz exatamente o formato desejado, compactação pode ser um no-op após validar identidades e geometria.

### Reconstrução com filhos existentes

1. **Validar e planejar:** comprovar identidade do principal/filhos, tab sem zoom, região dedicada, ausência de ocupantes externos dentro dela e viabilidade de todas as etapas. Não criar auxiliares antes do preflight. Serializar a operação inteira.
2. **Preparar destino:** dividir o pane principal à direita em 0.5, criando um shell auxiliar. Dentro desse novo ramo, construir a grade desejada de N slots com splits de shells próprios: primeiro as colunas de largura igual, depois as linhas balanceadas.
3. **Transferir posições:** para cada filho sobrevivente, executar swap explícito com o shell do slot de destino. O filho mantém pane ID, terminal, processo, nome de agente e sessão. O shell auxiliar passa a ocupar a posição antiga do filho. Confirmar a resposta e as identidades de ambos antes de prosseguir.
4. **Novo filho, quando houver:** um dos slots permanece como shell reservado à nova tarefa, com seu marcador `PI_HERDR_SUBAGENT` recebido no split que o criou. Persistir sua propriedade de tarefa separadamente da dos auxiliares. A ordem final dos slots segue a ordem dos filhos fornecida pelo gerenciador, com o novo filho ao final. Não lançar o agente antes de concluir a reconstrução.
5. **Descartar ramo antigo:** depois que todos os filhos sobreviventes estão na grade nova, fechar somente os shells auxiliares que foram deslocados para as posições antigas. Validar identidade e shell em foreground imediatamente antes de cada fechamento. Nenhum filho vivo é fechado para reorganizar layout.
6. **Colapso e verificação:** ao remover o ramo antigo inteiro, seu ancestral colapsa no ramo que contém principal e nova grade. Os ratios internos 0.5 passam a aplicar-se a U inteira. Conferir formato final, identidades, ausência de auxiliares e preservação dos panes externos; registrar operação concluída.

Antes do colapso, o principal e a grade nova ocupam juntos o espaço que era a folha do principal, normalmente metade de U. Portanto o principal fica temporariamente com aproximadamente 25% de U, e os slots novos ocupam outros 25%. Com duas colunas, cada coluna nova tem aproximadamente 12,5% de U durante a transição e 25% ao final. Não é uma nova proporção permanente.

Todos os shells são criados pela extensão na tab principal, com cwd explícito e splits com `--no-focus`. Os swaps, por limitação da API, podem focar temporariamente um filho; usar um filho vivo como origem, não um auxiliar, e restaurar o foco anterior quando seguro. Auxiliares não executam pi, não recebem prompts e não consomem vagas de subagentes. Uma reconstrução tem até N auxiliares, N <= 6. A transição pode conter até seis filhos vivos e seis auxiliares, além do principal; o estado final contém somente principal e filhos.

## Espaço disponível

O planejador usa o snapshot atual e simula retângulos, incluindo arredondamento conservador, de todas as etapas. Não congelar dimensões do primeiro spawn. O guard técnico inicial exige retângulos de pelo menos 3 × 3 células para o principal, cada filho e cada auxiliar durante a transição; isso evita áreas úteis vazias no modelo de frames observado, mas não garante legibilidade confortável do pi.

Se a grade final couber mas a transição não, recusar a reorganização antes de mutações, com diagnóstico que solicita ampliar a região/janela. Não recorrer a staging, fechar um filho ou reduzir silenciosamente o limite. Se a janela encolher durante a operação, interromper e conservar o registro/panes até haver espaço seguro para recuperação.

Após cada split, validar a geometria realmente retornada. Se o Herdr ajustar ratios ou produzir uma geometria incompatível com o plano, não continuar assumindo as dimensões previstas. Preservar a pendência e os terminais; sem fallback global de resize.

## Propriedade e persistência

Separar filhos de auxiliares: não inserir auxiliares em `Tasks.tasks` e não identificar propriedade por nome de pane, label `hs-*`, proximidade ou aparência de shell livre.

Introduzir um registro de layout versionado, vinculado à sessão/ramo ativo e à identidade do principal. Ele contém:

- ID de transação, fase, tarefas participantes e ordem final dos filhos;
- principal, filhos e auxiliares por pane ID, terminal ID, tab e workspace;
- papéis dos shells, incluindo o slot reservado à nova tarefa;
- mapa estrutural de slots e panes, independentemente de coordenadas absolutas;
- intenção da próxima operação e seu estado confirmado;
- identidade do ocupante/tab/workspace com foco no início da transação e último foco causado pela própria extensão.

Persistir intenções antes de comandos remotos e registrar IDs retornados antes da próxima mutação. Gravar estado durável sob o diretório privado da sessão da extensão e custom entries próprias no ramo do principal, sem alterar configurações pessoais. Reconstruir somente um registro que pertença ao ramo/sessão atual; não adotar auxiliares de outra sessão ou de um ramo abandonado.

O vínculo dos filhos não muda durante swaps, mas as posições mudam. A validação da região durante uma transação inclui auxiliares comprovadamente próprios, não somente filhos. Uma transação pendente bloqueia novos spawns/reorganizações independentes até ser reconciliada ou diagnosticada.

## Recuperação e segurança

- Validar identidades e topologia antes de cada split, swap ou close. A CLI não oferece compare-and-swap: não prometer atomicidade contra mudanças concorrentes do usuário.
- `swap.changed:false` não é sucesso. Timeout/resposta incerta exige consulta: comparar o mapa estrutural antes/depois para descobrir se o swap aconteceu; nunca repetir cegamente, pois um segundo swap desfaria o primeiro.
- Se um auxiliar registrado desapareceu durante um close incerto e a topologia corresponde ao estado esperado, confirmar o fechamento sem controlar outro pane. Se identidade/posição não permitirem provar o que aconteceu, conservar a pendência.
- Se um split foi aceito mas o ID novo não foi registrado, não identificar seu resultado apenas pelo delta de panes: pode haver pane criado concorrentemente por usuário/plugin. Reportar incerteza para intervenção, sem novo split automático nem adoção.
- Restaurar/reconciliar auxiliares conhecidos e concluir a operação somente com identidades e topologia comprovadas. Não fechar um auxiliar que ganhou outro agente ou deixou de estar em shell foreground. Um ocupante desconhecido dentro de U também interrompe o controle.
- Preservar resultados já persistidos e as regras de follow-up/quiescência existentes antes do fechamento de um filho concluído. Falha de reconstrução mantém `cleanup_pending` e o registro de layout, não transforma a falha em sucesso visual.
- Nunca relançar um worker nem reenviar um prompt para reparar layout. Startup interrompido antes de lançar pi continua como pendência; não inferir ausência de launch pelo campo `submitted`. Permitir cancelamento seguro de uma reserva cujo pane próprio é comprovadamente um shell, sem prompt ou aprovação automática.
- Registrar o foco inicial da transação, com identidade do ocupante, e reconsultar foco antes de cada swap. Reconhecer que o comando nativo muda esse foco para a origem; usar filhos como origem para não focar deliberadamente auxiliares. Ao concluir ou interromper a sequência, restaurar o foco inicial somente se sua identidade ainda for válida, ele não tiver sido fechado e a seleção atual ainda corresponder ao último efeito de foco da própria extensão. Se o ocupante selecionado foi justamente o filho encerrado pela operação, o principal é o fallback. Uma mudança externa observada interrompe novos swaps e evita restaurar uma seleção obsoleta. A restauração pode selecionar um pane externo que já estava focado, mas nunca altera sua geometria ou ocupante. Sem compare-and-swap, há uma janela de corrida e não se promete ausência de foco transitório ou isolamento de foco contra intervenções concorrentes.

### Compatibilidade com registros anteriores

Filhos legados que ainda estão na tab principal e têm identidades válidas podem participar da nova reconstrução. Filhos legados registrados em outra tab de staging não serão movidos automaticamente pela implementação sem staging: conservar vínculos/resultados e reportar a necessidade de reconciliação. Não adotar as sidebars residuais nem fechar tabs antigas automaticamente.

## Componentes e fronteiras

- **Planejador de geometria:** monta/verifica o mapa de slots e simula as etapas a partir do snapshot; não executa comandos nem grava estado.
- **Controlador em `src/layout.ts`:** valida identidade/topologia e executa splits, swaps e closes serializados; mantém interface de add/compact/close com o gerenciador de tarefas.
- **Estado/registro de layout:** tipos, persistência e reconciliação de intenção/resultado de operações; integra-se ao ramo ativo e ao shutdown/restore da extensão.
- **`src/tasks.ts` e `src/extension.ts`:** ligação entre reserva de tarefa, propriedade de shell de startup, registro de layout e lifecycle; não alteram seleção de modelo, limite de seis ou entrega de resultados.
- **Fake e testes:** modelam swaps preservando pane/terminal/processo, foco, dimensões mínimas e falhas antes/depois da aceitação. Não fingem sucesso automático de um comando incerto.

Manter unidades focadas; extrair planejamento e tipos/persistência para módulos específicos caso a implementação torne `layout.ts` responsável por todos esses detalhes.

## Verificação e aceite

1. Crescimento 0–6, compactação até zero e as 720 ordens de fechamento; proporção local, colunas/linhas e ausência de auxiliares ao final.
2. Panes externos nas quatro direções, principal deslocado e reprodução do layout de referência; nenhum mutante tem pane externo como alvo.
3. Nenhum comando `tab.create`, `workspace.create`, `pane.move` ou `layout.apply` durante o novo layout. Nenhuma tab `hs-staging` nova, inclusive em recuperação.
4. Fake com hook de sidebar em `tab.created`: confirmar que o hook nunca é disparado pelo novo controlador. Com inserção externa durante split/swap, parar sem fechar/reorganizar o pane inserido.
5. Identidades de pane/terminal/agente/sessão e continuidade de trabalho preservadas; nenhuma repetição de start/prompt por swaps.
6. Restauração do foco inicial no principal, em cada filho e em pane externo após o foco transitório obrigatório do swap, inclusive após erro; mudança externa observada interrompe a sequência e evita restaurar uma seleção antiga. Foco em filho encerrado volta ao principal. Documentar a janela de corrida da API, sem prometer atomicidade de foco.
7. Região pequena: recusa prévia, sem criar auxiliares. Redimensionamento entre operações usa medidas atuais; encolhimento durante transação conserva pendência.
8. Injeção de falha em cada fase, inclusive swap/close aceitos com resposta perdida; reconciliação não repete swaps nem controla substitutos.
9. Shutdown/restore com frame parcialmente montado, filhos já trocados e auxiliares ainda no ramo antigo; registro correto permite continuar sem relaunch/resend. Ramo/sessão diferente não adota auxiliares.
10. Cancelamento seguro de reserva em shell próprio após falha pré-startup; resultado concluído permanece disponível se cleanup falhar.
11. Documentação, descrição da ferramenta e skill explicam mesma tab, auxiliares temporários, dimensões mínimas e ausência de staging. O diagnóstico do teste anterior fica histórico, não é apagado.
12. `npm test`, `npm run check` e `git diff --check` passam. Antes de afirmar funcionamento ao vivo, testar splits/swaps/processos/foco em sessão Herdr isolada autorizada, sem chamadas de modelo por padrão.

## Limites de autorização e fora de escopo

Nenhuma alteração na `herdr-sidebar`, integração do pi, configurações pessoais, servidor ou tabs/panes atuais. Testes reais exigem autorização específica para ambiente isolado; esta aprovação do desenho não autoriza experimentar swaps na sessão principal.

Fora do escopo: limpeza automática de tabs antigas, controle de panes do usuário/plugin, alteração da API Herdr, fila de tarefas, delegação recursiva, proporções configuráveis e garantias transacionais contra intervenção concorrente.
