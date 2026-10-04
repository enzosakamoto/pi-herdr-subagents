# Verificação: layout relativo à região do principal

## Implementado

- `src/layout.ts`: panes externos permitidos; identidade e geometria do snapshot validadas; principal e filhos devem preencher uma subárvore BSP dedicada. Splits locais e staging vivos permanecem iguais; não há cálculo absoluto congelado, resize global ou adoção.
- `src/extension.ts`, READMEs e skill: removida a restrição de tab inicialmente com um único pane; documentadas região local 50/50, não adoção e reconciliação em caso de subárvore contaminada.
- Fake: retângulos de splits, metadados de tab/workspace, área redimensionável e foco/neighbor.

## Evidências

- Antes da correção, novos testes falharam pela rejeição de panes não gerenciados, reproduzindo o bug. Respostas inconsistentes também expuseram validações ausentes.
- `npm test`: 67 testes passam, incluindo as 720 permutações de remoção preexistentes.
- `npm run check`: TypeScript passa.
- `git diff --check`: passa.
- Consulta somente leitura com `Layout.checkTab([])` contra o snapshot da sessão atual: aceita a tab com oito panes. Essa consulta usa apenas `pane current` e `pane layout`; não executa split, move, resize, close, start ou prompt.

## Cobertura adicionada

1. Crescimento até seis filhos e compactação até zero com panes externos à esquerda, direita, acima, abaixo e em múltiplos lados; três ordens de fechamento por configuração. Retângulos e terminais externos permanecem iguais.
2. Reprodução simulada do layout observado: tab 185 × 58, sidebar 32 × 58, principal 84 × 58 e seis panes de referência externos. A família de novos subagentes usa apenas os 84 × 58 atuais, sem incorporar os 69 × 58 das referências.
3. Redimensionamento da área entre operações e principal com deslocamentos horizontal/vertical; proporções seguem a região atual.
4. Foco preservado no principal, filho selecionado e pane externo durante crescimento/compactação.
5. Panes externos adicionados como irmãos são aceitos. Pane externo inserido dentro da família, filho relocacionado e união retangular que não corresponde a uma subárvore são recusados antes de mutações.
6. IDs duplicados/ausentes, retângulos inválidos, cobertura incompleta/sobreposta, ausência de splits e snapshot de outra tab/workspace impedem mutações.
7. Recuperação de staging total ou parcial, conservando terminais e panes externos.
8. Seis tarefas com pane externo passam por shutdown/restore e encerram sem repetir starts/prompts; retomada recupera cleanup_pending com filhos em staging.
9. Resultado já coletado é conservado quando intervenção do usuário impede cleanup; nenhuma pane é fechada nessa topologia incompatível.
10. Lifecycle público com follow-up, contabilidade, reload e mudança de ramo funciona com pane externo; discovery verifica a nova descrição e skill.

## Limitações e operação

Não foram executados novos testes reais de mutação de layout nem chamadas de modelo. A geometria com panes externos e a recuperação têm cobertura simulada; a consulta real confirma apenas o contrato do snapshot e a aceitação do layout atual. Testes live anteriores do MVP não comprovam os novos cenários externos.

A CLI não oferece transação entre snapshot e mutação. Uma intervenção concorrente do usuário durante staging pode exigir reconciliação; não se afirma isolamento transacional. Não foram alterados panes, configurações pessoais, integrações ou servidor desta sessão.

Para usar o código atualizado numa sessão pi que já carregou esta extensão local, executar `/reload`. Os seis panes de referência continuam externos: removê-los ou reorganizá-los é uma decisão do usuário, não parte desta correção.
