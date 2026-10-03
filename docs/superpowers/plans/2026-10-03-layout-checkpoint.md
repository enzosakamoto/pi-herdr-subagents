# Step 1 — checkpoint de layout BSP

## Status

**Registro histórico: checkpoint superado.** Após este registro, o usuário autorizou seguir e fazer os testes necessários. O staging no mesmo workspace foi implementado e validado em sessão isolada; veja [verificação e limitações](2026-10-03-verification.md). As pendências descritas abaixo retratam o estado no momento do checkpoint, não o estado atual do package.

Inspeção somente leitura concluída em 2026-10-03. A implementação do controlador de layout aguarda autorização de uma adaptação de topologia. Este registro não substitui o desenho aprovado nem afirma que a extensão esteja implementada.

## Ambiente e evidências

- pi instalado: `1.0.0`.
- Cliente e servidor Herdr: `0.9.3`, protocolo `22`, compatíveis; sem necessidade de reinício reportada por `herdr status`.
- `HERDR_ENV=1`; `pane current --current` resolve o pane principal no diretório deste repositório.
- `pane layout --current` e `tab get` reportam tab não zoomada, com um único pane. Isso verifica a pré-condição atual, não autoriza experiências nesta tab.
- Consultados: spec/plano, documentação instalada de extensions/packages/skills, exemplos `extensions/subagent/{README.md,index.ts,agents.ts}`, `herdr --skill`, ajuda dos grupos pane/tab/api/agent/session e schema instalado (`herdr api schema --json`, schema version `1`).
- O schema foi inspecionado em arquivo temporário, fora do repositório. Não foram incluídos snapshots contendo sessões ou caminhos pessoais no Git.
- Referência complementar: [Socket API](https://herdr.dev/docs/socket-api/), seções de layout, swap e move. A documentação web não substitui a verificação no servidor instalado.

Comandos de controle executados foram somente consultas; nenhum split, move, swap, resize, close, start, prompt, install ou comando de servidor foi executado.

## Capacidades expostas

| Operação | Contrato encontrado | Consequência |
| --- | --- | --- |
| `pane.split` | Alvo é um pane folha; direção `right` ou `down`, ratio opcional e `focus:false` | Não permite dividir diretamente o subtree que contém uma coluna de três panes. |
| `pane.swap` | Direcional ou dois IDs explícitos; documentação preserva forma da árvore, ratios, IDs e processos | Troca posições de folhas, não reparenta um subtree. Pode participar de um algoritmo com placeholders, mas não é um reshape sozinho. |
| `pane.move` | Para outra tab, nova tab ou novo workspace; destino tab exige split e aceita pane alvo | Documentação declara `changed:false`, `reason:"same_tab"` ao mover à própria tab; não se pode usá-lo como reparent intra-tab. Esse comportamento ainda não foi exercitado ao vivo. |
| `pane.resize` | Direção e amount; alvo pane | Ajusta geometria, não a topologia. A equivalência com ratios exatos e o arredondamento ainda requerem verificação. |
| `layout.set_split_ratio` | Schema aceita `path:boolean[]`, ratio e tab/pane opcionais | API socket, sem comando correspondente na ajuda CLI consultada. Não usá-la silenciosamente além da superfície aprovada. Também não reparenta nós. |
| `layout.apply` | Árvore declarativa | Documentação declara criação/recriação de terminais, sem preservar PTYs, scrollback ou processos. Proibido para filhos vivos. |

O schema request não oferece um método explícito de rotação/reparent de subtree vivo. Presença de um método no schema é evidência de interface, não prova de seus efeitos reais sobre processos/foco.

## Por que o algoritmo literal do plano precisa de adaptação

Depois de três filhos, a árvore pretendida é aproximadamente:

```text
right(0.5, Principal, down(Filho1, down(Filho2, Filho3)))
```

Um `right` split de qualquer filho divide só sua linha. Não cria a segunda coluna full-height do quarto filho. Resize não muda esse fato; swap mantém a forma da árvore; move à mesma tab não é reparent; apply não preserva workers.

Isso não prova que toda composição de comandos CLI seja impossível. Por exemplo, dividir o principal à direita pode produzir uma árvore `right(right(Principal, Filho4), coluna123)`. Ratios externos de 0.75 e internos de 2/3 dariam visualmente 50%/25%/25%, mas deixariam de cumprir a invariável do Step 3 de root principal/filhos a 0.5. Compactação e recuperação de fechamentos externos também precisariam de um algoritmo adicional. Outra possibilidade é usar panes shell auxiliares e swaps, preservando workers mas acrescentando panes temporários à tab. Nenhuma dessas adaptações foi implementada, autorizada ou validada ao vivo.

Não reduzir o limite a três, omitir compactação, nem reiniciar workers para contornar o checkpoint.

## Adaptação mínima proposta para autorização

Permitir **uma tab temporária de staging no mesmo workspace**, pertencente exclusivamente à extensão, usada apenas durante mutações serializadas de layout:

1. Mover somente panes filhos próprios e com identidade validada para staging, usando `--no-focus`; nunca mover o principal ou panes alheios.
2. Reinserir esses mesmos panes vivos na tab original com splits explícitos e ratios apropriados, formando primeiro as colunas full-height e depois suas linhas.
3. Manter no layout final o principal à esquerda com 50%, seis filhos ativos no máximo, sem filas e sem workers reiniciados.
4. Reconciliar cada resposta de move (IDs, terminal, tab e foco); não inferir IDs nem tratar timeout como prova de ausência de mutação.
5. Remover somente staging vazio próprio se o servidor não o tiver removido automaticamente. Falha intermediária preserva processos e registra recuperação pendente; não encerra filhos para esconder falha.

A mudança visível é que filhos poderão passar brevemente por uma tab auxiliar durante reorganização. Preservação de foco e de processos precisa de testes determinísticos e, separadamente, testes reais autorizados. Não se afirma ainda que esse algoritmo passou.

A alternativa sem staging exige autorizar uma árvore BSP diferente e/ou panes shell auxiliares na mesma tab, além de provar seu algoritmo. O staging é a proposta mais direta para manter a invariável estrutural literal do plano usando somente a CLI.

## Verificação realizada e pendências

Realizado: leitura dos contratos listados acima, compatibilidade cliente/servidor, schema request de operações relevantes e pré-condição atual da tab. Validação da skill pelo `loadSkillsFromDir` do pi instalado: uma skill `pi-herdr-subagents`, zero diagnósticos, sem chamada de modelo. `git diff --check` também passou. A leitura dos demais contratos de sessão/SDK e declarações de extensão do Step 1 continuará antes de codificar.

Pendente: autorização da adaptação; implementação de package/ferramenta; testes automatizados; TypeScript; discovery/load do package e schemas da ferramenta. Ainda não existe `package.json`, portanto `npm test` e `npm run check` não estão disponíveis.

Testes reais continuam exigindo autorização específica para uma sessão Herdr de teste separada. A autorização de staging em uso normal não autoriza criar essa sessão nem alterar este Space/panes de referência. Não parar, reiniciar ou atualizar o servidor ativo.
