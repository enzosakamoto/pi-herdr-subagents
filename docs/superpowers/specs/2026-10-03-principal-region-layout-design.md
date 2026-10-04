# Layout de subagentes relativo à região do principal

## Objetivo e aprovação

Permitir delegação quando a tab já contém panes do usuário. A região administrada pela extensão é a região do pane principal que invocou a ferramenta, não a área inteira da tab. O usuário confirmou a proporção local 50/50 e aprovou o desenho desta correção.

Esta especificação substitui a pré-condição de tab inicialmente com um único pane e a proporção relativa à tab descritas na seção Layout de `2026-10-03-herdr-subagents-design.md`. As demais regras de ciclo de vida, propriedade, coleta, capacidade e segurança permanecem válidas.

## Contrato de geometria

- Antes do primeiro filho, a região disponível é o retângulo atual do pane principal, inclusive seu deslocamento na tab.
- O primeiro filho divide somente esse pane para a direita, com ratio 0.5 e sem mudança deliberada de foco.
- Com filhos, principal e filhos próprios constituem uma subárvore BSP dedicada. Seu retângulo é a região administrada; panes externos são irmãos ou estão fora dessa subárvore.
- O principal ocupa a metade esquerda dessa região. Com 1–3 filhos, a metade direita contém uma coluna. Com 4–6, contém duas colunas de mesma largura, a primeira com três filhos e a segunda com os restantes. Cada coluna tem linhas de alturas equilibradas.
- As diferenças de uma célula por arredondamento são aceitáveis.
- Crescimento e compactação mantêm as proporções dentro da região administrada, mesmo que ela não comece em x=0 ou y=0.
- Ao encerrar todos os filhos, o principal volta a ocupar a região administrada inteira. Panes externos conservam suas posições, dimensões e terminais, salvo mudanças feitas pelo próprio usuário ou pelo terminal.
- As proporções seguem a geometria atual do Herdr. Não congelar dimensões absolutas do primeiro spawn; redimensionar a janela ou um ancestral externo não deve deixar medidas antigas sendo usadas.

Por exemplo, numa tab de 185 × 58, com um pane externo à esquerda de 32 × 58, a região restante pode ter 153 × 58. Se essa era a região do principal antes da delegação, principal e filhos dividem os 153, não os 185. Se houver outros panes externos à direita, eles também são excluídos: não considerar automaticamente todo o restante da tab como disponível.

## Abordagens e escolha

1. **Divisões locais do Herdr (escolhida):** direcionar splits e reinserções ao ID validado do principal ou de um filho próprio. Ratios relativos já levam em conta a região e o arredondamento atuais. Adaptar a validação para aceitar panes externos sem perder isolamento.
2. **Dimensões absolutas e resize:** exige compensar deslocamentos, arredondamento e mudanças de janela; adiciona mutações desnecessárias e risco de afetar divisões externas.
3. **Adotar panes existentes:** não usar; um shell aparentemente livre pode pertencer ao usuário. Não há transferência automática de propriedade.

Os seis panes montados manualmente na sessão atual são referência visual. Permanecem externos e não serão adotados, fechados ou reorganizados. Invocar a ferramenta nessa configuração dividiria o pane principal atual, não o conjunto desses panes de referência.

## Componentes e fluxo

### Validação em `src/layout.ts`

Substituir a rejeição global de panes não gerenciados por uma validação local:

- Confirmar identidade, tab e workspace do principal e identidade dos filhos, como hoje.
- Continuar exigindo tab sem zoom.
- Aceitar quaisquer panes externos quando não há filhos na tab principal.
- Quando há filhos próprios na tab principal, verificar pela topologia/geometria reportada que o principal e esses filhos ocupam uma subárvore dedicada, sem panes externos dentro dela. Filhos em staging continuam aceitos somente pelo vínculo próprio existente.
- Recusar uma topologia incompatível antes da reorganização: filho movido para outra região, pane externo inserido dentro da subárvore administrada ou identidade substituída. Explicar o problema e conservar os terminais; não tentar corrigir movendo panes externos.
- Dados de layout ausentes, malformados ou insuficientes para comprovar isolamento não autorizam uma mutação.

Um pane externo adicionado como irmão da região administrada é permitido. Um pane externo inserido dentro dessa região exige intervenção/reconciliação, pois remover e reinserir os filhos poderia mudar sua geometria. Não prometer isolamento contra uma alteração externa concorrente entre consulta e mutação: a CLI não oferece transação; detectar incompatibilidades observáveis e preservar evidências em caso de falha.

### Montagem e compactação

Manter o algoritmo BSP existente e staging autorizado no mesmo workspace:

1. Validar o estado antes da operação serializada.
2. Reservar/criar somente um novo pane próprio, ou mover somente filhos próprios vivos para staging.
3. Com os filhos fora da tab principal, sua subárvore colapsa no principal, que recupera a região local disponível.
4. Reinserir os mesmos terminais, com o primeiro filho à direita do principal a 0.5. Formar colunas e linhas apenas por splits de filhos próprios.
5. Persistir cada vínculo atualizado e restaurar foco de filho selecionado quando seguro, sem roubar foco de outro pane/tab/workspace.
6. Fechar somente um filho cuja propriedade e identidade foram comprovadas, respeitando a entrega/persistência de resultado existentes, e compactar sobreviventes dentro da mesma região.

Não mover o principal, não usar `layout.apply`, não reiniciar workers e não manipular splits de panes externos. Não remover a validação de identidade para simplesmente permitir qualquer topologia.

### Documentação e ferramenta

Atualizar a descrição da ferramenta em `src/extension.ts`, `README.md`, `README.pt-BR.md` e `skills/pi-herdr-subagents/SKILL.md` para remover a exigência de tab inicialmente com um único pane. Documentar proporções relativas ao principal, não à tab; não adoção de panes existentes; necessidade de região administrada isolada; permanência da restrição de zoom.

## Falhas e recuperação

Preservar o comportamento existente para timeout, startup bloqueado, coleta incerta, substituição de agente e `cleanup_pending`. Falha de layout não autoriza fechar ou adotar panes externos, repetir prompts, matar workers ou reiniciar Herdr. Filhos temporariamente em staging conservam propriedade e vínculos persistidos para reconciliação. Nenhuma alteração de modelos, tiers, thinking, limite de seis, filas ou recursão faz parte desta correção.

## Verificação e aceite

- Evoluir o fake de Herdr para representar splits e retângulos da subárvore, e dimensões de tab ajustáveis quando necessário.
- Exercitar panes externos à esquerda, à direita, acima e abaixo, além de layouts com múltiplos panes externos e principal com deslocamentos horizontal e vertical.
- Para cada configuração, crescer de zero a seis filhos e reduzir a zero. Cobrir ordens de fechamento e preservar o teste existente das 720 permutações.
- Comparar a geometria do principal/filhos à região local; verificar proporção 50/50, colunas 25/25 quando aplicável e alturas equilibradas, com tolerância de uma célula.
- Verificar que panes externos preservam IDs, terminais, retângulos e presença; nenhum comando mutante os tem como alvo. Ao fim, o principal recupera a região inicial e não sobra staging.
- Verificar foco de principal, filho e pane externo, incluindo preservação de foco externo durante reorganização.
- Redimensionar a área da tab entre operações para comprovar que não há dimensões absolutas obsoletas.
- Aceitar pane externo fora da subárvore; rejeitar antes de mutações uma subárvore contaminada por pane externo, filho deslocado, principal/filho substituído, layout inválido e tab zoomada.
- Verificar retomada/reconciliação com panes externos permitidos e com staging próprio, sem adoção de outros terminais.
- Executar `npm test`, `npm run check` e `git diff --check` após implementação.
- Testes reais não modificarão a sessão atual nem seus panes de referência. Testes que criem ou controlem panes reais em ambiente separado exigem autorização específica; testes simulados não precisam dela.

## Fora de escopo

Adoção dos panes de referência, proporções configuráveis, layout global da tab, controle de panes do usuário, redesign de staging, garantia transacional contra intervenções concorrentes, mudanças no protocolo Herdr e testes com chamadas reais de modelo sem autorização.
