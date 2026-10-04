# Plano: layout relativo ao principal com panes externos

Especificação aprovada: [principal-region-layout-design](../specs/2026-10-03-principal-region-layout-design.md).

A skill `writing-plans` não está disponível nesta instalação; este plano segue diretamente a especificação aprovada. Não usar a ferramenta de delegação atualmente carregada para testar esta mudança: ela ainda exige tab inicialmente com um único pane. Não modificar o layout de referência desta sessão.

## 1. Infraestrutura e testes de regressão

- Em `tests/fake.ts`, reportar retângulos de splits como o Herdr instalado, permitir área redimensionável e modelar consultas/restauração de foco.
- Em `tests/layout.test.ts`, adicionar configurações com panes externos em quatro direções e principal deslocado em ambos os eixos.
- Testar crescimento de 0–6 filhos, compactação até zero, geometria externa e identidade intactas; conservar as 720 ordens de remoção existentes.
- Testar foco externo/filho, janela redimensionada, staging próprio e intervenção externa que contamine a subárvore administrada.
- Confirmar que a versão antiga falha nos novos cenários de panes externos.

## 2. Validação de região em `src/layout.ts`

- Continuar validando identidade do principal/filhos, workspace, tab, staging e zoom.
- Validar retângulos/IDs recebidos. Não aceitar principal ou filho esperado ausente no snapshot.
- Para filhos na tab principal, calcular o bounding box dos panes próprios mais o principal e exigir que corresponda a um retângulo de split reportado. Verificar preenchimento da região, sem sobreposição ou pane externo intersectando-a.
- Essa verificação comprova uma subárvore dedicada na representação BSP reportada, sem depender do formato dos IDs de splits e sem congelar coordenadas entre operações.
- Se só o principal estiver na tab, aceitar panes externos fora dele. Dados insuficientes ou inconsistentes impedem mutações.
- Manter splits/moves locais e staging existentes; não usar resize global nem adotar terminais.

## 3. Integração e documentação

- Adicionar testes de lifecycle/restore com panes externos e cleanup com staging próprio em `tests/region-tasks.test.ts`, preservando os testes de tarefas existentes.
- Atualizar `src/extension.ts`, `README.md`, `README.pt-BR.md` e `skills/pi-herdr-subagents/SKILL.md` para explicar região local 50/50, pane externo permitido e não adoção.
- Verificar a descrição registrada da ferramenta nos testes de extensão e coerência documental.

## 4. Verificação final

- Executar testes focados durante implementação, depois `npm test`, `npm run check` e `git diff --check`.
- Revisar invariantes de isolamento, recuperação após staging parcial e ausência de comandos mutantes com alvo externo.
- Registrar resultados e limitações reais. Sem testes ao vivo ou chamadas de modelo nesta alteração; eles exigem autorização separada.
