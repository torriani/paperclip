# Dominus nightly control plane

Executor local governado pelo Paperclip para Torriani e Plenna. O arquivo
`config/control-plane.json` é a fonte versionada de agendas, checks, freshness e
limites do watchdog. Segredos ficam somente no Chaves do macOS.

## Ciclo

| Horário | Fase | Efeito |
|---|---|---|
| 23:30 | `baseline` | congela escopo/checks do ciclo |
| 00:30 | `diagnose` | coleta saúde e evidência read-only |
| 01:30 | `remediate` | chama o endpoint governado de remediação |
| 03:30 | `reverify` | faz segunda leitura independente |
| 04:45 | `preflight` | valida Paperclip, gateway, relógio e disco |
| 05:00 | `audit` | materializa auditoria e agentes no Paperclip |
| 07:00 | `consolidate` | relê fontes e cria snapshot com hash |
| 08:00 | `send` | regenera, valida o snapshot e envia uma vez |

O watchdog roda a cada cinco minutos. Estado retomável, evidências e snapshots
ficam em `~/.paperclip/instances/eliaquim/dominus-daily/`, com permissão privada.

O executor local nunca acessa o banco diretamente. Ele chama somente
`dominus-remediate`, autenticado pela entrada `torriani-dominus-remediation` do
Chaves do macOS. O backend aplica idempotência, cooldown e delega mensageria ao
`comm-campaign-auto-recovery` canônico. Por ciclo, o runner atualiza o monitoring
uma vez (Torriani é a organização proprietária do recibo) e reconcilia no máximo
cinco campanhas globais retornadas pelo backend. A reconciliação não envia ao
provider: o cron canônico retoma depois. Não há restart automático de WhatsApp.
Cada chamada ao backend expira em 45 segundos. Em produção, somente respostas
`succeeded` ou `noop` são sucesso; `preview` é aceito exclusivamente em dry-run.
Resposta vazia, desconhecida, `failed` ou `blocked` produz falha parcial.
Cada resultado produtivo (`succeeded`, `noop` ou falha) gera uma issue diária
idempotente no Paperclip com organização, campanha, estado anterior, resultado e
`receiptId`, sempre sanitizados. Se o Paperclip não aceitar o recibo, o ciclo
mantém o lock e exige reconciliação; dry-run nunca cria essas issues.

`remediation.enabled` permanece `false` até o QA. Com o kill switch desligado, a
execução produtiva fica `gated`. `--dry-run` e o canário ainda exercitam o backend,
mas todos os POSTs levam `dryRun: true`, portanto não produzem mutações.

## Operação

```bash
./install.sh                    # instala/recarrega todos os LaunchAgents
./run-phase.sh status           # mostra labels, WhatsApp, fases e último recibo
./run-phase.sh catalog          # sincroniza agendas no Paperclip
./run-phase.sh preflight        # preflight manual
./run-phase.sh watchdog --dry-run
./run-phase.sh canary --day=2099-01-01  # zero envio e zero mutação
./run-phase.sh consolidate --force
./run-phase.sh send --dry-run   # regenera snapshot, mas não envia
npm test
```

Para pausar, use `launchctl disable gui/$(id -u)/com.torriani.dominus-daily-FASE`.
Para retomar, use `launchctl enable` no mesmo label e rode `./install.sh`. A
reexecução é idempotente por dia/fase; `--force` existe para nova leitura de
evidência. A entrega mantém a chave diária `dominus-daily:AAAA-MM-DD`.

## Freshness e falhas

A consolidação nunca reaproveita a evidência das 05:00: relê todas as fontes. O
sender força outra consolidação imediatamente antes do envio e verifica o hash do
snapshot persistido. Evidência anterior às 04:45, fonte crítica indisponível ou
gateway parado produz `FALHA PARCIAL`; não é convertido em sucesso.

O canário usa um dia isolado, marca as fases como simuladas e exercita o sender
somente em dry-run, sem comunicação externa.
Mudanças de banco, índices, RLS, código ou credenciais continuam fora deste
executor e seguem story, QA e deploy próprios.

O estado separado da remediação fica em `dominus-daily/remediation/`, com recibos
e locks distintos `*.dry-run.*` e `*.production.*`. Assim, um preview interrompido
jamais impede uma execução produtiva. O lock é
criado com exclusividade (`wx`). Concorrência, processo interrompido ou falha
ambígua deixam o lock preservado e bloqueiam novas tentativas até reconciliação
operacional; o runner nunca remove um lock que pareça antigo automaticamente.

## Rollback

1. Desabilite os novos labels com `launchctl disable`.
2. Recarregue os três LaunchAgents anteriores (`audit`, `consolidate`, `send`).
3. Preserve o diretório de estado para auditoria; não apague recibos.
4. Não desative o `comm-campaign-auto-recovery`: ele pertence ao Dominus.
