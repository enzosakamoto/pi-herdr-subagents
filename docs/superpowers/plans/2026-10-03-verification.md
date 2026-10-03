# Implementação e verificação — pi-herdr-subagents

## Resultado

MVP executável implementado. O usuário autorizou seguir com a adaptação de staging e
os testes necessários após o checkpoint BSP: “Pode seguir, faça os testes necessários”.
Isso não autorizou remoto, push, publicação npm, instalação pessoal ou atualização
de integração/configuração; nenhuma dessas ações foi realizada.

O servidor original e os panes de implementação/referência não foram alterados.
Os testes reais usaram exclusivamente a sessão nomeada
`pi-herdr-subagents-test-20261003`, criada separadamente. O servidor original não foi
parado/reiniciado/atualizado.

## Contratos e desenho efetivo

- Cliente/servidor Herdr 0.9.3, protocolo 22, schema version 1.
- pi instalado 1.0.0; Node 24.15.0; TypeScript 5.9.3.
- Dependências de host locais para desenvolvimento resolvidas pelo npm: pi 1.0.1,
  typebox 1.3.34. O loader/CLI instalado e os testes reais usam pi 1.0.0.
- A integração gerenciada foi encontrada já em v9 na inspeção desta execução.
  Somente leitura; não foi atualizada/editada por esta implementação.
- Lidos contratos de extensions, packages, skills, CLI, session-format, message-types,
  SDK, TUI, configuração/settings, CLI integration; exemplos subagent e ferramentas;
  declarações de ExtensionAPI, SessionManager, loaders e implementação instalada de
  sendCustomMessage para confirmar queue/admission.
- CLI usada com argument arrays, sem interpolação de shell; IDs das respostas.
- Manifesto `pi.extensions`/`pi.skills`, peers com `"*"`, sem dependencies de runtime
  ou framework. Node nativo executa os testes TypeScript.
- Uma ferramenta `herdr_subagent`: spawn/list/status/wait/cancel, união discriminada,
  outputSchema e structuredContent.
- Reserva persistida antes do startup; seis vagas incluindo startup/pendências, sem
  espera por capacidade. Startup/layout serializados; trabalho de modelo sobreposto.
- Filhos TUI preservam integração Herdr; um marcador de processo desabilita apenas
  a delegação deste package e ativa handshake/receipt de settlement.
- Staging no mesmo workspace para reorganizar folhas BSP vivas. Root final
  principal/filhos 0.5; nenhuma utilização de layout.apply ou reinício de worker.
- Identidade verificada por pane/terminal, nome e sessão antes de input/close.
- Fonte de resultado: sessão v3, ramo/leaf autoritativo emitido pelo filho em
  agent_settled, prompt único correlacionado. Não é uma busca pelo último texto da tela.
- Resultado integral salvo antes da notificação. Fechamento aguarda message_end do
  follow-up no transcript do principal, não apenas enqueue.
- Estado do ramo ativo, arquivos privados de runtime fora do Git, reconciliação em
  retomada; callbacks antigos não enviam mensagens a outra sessão.

## Testes determinísticos

`npm test`: **35 testes passaram**. Incluem:

- Transportes JSON/texto, erros stderr/syntax, quoting, ambiente e timeout incerto
  após aceitação.
- Crescimento 0→6 e todas as **720 ordens de remoção**, geometria 50/50, alturas com
  rounding, terminais/IDs, foco principal, remoção do staging e falhas de mutação.
- Panes alheios, zoom, principal/filho substituídos ou movidos.
- Spawn antes de startup lento; limite sob chamadas concorrentes; modelo/raciocínio capturados na reserva (não na seleção posterior do principal); dois filhos trabalhando.
- Espera interrompida/timeout sem cancelamento ou reenvio.
- Blocked em execução/startup, incluindo sidecar de UI após invalidar wait por move, aviso sem aprovação; um único prompt nunca enviado
  pode ser iniciado por status após intervenção.
- Cancelamento explícito e durante startup; unknown não é sucesso.
- Falha de persistência conserva pane; perda externa remove o alvo vivo.
- Falha de compactação conserva resultado e cleanup_pending; status reconcilia
  sobreviventes sem reiniciar workers.
- Shutdown/retomada sem novo start/prompt, callbacks obsoletos, ramos abandonados e recusa de adotar workers de outra sessão a partir de histórico copiado.
- Texto além do viewport, múltiplos blocos, árvore, stopReason error/aborted/length,
  uso de modelo/ferramenta, correlação ausente e escrita JSONL parcial.
- Resultado persistido resolve wait mesmo com follow-up ainda enfileirado; follow-up efetivamente admitido antes de close; contabilidade uma vez, reconstruída
  do transcript, filtragem de outbox duplicado/obsoleto.
- Discovery do package/ferramenta/skill, peers, schemas e exemplos da skill.

`npm run check`: passou.
`git diff --check`: passou.
`npm pack --dry-run`: arquivos de distribuição sem node_modules/transcripts.
Loader instalado e invocação explícita `pi --offline --no-approve -e <repo> --help`:
carregamento sem configuração pessoal ou chamada de modelo para esse smoke check.

## Testes reais autorizados

### Layout e continuidade de processos

`HERDR_LIVE_TEST=1 npm run test:live`: passou na sessão isolada.

- 1–6 filhos e redução arbitrária até zero.
- Colunas full-height, principal 50%, alturas balanceadas e rounding.
- PID de cada processo de teste e terminal_id sobreviveram aos moves/reflows.
- Foco principal e recuperação de filho sobrevivente selecionado.
- Somente workspace/panes de teste próprios foram limpos.

### Dois filhos pi TUI

`HERDR_LIVE_TEST=1 npm run test:live-tasks`: passou.

- Reserva local retornou em 8–16 ms nas execuções registradas.
- Dois pi reais executaram trabalho simultâneo.
- Uma tarefa/prompt por sessão própria, resposta estruturada completa persistida
  antes de fechar seus panes.
- Um terceiro filho recebeu cancelamento explícito por Escape; settlement correlacionado e diagnóstico aborted foram persistidos antes de cleanup. A última execução passou em `hs-live-tasks-CtI48r`.
- Também foi verificada recuperação real de um filho sobrevivente após parar seu observador local: mesmas sessões/resultados, sem relaunch/resend.
- Evidências privadas em diretórios temporários `hs-live-tasks-*`, fora do Git.

### Principal pi real e follow-ups

`HERDR_LIVE_TEST=1 npm run test:live-extension`: passou.

Um principal real fez seu próprio `bash sleep 10` enquanto dois filhos executaram
tarefas independentes. O transcript confirmou dois follow-ups identificados, duas
atribuições de uso sem duplicação, consulta dos resultados e fechamento dos panes
dos filhos. A tab voltou a um único pane. Evidência final:
`hs-live-extension-XWcew8/principal.json`, no diretório temporário do sistema.

O fixture de teste chama o mesmo factory/contratos da extensão, registra um comando
somente de teste e não instala nada nas configurações pessoais.

## Falhas encontradas durante a validação e correções

Não foram omitidas falhas iniciais:

1. Native strip-only rejeitou parameter properties TypeScript; substituídas por
   campos explícitos, sem adicionar um transpiler/framework.
2. Um callback de ownership alterava o array de teste durante add; snapshot local
   evita tentar mover o próprio staging para a mesma tab.
3. `pane run` retorna texto vazio, não JSON; o teste usa o transporte textual.
   wait-output usa regex para não confundir echo do comando com resultado/PID.
4. Agent start pode recusar um shell recém-criado/movido como `agent_pane_busy`
   mesmo após seu processo aparecer no foreground. Isso causou falha real de
   startup no teste integrado. Agora há verificação limitada de foreground e
   até quatro tentativas **somente para essa recusa explícita anterior ao launch**.
   Timeout/aceitação incerta, blocked e prompt nunca são retentados.
   O teste integrado seguinte passou; as evidências dos runs falhos foram preservadas
   antes de limpar somente seus workspaces próprios.
5. Um teste de teardown interpretava cleanup transitório como falha/interrompia o observador antes de terminar a compactação. O estado transitório agora é collecting; finalização exige concluir a compactação e o harness aguarda todos os callbacks. Resultados dos runs interrompidos foram recuperados dos mesmos filhos antes de limpar os panes próprios.
6. O teste concorrente tinha uma suposição de ordem de startup baseada na ordem das reservas; passou a aguardar ambos os filhos efetivamente iniciados antes de injetar a falha.
7. Escape pode interromper antes de existir resposta final de assistant. Com cancelamento explícito, receipt correlacionado e quiescência verificada, a coleta produz diagnóstico aborted, nunca uma resposta antiga/sucesso inventado. Send-keys aceita ack textual/vazio; erros continuam sendo interpretados pelo transport.
8. Um CLI wait iniciado num pane pode retornar `agent_not_running` ao mover esse
   terminal pelo staging. O nome/terminal/sessão são reconciliados; coleta depende
   do receipt de settlement e estado quiescente, não desse erro nem de um resend.

## Limitações explícitas

- Geometria transitória e possível fallback momentâneo de foco durante staging.
  Restauração de foco não é uma transação atômica com ações concorrentes de usuários
  em outros clientes. Checks e comandos CLI também não constituem compare-and-swap;
  não disputar controle de um pane com a extensão.
- Uma tarefa interrompida antes do handshake ou com entrega tentada mas não confirmada
  não é relançada. Após resolver um diálogo de startup, consultar status pode iniciar
  a tarefa somente se submitted continua false.
- Depois que um wait CLI é invalidado por movimento, detecção de perda externa pode
  exigir status/retomada; não há polling remoto perpétuo.
- Uso assíncrono entra no próximo resultado de ferramenta do principal. Sem essa
  chamada, totais permanecem temporariamente atrasados. Uso sem provider/modelo
  na fonte não recebe atribuição inventada.
- Pending outbox pode atravessar crash/ramo; deduplicação cobre mensagens persistidas
  e contexto do modelo, não promete exactly-once da UI sob crash arbitrário.
- Arquivos são compartilhados; sem sandbox/worktree ou isolamento de credenciais.
- Casos de reload completo do pi/branch/bloqueio/falha de disco têm testes simulados.
  Cancelamento explícito e retomada do observador também foram exercitados ao vivo, mas não há cobertura exaustiva de fault injection.
- Repositório local, versão privada 0.1.0; não publicado e sem licença escolhida.

Os resultados persistidos e os READMEs/skill refletem o comportamento implementado,
não um contrato ainda inexistente.
