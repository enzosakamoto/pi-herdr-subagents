# Ajuste de espera de shell e reservas desaparecidas

Escopo aprovado pelo usuário (“Pode seguir com ajuste”), após investigação do teste real de cinco subagentes. Mantém integralmente a especificação same-tab anterior, identidade, quiescência, preservação de resultados e isolamento de panes externos.

## Evidências

O primeiro pedido criou wB:p1M e concluiu seu layout em 00:44:24.358Z. A intenção de launch foi persistida em 24.368Z; em 24.382Z, a validação local de shell abortou antes de enviar agent.start. O segundo pedido criou o auxiliar wB:p1N, registrou shell em 27.897Z e abortou em 27.987Z. Nenhum recebeu prompt. Status posteriormente concluiu o frame, deixando a reserva nova wB:p1P sem launch.

O snapshot ofensivo não foi persistido: não atribuir definitivamente a falha a um subprocesso específico do zsh. Reproduções simuladas comprovam que foreground temporariamente ocupado e argv temporariamente ausente abortam no primeiro validate, sem executar as tentativas de awaitShell. Depois que os panes reais desapareceram, outra reprodução mostrou que status retém uma reserva desaparecida sem consultar pane.get; o próximo spawn falha ao validar essa referência antiga.

## Escolha

Preferir espera limitada com prova de identidade, em vez de remover guards de foreground ou tratar informação ausente como sucesso. Não adotar substitutos, limpar tabs/panes do usuário, reiniciar pi ou repetir prompts.

## Contrato

- Separar identidade de pane/agente da prova de shell quiescente. validate mantém a checagem forte de shell conhecido, porém utiliza a espera limitada, não uma recusa instantânea para ausência temporária de dados/foreground ocupado.
- awaitShell reconsulta identidade em cada tentativa. Foreground ocupado, processos adicionais ou campos opcionais anteriormente disponíveis agora ausentes significam “ainda não comprovado”; usar os delays existentes e recusar no prazo se não houver prova.
- PID de shell diferente, nome/argumentos conhecidos explicitamente diferentes, terminal/tab/workspace substituído ou agente inesperado continuam sendo recusa imediata. Não substituir o fingerprint para fazer um ocupante alterado passar. Dados opcionais que nunca foram capturados não são comparáveis; ausência posterior de dados capturados não autoriza uma mutação.
- Antes de split/swap/close de um auxiliar, a prova de foreground continua obrigatória, inclusive após persistência da intenção. Workers em shell reservado também permanecem sujeitos à validação; agentes confirmados usam sua identidade/sessão.
- Persistir launchAttempted no callback imediatamente anterior à chamada agent.start, depois da espera local. Continua sendo intenção, não confirmação de execução; não inferir ausência de launch a partir de submitted.
- Em status e restore, consultar pane.get de reservas retidas sem agente/submissão/resultado antes de tentar a handshake. Somente pane_not_found definitivo permite remover o vínculo e marcar failed. Pane substituído, movido, resposta incerta ou transporte inválido preservam o vínculo, com diagnóstico e sem input/close.
- Não apagar participantes de transação de layout pendente: a recuperação conserva a prova de propriedade anterior. Reconciliação de vínculo desaparecido não executa compactação/close, não procura outros panes e não reaproveita terminais.

## Verificação

Fake passa a aceitar snapshots de process-info por pane. Cobrir busy→idle, campos ausentes→presentes, shell inicialmente com argumentos indisponíveis, timeout permanente sem start/split/swap/close, exec no mesmo PID, PID/terminal/agente substituído, espera interrompida, auxiliares durante crescimento e reconciliação via status/restore de reservas desaparecidas (inclusive launchAttempted=true). Comprovar próximo spawn após reconciliação e ausência de adoção de substitutos.

Sem novas mutações na sessão atual durante implementação. Novo teste com agentes reais usa a autorização de testes do usuário, após carregar o código corrigido; não confundir execução simulada com validação live.
