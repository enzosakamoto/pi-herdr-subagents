# Subagents assíncronos do pi em panes Herdr

## Objetivo e decisões aprovadas

Adicionar uma extensão pessoal do pi que delega tarefas com autonomia a outros processos pi, visíveis em panes Herdr. A delegação retorna imediatamente; o principal continua trabalhando e só aguarda explicitamente quando depender de um resultado.

- Até seis filhos ativos, sem delegação recursiva nem fila de tarefas.
- Mesma tab e mesmo diretório do principal por padrão.
- Nenhuma operação muda deliberadamente o foco do usuário.
- Resultados coletados automaticamente antes de fechar os panes criados pela extensão.
- Panes preexistentes não são adotados, modificados ou fechados automaticamente.

## Layout

Com filhos, o principal ocupa a metade esquerda da área de panes da tab. A metade direita contém uma coluna com até três filhos; a partir do quarto filho, contém duas colunas de mesma largura, com até três filhos cada. Os filhos de cada coluna têm alturas aproximadamente iguais, respeitando o arredondamento em células do terminal.

```text
principal 50% | filhos 1–3 25% | filhos 4–6 25%
```

Com até três filhos, a única coluna usa os 50% reservados aos filhos. Ao fechar filhos, redistribuir os restantes para manter o formato compacto. Sem filhos, restaurar o principal à área disponível antes da delegação. Preservar processos vivos durante reorganizações; não usar operações que recriem a tab ou encerrem processos para aplicar um layout.

**Pré-condição do MVP:** a tab deve conter apenas o principal antes da primeira delegação. Caso tenha panes não gerenciados, recusar a delegação com explicação, em vez de descumprir a proporção de 50% ou alterar panes do usuário. Os seis panes atualmente abertos são somente referência visual e devem ser removidos pelo usuário antes do uso nessa tab. Testes reais de layout devem ocorrer em uma sessão de teste separada, com autorização explícita.

## Interface da extensão

Expor operações model-callable para:

1. **Delegar:** receber tarefa e instruções opcionais de especialização; retornar identificador, nome do agente e pane. Usar nomes únicos aceitos pelo Herdr.
2. **Consultar:** listar tarefas da sessão e obter estado, progresso disponível e resultado de uma tarefa específica.
3. **Coletar/aguardar:** retornar o resultado já armazenado ou aguardar uma tarefa ativa, com timeout explícito. Um timeout do observador não cancela o filho.
4. **Cancelar:** interromper deliberadamente uma tarefa gerenciada e coletar os diagnósticos disponíveis antes de liberar seu pane.

O limite é aplicado antes de criar panes. A sétima tarefa é recusada com indicação das tarefas existentes. Espera e consulta não criam novas tarefas.

Cada filho usa sessão/contexto próprios, recebe somente a tarefa e contexto fornecidos pelo principal, e herda modelo e nível de raciocínio do principal por padrão. Instruções de especialização são acrescentadas ao prompt de sistema; não há catálogo de papéis obrigatório no MVP. A capacidade de delegação fica desabilitada nos filhos.

## Execução e coleta

Usar a CLI instalada do Herdr para layout, início, envio, leitura e espera. Verificar `HERDR_ENV=1`, contexto do pane e compatibilidade antes de executar controles. Obter IDs das respostas JSON, nunca inferi-los.

Fluxo: reservar vaga → criar pane → iniciar pi TUI → verificar prontidão → enviar um único prompt → acompanhar em segundo plano → coletar resposta/diagnóstico → persistir resultado → notificar principal → fechar pane → reorganizar layout.

Nunca enviar duas tarefas concorrentes ao mesmo filho. A espera do Herdr observa estado, não identidade de turno. Usar `agent prompt --wait` para observar atividade após o envio; não reenviar automaticamente após timeout ou `agent_prompt_stalled`.

Preferir resultado estruturado da sessão pi persistida, cujo caminho é exposto por `agent_session`, respeitando a árvore/ramo ativo e os limites da tarefa. Usar leitura do terminal para progresso e diagnóstico. Se a resposta completa não puder ser recuperada, manter o pane aberto e informar falha de coleta; não fechar descartando a única cópia do resultado. O fallback documentado do Herdr permite pedir ao filho um arquivo Markdown após essa falha, nunca como requisito do prompt inicial.

A coleta distingue texto final, falha de modelo e interrupção. `idle`/`done` significam disponibilidade, não sucesso. `unknown` não é conclusão. Armazenar uso de tokens/custo quando disponível, sem duplicar contabilidade ao consultar novamente o resultado.

## Ciclo de vida e mensagens

Execuções em segundo plano pertencem à sessão, não ao turno que delegou. Interromper o turno do principal não mata filhos independentes. Aguardar explicitamente pode ser interrompido sem cancelar a tarefa.

A conclusão entrega ao contexto do principal uma mensagem identificada pela tarefa, contendo resultado limitado em tamanho e referência ao conteúdo completo. A entrega deve usar follow-up, sem steering/interrupção de trabalho corrente, e permitir que o principal prossiga quando estiver disponível. Também mostrar status compacto na UI quando houver TUI.

Persistir IDs, propriedade dos panes, estados e resultados no estado da sessão da extensão. Em reload/retomada, reconciliar com o Herdr antes de continuar observando ou limpar; verificar identidade de agente/sessão antes de controlar qualquer pane. Uma tarefa encerrada externamente recebe diagnóstico, não uma nova execução automática.

No shutdown/reload, soltar recursos locais de acompanhamento sem matar filhos ainda trabalhando. Esses filhos ficam visíveis e podem ser reconciliados ao retomar a sessão. Não fechar panes de resultado ainda não coletado.

## Bloqueios e segurança operacional

- `blocked`: conservar pane e avisar o principal/usuário; nunca responder aprovações automaticamente.
- Timeout: consultar estado/terminal; preservar filho ativo.
- Falha de startup: conservar bloqueios; limpar apenas panes próprios comprovadamente sem trabalho ativo quando seguro.
- Pane fechado ou agente substituído: invalidar vínculo, sem controlar o novo ocupante.
- Falha de fechamento/reorganização: preservar resultado e reportar pendência de limpeza.
- Não alterar o arquivo gerenciado `herdr-agent-state.ts`; nossa extensão é separada.
- A integração instalada está na v8 e o Herdr oferece v9. Atualização é uma alteração separada e requer consentimento.
- Panes e diretórios distintos não constituem sandbox. O principal deve dividir responsabilidades de escrita e não delegar alterações concorrentes no mesmo arquivo. Worktrees e outras topologias não fazem parte do MVP.

## Verificação e critérios de aceite

1. Testes de orquestração com CLI simulada: retorno imediato, identidade de tarefa, limite de seis, delegações concorrentes e cancelamento explícito.
2. Testes de layout para 1–6 filhos e todas as reduções até zero: proporção 50/50, no máximo duas colunas, três filas por coluna, alturas balanceadas e preservação de IDs/processos.
3. Testes de coleta: resposta longa, árvore de sessão, erro/aborted, ausência de resposta e notificação única.
4. Testes de falha: blocked, timeout depois do envio, startup falho, encerramento externo e agente substituído; nenhuma aprovação ou repetição automática.
5. Testes de ciclo de vida: principal interrompido, reload e retomada; nenhum pane alheio é fechado.
6. Testes reais em sessão Herdr separada, após autorização: layout e foco, dois pi executando simultaneamente, principal livre após delegar, resultado persistido antes do fechamento.
7. Carregamento da extensão pelo pi instalado e checagem de TypeScript, sem modificar outras extensões ou configurações pessoais.

## Fora de escopo

Filas, delegação recursiva, catálogo de papéis, painel UI próprio, execução remota, containers, worktrees automáticos e atualização automática de integrações.

## Distribuição e ambiente de desenvolvimento

O usuário autorizou criar o repositório `pi-herdr-subagents` em `/Users/enzo/Documents/Development/pi-herdr-subagents`, mover esta especificação, gerar o plano e iniciar sua implementação em um novo Space Herdr, usando pi com modelo `openai-codex/gpt-6.1-sol` e raciocínio `high`.

Distribuir como Pi package instalável via Git e caminho local, com manifesto `pi.extensions` e `pi.skills` em `package.json`. Incluir README em inglês, versão pt-BR e skill de uso da ferramenta. Não publicar no npm, criar remoto ou enviar commits sem solicitação. A skill `writing-plans` não está disponível localmente; o plano será escrito diretamente seguindo os critérios acima.
