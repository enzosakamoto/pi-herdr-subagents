# pi-herdr-subagents

[English](README.md)

Subagents assíncronos do pi, executados visivelmente em panes do Herdr.

**Status: MVP implementado, verificado com pi 1.0.0 e Herdr 0.9.3 (protocolo 22).**
Repositório somente local: sem remoto, publicação npm ou instalação pessoal automática.
Veja [cobertura e limitações da verificação](docs/superpowers/plans/2026-10-03-verification.md).

## Comportamento

O principal reserva uma tarefa e continua trabalhando enquanto um filho pi TUI inicia
uma sessão nova. Filhos herdam modelo/raciocínio, recebem somente a tarefa/contexto
fornecidos e não têm acesso à ferramenta de delegação deste package. A especialização
opcional é acrescentada ao prompt de sistema.

- Máximo de seis filhos reservados/ativos; sem fila de capacidade nem recursão.
- Mesmo cwd e tab final do principal.
- Inicialmente a tab precisa conter apenas o principal, sem zoom.
- Com 1–3 filhos: principal à esquerda 50%, uma coluna de filhos à direita 50%.
- Com 4–6: principal 50%, duas colunas de 25%, até três linhas balanceadas por coluna.
- Após concluir: persistir o resultado integral, entregá-lo como **follow-up**, fechar
  somente o pane próprio correspondente e compactar sobreviventes.
- Uma mensagem na fila do principal ocupado ainda não é entrega: o pane permanece
  até o follow-up entrar efetivamente no transcript.
- Bloqueios/coletas incertas conservam o pane. Nenhuma aprovação é enviada automaticamente.

### Adaptação BSP autorizada

O Herdr não reparenta um pane dentro da própria tab. Mudanças de layout usam uma tab
temporária `hs-staging` **no mesmo workspace**, movendo os mesmos terminais vivos para
fora e de volta com `--no-focus`. Sem `layout.apply`, recriação de terminal ou reinício
de workers. O staging desaparece quando vazio. A geometria é transitória durante as
mutações; geometria final, continuidade dos processos e foco principal/filho selecionado
foram testados ao vivo. Um filho sobrevivente selecionado recupera o foco se o Herdr
voltou ao principal; se o usuário selecionou outro pane/tab/workspace durante a operação,
a extensão não toma esse novo foco.

## Requisitos e instalação

- pi com os contratos de extensão/ferramenta estruturada instalados (testado: 1.0.0).
- Cliente/servidor Herdr compatíveis (testado: 0.9.3, protocolo 22).
- Principal dentro do Herdr: `HERDR_ENV=1` e contexto de pane gerenciado.
- Integração pi de ciclo de vida funcional; testada com v9. Consulte
  `herdr integration status`. Instalação/atualização é separada; este package nunca
  altera `herdr-agent-state.ts` nem configurações pessoais.
- Credenciais de modelo utilizáveis pelos filhos. Conversas são isoladas; **arquivos,
  credenciais e permissões do sistema não são**. Separe responsabilidades de escrita.

Experimente sem gravar configurações pessoais:

```bash
pi -e /caminho/absoluto/pi-herdr-subagents
```

Para instalar deliberadamente:

```bash
pi install /caminho/absoluto/pi-herdr-subagents
# Depois execute /reload no pi.
```

Após criar seu próprio remoto (aqui ainda não existe), a instalação Git é
`pi install git:github.com/OWNER/pi-herdr-subagents`; substitua OWNER por um repositório real.
O package não escolhe licença/publicação npm pelo usuário.

## Ferramenta: herdr_subagent

Argumentos são chamadas de ferramenta pelo modelo, não comandos de shell:

```json
{"action":"spawn","task":"Mapeie as entradas de autenticação. Não altere arquivos. Retorne caminhos relevantes e riscos.","instructions":"Atue como investigador de código focado."}
{"action":"list"}
{"action":"status","taskId":"ID_RETORNADO"}
{"action":"wait","taskId":"ID_RETORNADO","timeoutMs":120000}
{"action":"cancel","taskId":"ID_RETORNADO"}
```

`spawn` retorna após a reserva persistida, antes do startup/modelo; a resposta inicial
pode ainda não ter paneId. Use o taskId retornado. `instructions` é opcional.
`wait` usa 120000 ms por padrão; intervalo permitido: 1–3600000. Timeout/interrupção
do observador não cancela o filho, não comprova falha de entrega e não reenvia o prompt.

Respostas incluem `content` legível, `details` e `structuredContent` com schema.
Estados: `starting`, `working`, `blocked`, `collecting`, `completed`, `failed`,
`cancelled`, `collection_failed`, `cleanup_pending`.
Resultados trazem texto limitado a 12000 caracteres, stop reason, uso, diagnóstico
e `resultPath` para o JSON integral. Permanecem consultáveis após fechar o pane.
`list` é local; `status` reconcilia identidade e pode concluir coleta, iniciar uma
tarefa **nunca enviada** após resolver bloqueio de startup ou retentar limpeza pendente.

Cancelamento explícito envia Escape ao pi e aguarda quiescência. Busy/unknown após
cancelamento não permite fechar como se fosse seguro. `idle`/`done` sozinho não é sucesso.

Carregue a orientação distribuída com `/skill:pi-herdr-subagents`.

## Persistência e recuperação

O estado fica em custom entries do ramo ativo do principal e em arquivos privados sob
`<diretório-do-pi>/herdr-subagents/<session-id-do-principal>/`. Sessões dos filhos e
`result.json` integrais ficam fora do repositório. O filho registra caminho de sessão
e leaf ativo autoritativos em `agent_settled`; a coleta segue esse ramo e correlaciona
a mensagem única da tarefa. A tela do terminal é diagnóstico, nunca prova de resposta integral.

Shutdown/reload encerra observadores locais, não filhos. Retomar valida terminal, nome
e sessão antes de controlar; nunca inicia outro worker nem repete um prompt já tentado.
Startup interrompido antes do handshake exige intervenção. Panes movidos/substituídos
são recusados, não adotados. Forks/históricos copiados não adotam tarefas de outra sessão
principal; consulte as referências persistidas ou retome a original. Use apenas um
principal por sessão pi. Perdas de panes são diagnosticadas na reconciliação do ciclo
de vida, em `status` ou na retomada; não há polling remoto perpétuo.

Follow-ups são deduplicados pelas mensagens persistidas no ramo e tags de tarefa;
conteúdo duplicado/obsoleto da fila é filtrado do contexto do modelo. Crash abrupto ou
mudança de ramo pode deixar uma mensagem enfileirada sem confirmação; resultados
persistidos são recuperados, não descartados. Uso dos filhos entra uma vez no **próximo
resultado de ferramenta do principal** (a ExtensionAPI pública não oferece appendUsage).
Totais podem atrasar até essa chamada. Buckets de provider/modelo são preservados quando
conhecidos; uso aninhado sem atribuição é marcado explicitamente como unknown.

Falha de fechamento/layout conserva resultado e registro cleanup_pending. `status` ou
retomada pode reconciliar sobreviventes próprios. Nunca recuperar matando/reiniciando
workers ou fechando panes do usuário. Não dispute controle bruto com a extensão.

## Verificação

Desenvolvimento exige Node 24+ (testes TypeScript nativos) e npm:

```bash
npm ci
npm test
npm run check
git diff --check
```

Trinta e cinco testes determinísticos incluem as 720 ordens de remoção, observadores independentes,
capacidade, bloqueios/startup/cancelamento, ramos, respostas integrais, confirmação do
follow-up, contabilidade única, discovery de recursos e schemas.

Testes reais são opt-in e exigem **servidor de teste isolado e nomeado já em execução**.
Não iniciam/param/atualizam servidor nem usam as tabs de implementação/referência:

```bash
HERDR_LIVE_TEST=1 HERDR_TEST_SESSION=sua-sessao-de-teste npm run test:live
HERDR_LIVE_TEST=1 HERDR_TEST_SESSION=sua-sessao-de-teste npm run test:live-tasks
HERDR_LIVE_TEST=1 HERDR_TEST_SESSION=sua-sessao-de-teste npm run test:live-extension
```

Os dois últimos fazem chamadas de modelo. Os testes criam/limpam somente workspaces
próprios; falhas conservam panes/evidências para diagnóstico. Passaram layout real,
dois filhos TUI, cancelamento explícito por Escape e um principal real recebendo follow-ups/contabilidade. Bordas de
reload/ramo/bloqueio têm cobertura determinística; não se afirma cobertura
exaustiva de injeção de falhas ao vivo.

[Especificação](docs/superpowers/specs/2026-10-03-herdr-subagents-design.md) ·
[Plano](docs/superpowers/plans/2026-10-03-herdr-subagents-plan.md) ·
[Checkpoint BSP histórico](docs/superpowers/plans/2026-10-03-layout-checkpoint.md)
