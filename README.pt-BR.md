# pi-herdr-subagents

[English](README.md)

Subagents assíncronos do pi, executados de forma visível em panes do Herdr.

> **Status: implementação planejada.** Este repositório contém a especificação, o plano de implementação e a skill de uso. Os exemplos abaixo definem a API pretendida; o código executável da extensão ainda não foi implementado.

## Funcionalidade

O pi principal delega tarefas independentes a outros processos pi sem aguardar sua conclusão. Cada filho recebe sua própria conversa e pane. O principal continua trabalhando, pode consultar progresso, esperar quando existir uma dependência ou cancelar explicitamente um filho.

Os resultados concluídos são salvos e entregues ao principal antes de fechar os panes correspondentes. Agentes bloqueados e resultados que não puderem ser coletados com segurança permanecem visíveis para intervenção.

### Organização visual

```text
┌──────────────────┬─────────┬─────────┐
│                  │ Filho 1 │ Filho 4 │
│                  ├─────────┼─────────┤
│    Principal     │ Filho 2 │ Filho 5 │
│                  ├─────────┼─────────┤
│                  │ Filho 3 │ Filho 6 │
└──────────────────┴─────────┴─────────┘
        50%            25%       25%
```

- Um a três filhos: uma coluna ocupando a metade direita.
- Quatro a seis filhos: duas colunas dividindo a metade direita.
- Até três filhos empilhados com alturas balanceadas por coluna; máximo de seis ativos.
- Operações em segundo plano preservam o foco do usuário.
- Após coletar, fechar panes próprios e compactar o layout.
- Sem filhos, o principal recupera o espaço.
- O MVP exige uma tab inicialmente contendo apenas o principal. Panes existentes do usuário não são adotados nem fechados.

## Requisitos

- pi com suporte a extensões TypeScript e Pi packages. O desenvolvimento considera pi 1.0.0.
- Herdr instalado e em execução; o desenvolvimento considera Herdr 0.9.3. As capacidades necessárias para o layout precisam ser verificadas durante a implementação.
- Executar o principal dentro de um pane gerenciado pelo Herdr (`HERDR_ENV=1`).
- Integração pi do Herdr instalada para o mesmo usuário/diretório de agente:

  ```bash
  herdr integration install pi
  ```

- Credenciais válidas para os modelos do pi. Os filhos herdam o modelo e o nível de raciocínio do principal.

Instalar o package não instala o Herdr, não concede confiança ao projeto e não atualiza automaticamente a integração do Herdr.

## Instalação

**Estes comandos passam a funcionar após implementar a extensão e o manifesto do package.** Nenhum repositório remoto foi criado ainda.

Checkout local:

```bash
pi install /caminho/absoluto/pi-herdr-subagents
```

Depois de publicar seu repositório Git, substitua `OWNER`:

```bash
pi install git:github.com/OWNER/pi-herdr-subagents
# Opcional: fixar uma tag publicada.
pi install git:github.com/OWNER/pi-herdr-subagents@v0.1.0
```

Execute `/reload` após instalar. Para experimentar sem adicionar o package às configurações pessoais:

```bash
pi -e /caminho/absoluto/pi-herdr-subagents
```

Gerencie packages com `pi list`, `pi update --extensions` e `pi remove <source>`.

## Como usar

Peça ao principal em linguagem natural:

> Investigue o fluxo de autenticação em um agente filho enquanto você trabalha na API. Não altere os mesmos arquivos. Incorpore os achados quando estiverem prontos.

Ou carregue explicitamente a skill distribuída no package:

```text
/skill:pi-herdr-subagents investigue o fluxo de autenticação em paralelo
```

### Ferramenta planejada: `herdr_subagent`

Os exemplos são argumentos de chamadas de ferramenta pelo modelo, não comandos de shell:

```json
{"action":"spawn","task":"Mapeie o fluxo de autenticação. Informe arquivos relevantes e riscos, sem alterar código.","instructions":"Você é um investigador de código focado."}
```

A delegação retorna um identificador imediatamente, antes de terminar o trabalho do modelo. Use o ID retornado, sem adivinhar IDs ou nomes de panes:

```json
{"action":"list"}
{"action":"status","taskId":"ID_RETORNADO"}
{"action":"wait","taskId":"ID_RETORNADO","timeoutMs":120000}
{"action":"cancel","taskId":"ID_RETORNADO"}
```

Resultados continuam consultáveis após fechar os panes. Mensagens de conclusão entram como follow-ups, sem interromper o trabalho atual.

## Limites operacionais

- O sétimo filho ativo é recusado; não há fila nem delegação recursiva.
- Interromper o turno do principal não cancela automaticamente filhos independentes.
- Timeout de espera não cancela um filho e não comprova que o prompt não foi entregue.
- Bloqueios de aprovação/pergunta exigem intervenção humana deliberada; nunca aprovar automaticamente.
- `idle`/`done` indicam disponibilidade, não necessariamente sucesso. `unknown` não é conclusão.
- Reload/shutdown libera observadores locais, não encerra filhos ativos. Retomadas reconciliam identidade antes de controlar panes.
- Fechar somente panes criados pela extensão cujos resultados correspondentes tenham sido persistidos com segurança.
- Panes isolam conversas, **não arquivos, credenciais ou permissões do sistema**. Defina responsabilidades de escrita sem sobreposição. Worktrees e sandbox não fazem parte deste MVP.

## Desenvolvimento

- [Especificação](docs/superpowers/specs/2026-10-03-herdr-subagents-design.md).
- [Plano de implementação](docs/superpowers/plans/2026-10-03-herdr-subagents-plan.md).
- [Skill de uso](skills/pi-herdr-subagents/SKILL.md).

A implementação adicionará `package.json`, manifesto `pi.extensions`/`pi.skills`, código e testes automatizados. As verificações planejadas são `npm test`, `npm run check`, carregamento do package e teste real de layout em ambiente isolado. Ainda não estão disponíveis nem foram aprovadas por execução.

Um ponto fundamental é preservar filhos ativos ao reorganizar o layout BSP do Herdr. Não recrie terminais em execução usando `layout.apply`; verifique operações suportadas de movimentação/divisão antes de prometer compactação arbitrária.
