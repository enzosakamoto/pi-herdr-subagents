# Verificação: layout incremental sem swaps

## Resultado

Implementado o desenho aprovado em `2026-10-04-incremental-layout-design.md`:

- Um único split por novo filho, sem shells auxiliares ou reconstrução da grade.
- Sequência inicial com colunas `[1, 3, 5]` e `[2, 4, 6]`.
- Fechamento local preservando coluna e ordem vertical dos sobreviventes.
- Coluna vazia colapsa; reabertura com dois ou três sobreviventes usa 0.75 e 2/3 e cria a nova coluna à esquerda.
- Ajustes exatos por `layout.set_split_ratio`, com endpoint vinculado à sessão, resposta correlacionada e observações incertas preservadas.
- Journal v2 validado por replay determinístico; journals v1 pendentes ficam preservados e bloqueados para reconciliação manual.

## Verificação determinística

Baseline anterior: 100 testes passaram, TypeScript sem erros.

Rodada final:

```bash
env -u PI_HERDR_SUBAGENT npm test
npm run check
git diff --check
```

Resultado: **123 testes passaram, 0 falhas**, TypeScript e diff check sem erros. Duração observada da suíte final: aproximadamente 8,6 segundos.

Cobertura inclui:

1. As 720 ordens de fechamento, preservando identidades e região local 50/50.
2. 25 históricos determinísticos de 40 operações intercaladas de criação/fechamento, escolha da coluna menos ocupada, preservação da ordem e ausência de swaps/auxiliares.
3. Panes externos nas quatro direções, múltiplos panes externos, principal deslocado e redimensionamento da região/janela.
4. Reabertura ao lado de pilhas de dois e três sobreviventes, duas colunas mantidas mesmo com poucos filhos e retorno repetido a seis.
5. Preflight 3×3 em todos os passos, inclusive equilíbrio antes de subdividir a última linha.
6. Resposta perdida/rejeitada de split e ratio, callback/persistência interrompidos, shell ocupado/substituído, foco externo e inserção de plugin.
7. Transporte socket com enquadramento JSON-lines, IDs, limite de leitura, timeout/abort, rejeição explícita, resposta truncada/malformada e isolamento de endpoint.
8. Integração existente de resultado durável, follow-up admitido antes de fechar, contabilidade única, prontidão de shell, modelos/tiers/thinking e ramo ativo.

Dois testes de falha de compactação precisaram selecionar o último pane da coluna de três a partir do snapshot real do fake, em vez de presumir que a quinta chamada concorrente sempre produz o quinto pane. O começo efetivo dos filhos pode seguir a ordem de conclusão da persistência; a política incremental deve seguir a árvore, não a posição no array de reservas.

Uma execução delegada da suíte herdou `PI_HERDR_SUBAGENT` e teve sete falhas de modo: a extensão corretamente não registrou o controlador principal dentro de um filho. A rodada final removeu esse marcador explicitamente. Documentação orienta essa remoção para impedir também que testes de hooks escrevam receipts da sessão delegada real.

## Revisão de correção e regressões

Uma revisão independente identificou cinco problemas, reproduzidos e corrigidos com seis testes novos:

- **Fechamento após persistência assíncrona:** revalidar identidade, topologia e quiescência imediatamente antes do comando; não restaurar ao principal um foco que o usuário já mudou nesse intervalo.
- **Split confirmado seguido de erro de observação:** marcar rejeição somente quando a própria requisição mutante é rejeitada. Falha posterior de shell/callback/persistência mantém a prova do nascimento e permite recuperação.
- **Propriedade antes da prova de posição:** persistir o ID retornado, mas comprovar sua presença e árvore after antes de associá-lo à tarefa. Recuperação não chama o callback de propriedade antes dessa prova.
- **Cancelamento com close perdido:** conservar resultado e intenção em `cleanup_pending`; status comprova ausência e finaliza sem repetir o close.
- **Journal de disco sem vínculo do ramo:** ausência de journal ou tombstone do ramo não executa um journal antigo do disco. Progresso só avança uma transação ativa explicitamente vinculada.

Os testes primeiro reproduziram as seis falhas e depois passaram com as correções. Operações de fechamento incertas e não aplicadas continuam bloqueadas, não reenviadas automaticamente.

## Verificação real isolada

Ambiente observado: Herdr cliente/servidor **0.9.3**, protocolo **22**, integração pi **v9**.

Foi criada uma sessão de teste nova, `hs-incremental-test-20261004`, com seu próprio servidor/socket. O harness recebeu o endpoint explicitamente e conferiu no registro que ele correspondia à sessão selecionada e estava em execução. Nunca usou o socket do servidor do usuário para os ajustes nativos.

```bash
HERDR_LIVE_TEST=1 \
HERDR_TEST_SESSION=hs-incremental-test-20261004 \
HERDR_TEST_SOCKET="$HOME/.config/herdr/sessions/hs-incremental-test-20261004/herdr.sock" \
npm run test:live
```

O harness iniciou pi TUIs ociosos com a integração de ciclo de vida explicitamente carregada e modo offline, sem enviar prompts ou fazer chamadas de modelo. Capturou grupos de processo em foreground e verificou que permaneciam vivos e inalterados, juntamente com pane/terminal/agente/sessão.

Foram confirmados **22 checkpoints de geometria/foco**:

- Crescimento de zero a seis e ordem alternada das colunas.
- Preservação do filho selecionado durante compactação.
- Fechamento da coluna esquerda, com fallback do filho selecionado ao principal.
- Reabertura ao lado de três sobreviventes, criando a nova coluna à esquerda.
- Novo colapso e reabertura ao lado de dois sobreviventes com foco em pane externo.
- Crescimento novamente até seis e fechamento arbitrário até zero.

Contagem real do controlador: **11 splits para 11 nascimentos, 12 ajustes de ratio, 11 closes**, nenhum swap, move ou auxiliar.

O plugin de sidebar também criou um pane externo na sessão de teste. O harness foi ajustado para registrar todos os panes externos presentes no snapshot inicial e selecionar foco por vizinhos comprovados, sem presumir qual lado contém o pane criado pelo teste. Esses panes conservaram seus IDs/terminais e retângulos durante as 22 verificações. As duas primeiras execuções diagnosticaram essas suposições do harness; não exigiram alterações no algoritmo de produção.

Evidência fora do repositório: `hs-incremental-live-R1qIku/verification.json`, no diretório temporário do sistema. Logs de testes foram mantidos em `/tmp/pi-herdr-incremental-final-tests.log` e `/tmp/hs-incremental-live.log`. Não foram versionados snapshots brutos de sessões pessoais.

Após o diagnóstico e o teste bem-sucedido, os workspaces criados pelas três execuções foram fechados e o servidor de teste criado nesta verificação foi parado. A sessão `default` continuou em execução. Nenhum pane, servidor, integração ou configuração pessoal do usuário foi reiniciado, adotado ou fechado.

## Limites e ativação

- Injeção exaustiva de falhas, reload/ramo e estados de tarefa permanecem cobertos por testes simulados; não se afirma injeção exaustiva de falhas ao vivo.
- Não foram repetidos os testes que fazem chamadas reais de modelo (`test:live-tasks`, `test:live-extension`). A evidência anterior desses fluxos continua histórica.
- A API não oferece compare-and-swap; verificações detectam alterações observáveis, mas não prometem atomicidade contra mudanças concorrentes do usuário.
- Para a sessão pi já aberta usar os novos módulos, recarregar as extensões com `/reload`. Panes/journals antigos pendentes exigem a reconciliação manual documentada, não migração automática ou swaps.
