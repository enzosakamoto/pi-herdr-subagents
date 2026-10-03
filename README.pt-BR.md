# pi-herdr-subagents

[English](README.md)

Subagentes assíncronos do pi, executados visivelmente em panes do Herdr. Delegue trabalho independente, continue trabalhando enquanto novas sessões pi executam em paralelo e receba cada resultado como follow-up na sessão principal.

![Demo](./assets/demo.gif)

## Início rápido

Requisitos: pi, servidor/CLI Herdr compatível, integração de ciclo de vida do pi e credenciais de modelo acessíveis às sessões-filhas. As versões testadas e restrições operacionais estão abaixo.

Experimente a partir de um checkout local, sem gravar configurações pessoais:

```bash
pi -e /caminho/absoluto/pi-herdr-subagents
```

No pi, delegue uma tarefa independente, por exemplo: “Inspecione o fluxo de autenticação. Não altere arquivos; retorne caminhos relevantes e riscos.” O filho abre em um pane do Herdr; o principal pode continuar trabalhando e recebe um follow-up identificado quando o resultado estiver pronto. Consulte as seções abaixo para configuração de modelos, recuperação e testes.

## Conteúdo

- [Comportamento e limites](#comportamento-e-limites)
- [Requisitos e instalação](#requisitos-e-instalação)
- [Ferramenta `herdr_subagent`](#ferramenta-herdr_subagent)
- [Tiers de modelo e configuração](#tiers-de-modelo-e-configuração)
- [Persistência e recuperação](#persistência-e-recuperação)
- [Verificação](#verificação)

## Comportamento e limites

O principal reserva uma tarefa e continua trabalhando enquanto um filho pi TUI inicia
uma sessão nova. Filhos usam um tier configurado, um modelo explícito ou herdam o modelo
do principal quando não há mapeamentos. O nível de raciocínio pode ser configurado por tier
ou herdado do principal, sujeito ao suporte do pi/modelo. Recebem somente a tarefa/contexto fornecidos e não têm acesso à
ferramenta de delegação deste package. A especialização opcional é acrescentada ao prompt
de sistema.

O principal pode delegar trabalho independente autonomamente, sem pedido explícito de
subagentes. Restrições do usuário e limites de aprovação continuam valendo. Evite o custo
de delegação para tarefas triviais ou estritamente sequenciais.

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

| Componente | Requisito / versão testada |
|---|---|
| pi | Contratos de extensão e ferramenta estruturada; testado com 1.0.0 |
| Servidor/CLI Herdr | Versão compatível; testado com 0.9.3 (protocolo 22) |
| Integração de ciclo de vida | Integração pi funcional; testada com v9 (`herdr integration status`) |
| Runtime para testes de desenvolvimento | Node 24+ e npm |

Restrições adicionais: execute o principal dentro do Herdr (`HERDR_ENV=1` e pane gerenciado) e disponibilize credenciais de modelo aos processos filhos. As sessões são separadas, mas **arquivos, credenciais e permissões do sistema são compartilhados**; separe responsabilidades de escrita. A tab inicial deve conter apenas o principal e não pode estar em zoom. A instalação/atualização da integração de ciclo de vida é separada; este package não altera `herdr-agent-state.ts` nem suas configurações.

Experimente sem gravar configurações pessoais:

```bash
pi -e /caminho/absoluto/pi-herdr-subagents
```

Para instalar deliberadamente:

```bash
pi install /caminho/absoluto/pi-herdr-subagents
# Depois execute /reload no pi.
```

Instale do repositório no GitHub:

```bash
pi install git:github.com/enzosakamoto/pi-herdr-subagents
# Depois execute /reload no pi.
```

Este package não é publicado no npm.

## Ferramenta: herdr_subagent

Argumentos são chamadas de ferramenta pelo modelo, não comandos de shell:

```json
{"action":"spawn","tier":"medium","task":"Mapeie as entradas de autenticação. Não altere arquivos. Retorne caminhos relevantes e riscos.","instructions":"Atue como investigador de código focado."}
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

## Tiers de modelo e configuração

Crie a configuração deliberadamente, globalmente em `<diretório-do-pi>/herdr-subagents.json`
(normalmente `~/.pi/agent/herdr-subagents.json`, respeitando `PI_CODING_AGENT_DIR`) e/ou em
`<cwd>/.pi/herdr-subagents.json`. O package não cria esses arquivos automaticamente nem
altera o `settings.json` do pi.

```json
{
  "defaultTier": "medium",
  "models": {
    "low": { "model": "provider/modelo-rapido", "thinking": null },
    "medium": { "model": "provider/modelo-geral", "thinking": "medium" },
    "high": { "model": "provider/modelo-complexo", "thinking": "high" }
  }
}
```

Os IDs são ilustrativos: substitua por IDs exatos `provider/model-id` de modelos de chat
configurados no pi. O principal escolhe o tier conforme a tarefa; o código resolve o modelo.
Tiers são perfis definidos pelo usuário, não garantias de preço ou velocidade.

| Tier | Exemplos |
|---|---|
| `low` | Executar uma suíte de testes definida e reportar resultados; localizar referências; conferir imports/formatação. |
| `medium` | Mapear e entender o fluxo de um use case; implementar uma alteração delimitada; investigar falhas comuns de testes. |
| `high` | Revisar profundamente uma classe recém-implementada quanto a lógica, invariantes e casos extremos; analisar concorrência/segurança; diagnosticar bugs difíceis. |

Escolha a menor categoria adequada. Executar testes é low; diagnosticar suas falhas pode
exigir medium ou high. Tamanho do arquivo, duração dos testes ou chamar algo de review não
justificam high por si só. Faça verificações triviais diretamente, sem abrir um filho.
Não há escalada ou repetição automática em um modelo mais caro. A skill traz mais exemplos.

Regras de resolução:

1. `model` opcional no spawn seleciona um modelo exato quando solicitado pelo usuário;
   é mutuamente exclusivo com `tier`. Não invente IDs ou preços autonomamente.
2. Caso contrário, selecione `tier` ou o `defaultTier` efetivo (implicitamente `medium`).
3. A configuração do projeto sobrepõe a global **por tier** e para defaultTier.
   Cada tier do projeto substitui a entrada global inteira, incluindo thinking; sem merge interno.
4. Sem mapeamentos de modelos (incluindo configuração vazia), herde o modelo atual do
   principal, mesmo com tier informado. **Escolher low sozinho não reduz o custo.**
5. Com algum mapeamento, a ausência do tier selecionado é erro, não fallback implícito.

Para um modelo exato solicitado pelo usuário:

```json
{"action":"spawn","model":"provider/model-id","task":"Faça a investigação somente leitura solicitada."}
```

Os arquivos são lidos a cada spawn. Configuração inválida/ilegível, campos/tiers desconhecidos,
IDs inválidos e modelos de chat desconhecidos falham antes da reserva ou abertura do pane,
inclusive com model explícito. Modelo configurado/explícito funciona sem modelo selecionado
no principal; herança exige um. Providers, modelos e credenciais também precisam estar
disponíveis no processo filho; registros/credenciais apenas em memória no principal não são
transferidos. Falhas de startup/autenticação nunca provocam substituição de modelo.
Como a CLI do pi aceita fuzzy matching, tarefas novas também conferem o modelo efetivo
no handshake do filho antes de enviar a tarefa. Modelo divergente/ausente conserva o pane
com diagnóstico, sem enviar a tarefa; não contorne isso enviando prompts manualmente.
Tarefas antigas sem modelSource mantêm o contrato original de handshake. Essa checagem
não bloqueia mudanças manuais de modelo posteriores ao startup.

`spawn`, `list`, `status`, `wait` e follow-ups expõem `model`, `tier` (exceto com model explícito)
e `modelSource` (`explicit`, `tier` ou `inherited`), além do `thinking` solicitado.
Registros antigos podem não ter esses campos.
A escolha é persistida na reserva: chamadas concorrentes, reloads e alterações posteriores de
configuração não afetam tarefas existentes. O modelo selecionado para startup é distinto da
contabilidade de uso real por provider/modelo.

### Thinking por tier

Cada entrada de models aceita a string legada de modelo ou um objeto com `model` obrigatório
e `thinking` opcional. Os formatos podem ser misturados; não é necessário migrar.

- `thinking: null` significa **off**, assim como `thinking: "off"`.
- Thinking omitido (inclusive nas strings legadas) herda o nível atual do principal;
  sem nível no principal, solicita off.
- Valores válidos: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` ou `null`.
- Valores/campos desconhecidos ou objetos sem modelo válido falham antes da reserva/pane.
- Uma entrada de projeto omitindo thinking não preserva o thinking global do tier: herda
  o principal. `model` explícito no spawn também herda o principal e ignora thinking dos tiers,
  mesmo que o modelo seja igual a um modelo configurado.

Os nomes dos tiers descrevem tarefas, **não níveis literais de thinking**. O exemplo solicita
off para coleta simples, medium para tarefas gerais e high para análises profundas;
ajuste ao suporte do modelo e às suas preferências de custo. Não há argumento thinking no spawn.

O thinking solicitado resolvido é persistido na reserva, passado via `--thinking` e exposto
como `thinking` nos resultados/status/follow-ups. O pi/provider pode ajustá-lo aos níveis
suportados pelo modelo; esse campo **não garante o nível efetivo**. Em particular, null/off
não força o desligamento em modelos que não permitem desativar raciocínio. Não há clamp
próprio da extensão ou rejeição de startup por thinking.

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

Veja [cobertura e limitações da verificação](docs/superpowers/plans/2026-10-03-verification.md).

Desenvolvimento exige Node 24+ (testes TypeScript nativos) e npm:

```bash
npm ci
npm test
npm run check
git diff --check
```

Testes determinísticos incluem as 720 ordens de remoção, observadores independentes,
capacidade, bloqueios/startup/cancelamento, ramos, respostas integrais, confirmação do
follow-up, contabilidade única, discovery de recursos e schemas.
A cobertura de tiers/thinking inclui precedência/validação de configuração, null/off/omissão,
escolhas concorrentes, registros antigos e reloads, usando arquivos temporários e Herdr/registros de modelos falsos.
As mudanças de tiers não têm nova verificação com modelos reais; checagens textuais das
orientações não são avaliações comportamentais de LLM.

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

[Especificação de thinking](docs/superpowers/specs/2026-10-03-tier-thinking-design.md) ·
[Especificação de tiers](docs/superpowers/specs/2026-10-03-model-tiers-design.md) ·
[Especificação](docs/superpowers/specs/2026-10-03-herdr-subagents-design.md) ·
[Plano](docs/superpowers/plans/2026-10-03-herdr-subagents-plan.md) ·
[Checkpoint BSP histórico](docs/superpowers/plans/2026-10-03-layout-checkpoint.md)
