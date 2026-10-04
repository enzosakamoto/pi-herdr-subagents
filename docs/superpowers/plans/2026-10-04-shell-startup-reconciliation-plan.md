# Plano do ajuste aprovado

1. Estender Fake com snapshots de foreground por pane e criar regressões dos dois erros reproduzidos, antes de alterar produção.
2. Separar identidade/prova de foreground em Layout; manter as esperas limitadas e todos os guards de ocupante. Aproximar a intenção de launch da chamada remota.
3. Reconciliar reservas desaparecidas em status/restore por leitura de pane.get, sem cleanup físico nem adoção. Preservar participantes de journal pendente.
4. Rodar testes focados, suíte completa, TypeScript e diff check. Atualizar verificação com cobertura e limites. Não manipular panes reais enquanto o controlador carregado ainda é o anterior.

Writing-plans não está instalado localmente; este plano cobre o escopo pequeno aprovado. Nenhuma delegação durante implementação: o controlador carregado ainda apresenta os defeitos investigados.
