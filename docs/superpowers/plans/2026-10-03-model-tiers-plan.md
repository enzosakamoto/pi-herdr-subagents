# Plano: delegação autônoma e modelos por tier

Especificação aprovada: [model tiers](../specs/2026-10-03-model-tiers-design.md).
A skill writing-plans não está disponível neste ambiente; este plano registra a sequência de implementação e validação diretamente. Execução local, sem subagentes ou chamadas de modelo reais.

## 1. Configuração e resolução

- Criar `src/config.ts` com tipos de tier/origem, leitura de arquivos próprios da extensão e validação estrita.
- Combinar configuração global/projeto por campo e resolver model explícito, tier/defaultTier ou herança.
- Testar precedência, arquivos ausentes/inválidos, tiers incompletos e formato provider/model-id.

## 2. Integração e persistência

- Acrescentar tier/model mutuamente exclusivos ao schema, com descrições semânticas dos argumentos.
- Capturar contexto principal antes de I/O; validar modelo exato no registro pi antes de reservar/abrir panes.
- Usar opções por chamada em Tasks.spawn, sem mutação de defaults compartilhados; proteger mudança de sessão durante a resolução.
- Expor/persistir model, tier e modelSource; manter leitura de registros antigos e comportamento de retomada.
- Testar chamadas concorrentes, argumentos CLI, snapshots, retorno, falhas sem panes e reload.

## 3. Orientações e documentação

- Atualizar descrição/guidelines da tool e descrição/corpo da skill para delegação autônoma dentro do pedido do usuário.
- Incluir exemplos econômicos low/medium/high, limites de escopo e ausência de escalada automática.
- Atualizar READMEs inglês/português com configuração, precedência, fallback e limitações.
- Verificar discovery/schema e consistência das orientações sem alegar avaliação comportamental de LLM.

## 4. Validação e revisão

- Executar testes determinísticos focados durante a implementação.
- Executar `npm test`, `npm run check` e `git diff --check`.
- Revisar o diff, validar isolamento dos testes em diretórios temporários e reportar limites: sem testes reais de modelos/Herdr nesta entrega.

## Resultado

Etapas 1–4 concluídas. A revisão identificou fuzzy matching na CLI do pi; o startup agora passa provider explícito e confirma o modelo efetivo via handshake antes de enviar trabalho, inclusive na retomada de startup bloqueado. Registros legados mantêm compatibilidade. A especificação registra esse refinamento.

Verificação local:

- `npm test`: 49 testes passaram, incluindo as 720 ordens de remoção de panes.
- `npm run check`: passou.
- `git diff --check`: passou.
- Testes novos usam somente diretórios temporários, fake Herdr e registros de modelos falsos; nenhum arquivo pessoal de configuração foi criado.
- Não executados: testes live com Herdr/modelos, avaliação comportamental de seleção de tier por LLM ou medições reais de custo/latência.
