# Thinking nullable por tier

## Decisões

Ampliar a configuração de modelos por tier para aceitar strings legadas e objetos com `model` obrigatório e `thinking` opcional/nullable. O usuário definiu explicitamente **null = off**. Thinking omitido herda o principal; não confundir omissão com null.

```json
{
  "defaultTier": "medium",
  "models": {
    "low": { "model": "provider/fast-model", "thinking": null },
    "medium": { "model": "provider/general-model", "thinking": "medium" },
    "high": { "model": "provider/deep-model", "thinking": "high" }
  }
}
```

## Resolução e compatibilidade

- Strings continuam válidas e herdam thinking do principal.
- Objetos aceitam apenas `model` e `thinking`; model deve ser um ID exato não vazio.
- `thinking: null` solicita off, assim como `thinking: "off"`.
- Omissão de thinking herda o principal; se ele não fornecer um nível, usar off.
- Níveis válidos do pi instalado: off, minimal, low, medium, high, xhigh e max. Valores desconhecidos, números, booleanos, arrays e objetos são erros de configuração antes da reserva/pane.
- Projeto substitui a entrada global inteira de cada tier, sem merge interno do objeto. Uma entrada de projeto omitindo thinking não herda o thinking global.
- Model explícito no spawn não usa a configuração de nenhum tier e mantém thinking herdado. Não adicionar parâmetro thinking ao spawn nesta entrega.
- Sem mapeamentos, preservar herança de modelo e thinking do principal. Não alterar precedência/defaultTier, exclusão model+tier ou tratamento de configurações inválidas.

## Arquitetura e observabilidade

- `src/config.ts`: tipo de entrada string/objeto, validação estrita e resolução do thinking solicitado a partir da entrada efetiva do tier.
- `src/extension.ts`: capturar thinking principal antes de I/O e passar o thinking resolvido a Tasks.spawn, sem defaults compartilhados mutáveis.
- `src/tasks.ts`: reutilizar snapshot/persistência existentes de thinking e expor `thinking` nos resultados de spawn/list/status/wait e follow-ups. Registros legados podem omitir o campo.
- O thinking exposto é o **solicitado no startup**, não uma promessa de nível efetivo. O pi/provider pode ajustar conforme o suporte do modelo, inclusive off em modelos que não permitem desligar raciocínio. Não implementar clamp próprio, troca automática de modelo ou novo bloqueio de handshake por thinking.
- Atualizar READMEs e skill com formato novo, semântica null/off/omissão, compatibilidade e exemplos econômicos. Tier e thinking continuam conceitos distintos.

## Testes e limites

- Configuração legada, todos os níveis válidos, null/off e herança por omissão.
- Validação de objetos, campos desconhecidos, model ausente/inválido, thinking inválido e caminho nos diagnósticos.
- Merge global/projeto por entrada completa, incluindo null sobre nível global e omissão em entrada local sobre nível global.
- Override model explícito e ausência de configuração mantêm herança.
- Spawns concorrentes, alterações de configuração e principal durante I/O, argumentos --thinking, persistência, retornos e reload.
- Rodar suíte determinística, typecheck e git diff --check; nenhum modelo real, arquivo de configuração pessoal ou teste live necessário.

## Fora de escopo

Thinking por chamada spawn, configuração global de thinking fora do tier, alterações de credenciais, seletor TUI, migração automática de arquivos, medição de custos e política própria de compatibilidade de modelos.
