# Delegação autônoma e seleção de modelos por tier

## Objetivo e decisões aprovadas

Permitir que o principal delegue trabalho independente sem exigir um pedido explícito de uso de subagentes. O usuário configura modelos por categoria; o principal escolhe a categoria conforme a tarefa, com orientação para evitar custos desnecessários.

Este documento atualiza a política de autorização e a seleção de modelos do MVP. As garantias de identidade, coleta, persistência, layout e limite de seis filhos permanecem inalteradas. Não implementar fila, recursão, worktrees ou repetição automática de tarefas.

## Delegação autônoma

A descrição da tool, suas prompt guidelines e a descrição/corpo da skill devem concordar:

- O principal pode delegar investigações, revisões e implementações independentes quando houver benefício real, sem pedido explícito ou autorização genérica prévia para delegação.
- Uma proibição ou restrição do usuário prevalece. Delegar não amplia o escopo da tarefa nem autoriza ações que exigiriam aprovação do usuário.
- Tarefas pequenas e sequenciais continuam no principal quando o custo de delegar não se justifica.
- O principal fornece objetivo, contexto necessário, dependências, resultado esperado e responsabilidade de escrita por arquivo. Filhos não recebem a conversa inteira.
- Conversas são separadas; arquivos, credenciais e permissões são compartilhados. Panes não são sandboxes.
- O principal continua trabalho independente e espera apenas numa dependência real. Resultados chegam automaticamente como follow-up.

A skill deve também ser consultada para gerenciar tarefas existentes; falar sobre a ferramenta ou editar sua implementação não é, por si só, motivo para criar filhos.

## Configuração persistente

Arquivos próprios da extensão, sem modificar o settings.json do pi:

- Global: `<getAgentDir()>/herdr-subagents.json`, normalmente `~/.pi/agent/herdr-subagents.json`.
- Projeto: `<cwd>/.pi/herdr-subagents.json`.

Exemplo ilustrativo; os valores devem ser substituídos por IDs reais configurados no pi:

```json
{
  "defaultTier": "medium",
  "models": {
    "low": "provider/modelo-rapido",
    "medium": "provider/modelo-geral",
    "high": "provider/modelo-complexo"
  }
}
```

A configuração do projeto sobrepõe a global por campo: as entradas de `models` são combinadas por tier, e `defaultTier` do projeto sobrepõe o global. O defaultTier implícito é `medium`. Não aceitar tiers desconhecidos, valores vazios, null, estruturas incorretas ou campos desconhecidos.

Ler a configuração para cada spawn. Ausência de arquivo é normal; JSON inválido, erro de leitura ou estrutura inválida geram erro acionável com o caminho, sem abrir pane. Não criar arquivos pessoais ou escolher modelos reais automaticamente. Não adicionar comando de configuração ou seletor TUI nesta entrega.

## Interface e resolução

Adicionar ao spawn:

- `tier?: "low" | "medium" | "high"`: escolha autônoma do principal entre categorias configuradas.
- `model?: string`: ID exato `provider/model-id`, somente para uma escolha específica solicitada pelo usuário; não para o principal adivinhar modelos/preços.

`model` e `tier` são mutuamente exclusivos. Documentar a exclusão no schema e validar antes da reserva.

Ordem de resolução:

1. Se `model` estiver presente, usar esse modelo exato.
2. Caso contrário, selecionar `tier` ou o defaultTier efetivo e consultar o mapeamento combinado.
3. Se não houver nenhum mapeamento de modelos, herdar o modelo atual do principal, preservando o comportamento antigo, inclusive quando um tier tiver sido indicado. Deixar essa herança explícita no retorno: indicar low, sozinho, não garante um modelo barato.
4. Se houver algum mapeamento, mas faltar o tier selecionado, retornar erro. Não herdar silenciosamente o principal nem substituir por outra categoria.

Arquivos de configuração inválidos não são ignorados mesmo com model explícito. Configuração vazia ou apenas com defaultTier, sem mapeamento de modelos, usa a herança descrita acima.

IDs são resolvidos exatamente, sem fuzzy matching, alias por dificuldade ou inferência de preços. Validar o formato e a existência do modelo de chat no registro do pi antes de reservar uma tarefa/abrir pane. IDs podem conter barras depois do primeiro separador de provider. Modelo explícito ou configurado permite spawn mesmo se o principal não tiver modelo selecionado; herança sem modelo selecionado é erro.

Disponibilidade no registro do principal não garante que credenciais ou providers registrados apenas em memória existam no processo filho. Documentar que o modelo/provider e suas credenciais precisam estar disponíveis aos filhos. Falhas reais de startup/autenticação seguem o fluxo de diagnóstico existente, sem troca automática de modelo.

## Orientação econômica e exemplos

Os tiers são perfis definidos pelo usuário, não garantias verificadas de preço, latência ou capacidade. Não consultar preços, usar outro classificador ou escolher IDs automaticamente.

| Tier | Exemplos | Limite de escopo |
|---|---|---|
| low | Executar uma suíte de testes já definida e relatar status, falhas e logs relevantes; localizar referências; listar arquivos; conferir uma alteração mecânica. | Coletar evidências e executar passos claros. Não transformar uma coleta em investigação profunda ou correção não solicitada. |
| medium | Mapear e entender o fluxo de um use case, da entrada à persistência; explicar dependências e regras de negócio; implementar uma alteração delimitada; investigar uma falha comum de teste. | Raciocínio entre arquivos com objetivo delimitado. Padrão para tarefas gerais e quando não houver sinais de alta complexidade. |
| high | Fazer code review substantivo de uma classe recém-implementada, buscando falhas de lógica, invariantes e casos extremos; analisar concorrência ou segurança; diagnosticar bugs difíceis; discutir decisões arquiteturais com impactos relevantes. | Exigir profundidade ou avaliar risco real. Não escolher high apenas porque o arquivo é grande, o trabalho é chamado de review ou o teste demora. |

Exemplos contrastantes que devem aparecer na skill:

- “Execute npm test e traga o resumo das falhas”: low, com o código estabilizado.
- “Descubra por que esses testes falham”: medium; high apenas se a tarefa já demandar diagnóstico complexo, como race conditions.
- “Mapeie e explique o fluxo de criação de pedido”: medium.
- “Revise a classe recém-implementada quanto a lógica, invariantes e casos extremos”: high.
- “Confira nomes, imports e formatação da classe”: low, ou executar diretamente no principal se for trivial.

A descrição da tool deve conter uma versão curta da regra de seleção e os três exemplos principais solicitados pelo usuário. A skill contém a tabela e os contrastes completos. A tarefa enviada ao filho explicita o escopo; um review high não autoriza implementação de correções automaticamente.

Escolher a menor categoria adequada. Não duplicar investigações sem propósito, usar todas as seis vagas por padrão ou reenviar trabalho incompleto/falho para um modelo mais caro automaticamente. O principal avalia resultados e decide o próximo passo dentro do pedido do usuário, sem mecanismo automático de escalada/retry.

## Raciocínio, concorrência e observabilidade

Tier escolhe modelo e não equivale a thinking level. Preservar a herança do nível de raciocínio do principal e o tratamento de suporte desse nível pelo pi; não adicionar uma configuração de raciocínio por tier nesta entrega.

Resolver modelo e categoria antes da reserva e passá-los como opções por chamada a Tasks.spawn, evitando alterar defaults compartilhados para representar overrides. Persistir a escolha na tarefa antes do startup. Mudanças de configuração, modelo do principal ou chamadas concorrentes não alteram tarefas já reservadas. Retomada usa a escolha persistida, não a configuração atual.

Expor em spawn/list/status/wait e nos follow-ups:

- `model`: modelo selecionado para o startup.
- `tier`: categoria selecionada, quando não houver model explícito.
- `modelSource`: `explicit`, `tier` ou `inherited`.

Os campos novos devem ser compatíveis com registros antigos onde estiverem ausentes. O modelo selecionado não substitui a atribuição existente de consumo real por provider/modelo.

## Estrutura da implementação

- Módulo focado em configuração: leitura, validação, merge e resolução, com caminhos injetáveis para testes.
- `src/extension.ts`: descrições do schema, resolução/validação de modelo via contexto pi e passagem de opções por chamada.
- `src/tasks.ts`: captura e persistência das escolhas na reserva, argumentos de startup e projeção em view.
- `skills/pi-herdr-subagents/SKILL.md`: descoberta para delegação autônoma, seleção econômica e exemplos.
- READMEs inglês e português: configuração, precedência, fallback, limitações e novos argumentos.

Melhorar também descrições de task, instructions, taskId e timeoutMs, sem mudar suas semânticas existentes.

## Verificação

Testes determinísticos, sem credenciais reais, arquivos pessoais ou panes reais:

1. Ausência de configuração e herança do modelo principal.
2. Escolha de cada tier e defaultTier implícito/explícito.
3. Merge global/projeto por tier e mudança de configuração entre spawns.
4. Override model exato, exclusão model+tier e IDs com barras.
5. Tier não mapeado, JSON/schema inválido, erros de leitura, modelo desconhecido e herança sem modelo principal, todos sem abrir pane.
6. Modelo configurado/expresso sem modelo selecionado no principal.
7. Spawns concorrentes com tiers/modelos diferentes; escolha congelada e restaurada após reload.
8. Campos de retorno e compatibilidade com registros legados.
9. Conteúdo da tool/skill consistente com delegação autônoma, exemplos low/medium/high e limites econômicos. Testes textuais não são prova de comportamento de um LLM.
10. Regressão da suíte existente, typecheck e git diff --check.

Execuções de modelo e avaliações comportamentais reais ficam fora da validação automática padrão para evitar gastos e alterações de ambiente não solicitados.
