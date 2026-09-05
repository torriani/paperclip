# Loop — Banco de dados

Execute diagnóstico e as remediações catalogadas já autorizadas para Torriani e Plenna.

1. Verifique disponibilidade, crescimento, queries lentas, índices candidatos, locks e falhas recentes quando as fontes existirem.
2. Para recuperar a telemetria e contatos presos antes do provider, execute `/Users/julianotorriani/claude/legacy/nexus/operations/dominus-daily/run-phase.sh remediate --day=AAAA-MM-DD`. Use o dia local do ciclo. O comando aplica exclusivamente `refresh-monitoring` e `reconcile-campaign` quando habilitado; chave dedicada no Keychain, limites e recibos no backend. Não peça novamente autorização para essas duas ações. SQL arbitrário, DDL, VACUUM e alterações de configuração ficam fora deste comando.
3. Não contorne RLS nem use chave de serviço para obter acesso adicional.
4. Se credencial ou fonte estiver ausente, registre `blocked` ou falha parcial; não invente métricas.
5. Registre receiptId, resultado, rollback e ações pendentes. `succeeded` de reconciliação não significa mensagem entregue; o envio permanece com o executor canônico do Dominus.
