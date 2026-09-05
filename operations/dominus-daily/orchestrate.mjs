#!/usr/bin/env node
import { execFile } from "node:child_process";
import { chmod, mkdir, open, readFile, statfs, unlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { parseLocalCutoff, redact, shouldRunPhase, sourceStatus, stableHash, watchdogDecision, worstStatus } from "./lib/control-plane.mjs";
import { REMEDIATION_ENDPOINT, runRemediation } from "./lib/remediation.mjs";

const exec = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname);
const CONFIG = JSON.parse(await readFile(path.join(ROOT, "config/control-plane.json"), "utf8"));
const API = process.env.PAPERCLIP_API || "http://127.0.0.1:3100/api";
const COMPANY_ID = "946be02e-778f-4c80-b92f-93d9d31a4b84";
const GROUP_ID = "120363427477687918@g.us";
const AGENTS = { eliaquim: "b6378e59-cd69-4c99-a326-636f05498608", health: "8de39b7d-cc77-4eec-8d0c-b31c64a6e780", security: "515ec472-087c-48c5-a854-050dc71d1d4d", database: "5a76662a-9cb5-4939-b287-784245b0d9c4" };
const STATE_DIR = path.join(process.env.HOME, ".paperclip", "instances", "eliaquim", "dominus-daily");

function localDay(offset = 0) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: CONFIG.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + offset * 86400000));
}
function shiftDay(day, offset) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: CONFIG.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.parse(`${day}T12:00:00-03:00`) + offset * 86400000));
}
function defaultRunDay() {
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: CONFIG.timezone, hour: "2-digit", hourCycle: "h23" }).format(new Date()));
  return hour >= 12 ? shiftDay(localDay(), 1) : localDay();
}
async function keychain(service) { return (await exec("/usr/bin/security", ["find-generic-password", "-a", process.env.USER, "-s", service, "-w"])).stdout.trim(); }
async function api(route, options = {}) {
  const response = await fetch(`${API}${route}`, { ...options, headers: { Authorization: `Bearer ${await keychain("torriani-paperclip-dominus-daily")}`, "Content-Type": "application/json", ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Paperclip ${response.status}: ${JSON.stringify(redact(body))}`);
  return body;
}
async function loadState(day) {
  await mkdir(STATE_DIR, { recursive: true, mode: 0o700 }); await chmod(STATE_DIR, 0o700);
  const file = path.join(STATE_DIR, `${day}.json`);
  return { file, state: JSON.parse(await readFile(file, "utf8").catch(() => "{}")) };
}
async function saveState(file, state) {
  Object.assign(state, { schemaVersion: 2, configVersion: CONFIG.version, updatedAt: new Date().toISOString() });
  await writeFile(file, `${JSON.stringify(redact(state), null, 2)}\n`, { mode: 0o600 });
}
async function allIssues() { return api(`/companies/${COMPANY_ID}/issues`); }
async function createIssueOnce(input) {
  return (await allIssues()).find(issue => issue.title === input.title) || api(`/companies/${COMPANY_ID}/issues`, { method: "POST", body: JSON.stringify(input) });
}
async function paperclipHealth() {
  return fetch(`${API}/health`).then(async response => ({ ...(await response.json()), observedAt: new Date().toISOString() })).catch(error => ({ status: "unavailable", observedAt: new Date().toISOString(), error: String(error) }));
}
async function gatewayStatus() {
  try { return { ...JSON.parse((await exec("torriani-whatsapp", ["channel", "status"], { timeout: 15000 })).stdout), observedAt: new Date().toISOString() }; }
  catch (error) { return { service: "unavailable", whatsapp: "unknown", observedAt: new Date().toISOString(), error: String(error.message || error) }; }
}
async function dominusAudit(day) {
  try {
    const response = await fetch(`https://ukmropshnxcqiagrahqk.supabase.co/functions/v1/dominus-daily-audit?day=${encodeURIComponent(day)}`, { headers: { Authorization: `Bearer ${await keychain("torriani-dominus-daily-audit")}` } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(redact(body))}`);
    return { ...body, observedAt: body.generatedAt || new Date().toISOString() };
  } catch (error) { return { contract: "dominus-daily-audit-v1", day, status: "unavailable", observedAt: new Date().toISOString(), error: String(error.message || error) }; }
}
async function databaseAdvisors() {
  const result = {};
  for (const type of ["security", "performance"]) {
    try {
      const { stdout } = await exec("supabase", ["db", "advisors", "--linked", "--type", type, "--output", "json"], { cwd: CONFIG.dominusRepo, timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
      const findings = JSON.parse(stdout);
      result[type] = {
        status: "ok",
        total: findings.length,
        byLevel: findings.reduce((acc, item) => { const level = String(item.level || "UNKNOWN"); acc[level] = (acc[level] || 0) + 1; return acc; }, {}),
        findingKeys: findings.slice(0, 100).map(item => String(item.cache_key || item.name || "unknown")),
      };
    } catch (error) { result[type] = { status: "unavailable", error: String(error.message || error).slice(0, 800) }; }
  }
  return redact(result);
}
async function migrationDrift() {
  try {
    const { stdout } = await exec("supabase", ["migration", "list", "--linked"], { cwd: CONFIG.dominusRepo, timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
    const rows = stdout.split("\n").filter(line => /^\s*\d*\s*\|\s*\d*/.test(line));
    const mismatches = rows.filter(line => { const [local, remote] = line.split("|").map(value => value.trim()); return !local || !remote || local !== remote; });
    return { status: mismatches.length ? "drift" : "ok", mismatchCount: mismatches.length };
  } catch (error) { return { status: "unavailable", error: String(error.message || error).slice(0, 800) }; }
}
async function executorIntegrity() {
  const files = ["orchestrate.mjs", "lib/control-plane.mjs", "lib/remediation.mjs", "config/control-plane.json"];
  const contents = await Promise.all(files.map(file => readFile(path.join(ROOT, file), "utf8")));
  return { status: "ok", files, sha256: stableHash(contents.join("\n--FILE--\n")) };
}
async function phaseStatus(day, state) {
  const gateway = await gatewayStatus();
  const labels = [...CONFIG.phases.map(item => `com.torriani.dominus-daily-${item.id}`), "com.torriani.dominus-daily-watchdog"];
  const launchAgents = {};
  for (const label of labels) {
    try {
      const { stdout } = await exec("launchctl", ["print", `gui/${process.getuid()}/${label}`], { timeout: 5000, maxBuffer: 512 * 1024 });
      launchAgents[label] = { loaded: true, running: /\bstate = running\b/.test(stdout) };
    } catch { launchAgents[label] = { loaded: false, running: false }; }
  }
  console.log(JSON.stringify({ day, configVersion: CONFIG.version, gateway, launchAgents, phases: state.phases || {}, delivery: state.delivery || null }, null, 2));
}
async function tracked(day, file, state, phase, operation, options = {}) {
  state.phases ||= {};
  if (!options.force && !shouldRunPhase(state.phases[phase])) return console.log(`${phase} already ${state.phases[phase].status} for ${day}`);
  const attempt = (state.phases[phase]?.attempt || 0) + 1;
  state.phases[phase] = { status: "running", attempt, startedAt: new Date().toISOString(), configVersion: CONFIG.version }; await saveState(file, state);
  try {
    const evidence = await operation();
    state.phases[phase] = { ...state.phases[phase], status: options.simulated ? "simulated" : "succeeded", completedAt: new Date().toISOString(), evidence: redact(evidence) };
    await saveState(file, state); console.log(JSON.stringify(state.phases[phase], null, 2)); return evidence;
  } catch (error) {
    state.phases[phase] = { ...state.phases[phase], status: "failed", completedAt: new Date().toISOString(), error: String(error.message || error).slice(0, 1200) }; await saveState(file, state); throw error;
  }
}

async function phaseCatalog() {
  let created = 0;
  for (const phase of CONFIG.phases) {
    const title = `[CATÁLOGO] Dominus nightly: ${phase.id}`;
    const existed = (await allIssues()).some(issue => issue.title === title);
    await createIssueOnce({ title, description: `Agenda: ${String(phase.hour).padStart(2, "0")}:${String(phase.minute).padStart(2, "0")} ${CONFIG.timezone}\nTimeout: ${phase.timeoutMinutes} min\nConfig: ${CONFIG.version}\nFonte oficial: Paperclip.`, status: "backlog", priority: ["audit", "consolidate", "send"].includes(phase.id) ? "high" : "medium" });
    if (!existed) created++;
  }
  console.log(`catalog created=${created} total=${CONFIG.phases.length}`);
}
const baseline = (day, file, state, options) => tracked(day, file, state, "baseline", async () => ({ dataDay: shiftDay(day, -1), checks: CONFIG.checks }), options);
const diagnose = (day, file, state, options) => tracked(day, file, state, "diagnose", async () => {
  const [paperclip, gateway, dominus, advisors, migrations, integrity] = await Promise.all([paperclipHealth(), gatewayStatus(), dominusAudit(shiftDay(day, -1)), databaseAdvisors(), migrationDrift(), executorIntegrity()]);
  return { paperclip, gateway, dominus, advisors, migrations, integrity, backupRestore: { status: "unavailable", reason: "requires_management_api_or_isolated_restore_drill" } };
}, options);
const remediate = (day, file, state, options) => tracked(day, file, state, "remediate", async () => {
  const dryRun = Boolean(options.dryRun || options.simulated);
  if (!CONFIG.remediation.enabled && !dryRun) return { status: "gated", remediationEnabled: false, reason: CONFIG.remediation.reason };
  try {
    if (CONFIG.remediation.endpoint !== REMEDIATION_ENDPOINT) throw new Error("Remediation endpoint pin mismatch; credential access blocked");
    return await runRemediation({
      day, stateDir: STATE_DIR, config: CONFIG.remediation, token: await keychain("torriani-dominus-remediation"), dryRun,
      onReceipt: async receipt => createIssueOnce({
        title: `[${day}] Remediações Dominus · ${receipt.action} · ${receipt.organizationId} · ${receipt.campaignId || "organization"}`,
        description: JSON.stringify(redact({ action: receipt.action, organizationId: receipt.organizationId, campaignId: receipt.campaignId, status: receipt.status, receiptId: receipt.receiptId, before: receipt.before, result: receipt.result }), null, 2),
        status: ["succeeded", "noop"].includes(receipt.status) ? "done" : "blocked",
        priority: receipt.status === "failed" ? "critical" : "high",
        assigneeAgentId: AGENTS.eliaquim,
      }),
    });
  } catch (error) {
    if (!dryRun) await createIssueOnce({ title: `[${day}] REMEDIAÇÃO PARCIAL`, description: `Executor local falhou e reteve o lock para reconciliação manual. Nenhuma saúde foi presumida. Erro: ${String(error.message || error).slice(0, 800)}`, status: "blocked", priority: "critical", assigneeAgentId: AGENTS.eliaquim });
    throw error;
  }
}, options);
const reverify = (day, file, state, options) => tracked(day, file, state, "reverify", async () => ({ dominus: await dominusAudit(shiftDay(day, -1)), independentRead: true }), options);
const preflight = (day, file, state, options) => tracked(day, file, state, "preflight", async () => {
  const disk = await statfs(STATE_DIR); const paperclip = await paperclipHealth(); const gateway = await gatewayStatus();
  return { status: paperclip.status === "ok" && gateway.service === "running" && gateway.whatsapp === "connected" && disk.bavail * disk.bsize > 1e9 ? "ok" : "partial", paperclip, gateway, timezone: CONFIG.timezone, clock: new Date().toISOString(), diskFreeBytes: disk.bavail * disk.bsize };
}, options);

async function audit(day, file, state, options = {}) {
  return tracked(day, file, state, "audit", async () => {
    const evidence = { paperclip: await paperclipHealth(), gateway: await gatewayStatus(), dominus: await dominusAudit(shiftDay(day, -1)) };
    const noWrite = options.dryRun || options.simulated;
    const parent = noWrite ? { id: null } : await createIssueOnce({ title: `[${day}] Pulso diário Dominus: auditoria`, description: `Auditoria governada de Torriani e Plenna. Config ${CONFIG.version}. Mensageria recuperada exclusivamente por comm-campaign-auto-recovery.`, status: "in_progress", priority: "high", assigneeAgentId: AGENTS.eliaquim });
    const children = [];
    if (!noWrite) for (const [name, agent] of [["Saúde operacional", AGENTS.health], ["Segurança", AGENTS.security], ["Banco e mensageria", AGENTS.database]]) children.push(await createIssueOnce({ parentId: parent.id, title: `[${day}] ${name}`, description: `Checks em config/control-plane.json (${CONFIG.version}). Sem bypass de RLS ou mutação direta.`, status: "todo", priority: "high", assigneeAgentId: agent }));
    state.audit = { parentId: parent.id, childIds: children.map(item => item.id), evidence }; return state.audit;
  }, options);
}

async function consolidate(day, file, state, options = {}) {
  return tracked(day, file, state, "consolidate", async () => {
    if (!state.audit?.parentId) await audit(day, file, state, options);
    const [dominus, paperclip, gateway, advisors, migrations] = await Promise.all([dominusAudit(shiftDay(day, -1)), paperclipHealth(), gatewayStatus(), databaseAdvisors(), migrationDrift()]);
    const evidence = { dominus, paperclip, gateway, advisors, migrations };
    const cutoff = parseLocalCutoff(day, CONFIG.freshness.notBeforeLocal, CONFIG.timezone);
    const ids = new Set(state.audit.childIds || []); const found = ids.size ? (await allIssues()).filter(issue => ids.has(issue.id)) : [];
    const children = await Promise.all(found.map(async issue => ({ identifier: issue.identifier, runStatus: (await api(`/issues/${issue.id}/runs`))[0]?.status || "not_started" })));
    const agentRunsOk = children.length === 3 && children.every(item => item.runStatus === "succeeded");
    const organizationsOk = Array.isArray(evidence.dominus.organizations) && evidence.dominus.organizations.length === CONFIG.organizations.length && evidence.dominus.organizations.every(org => org.status === "ok");
    const db = evidence.dominus.database;
    const cronFailures = Number(db?.operations?.cronFailures24h ?? -1);
    const databaseAnomaly = cronFailures !== 0 || Number(db?.operations?.blockedLocks || 0) > 0 || Number(db?.operations?.longTransactions || 0) > 0 || db?.operations?.monitoringSnapshotStale === true;
    const databaseStatus = db?.status === "ok" && !databaseAnomaly ? sourceStatus({ observedAt: evidence.dominus.observedAt, minimumObservedAt: cutoff }) : db ? "partial" : "unavailable";
    const securityErrors = Number(evidence.advisors.security?.byLevel?.ERROR || 0);
    const securityStatus = evidence.advisors.security?.status === "ok" && securityErrors === 0 ? "fresh" : evidence.advisors.security ? "partial" : "unavailable";
    const migrationsStatus = evidence.migrations.status === "ok" ? "fresh" : evidence.migrations.status === "drift" ? "partial" : "unavailable";
    const remediationEvidence = state.phases?.remediate?.evidence;
    const remediationStatus = state.phases?.remediate?.status === "succeeded" && remediationEvidence?.status === "succeeded" ? "fresh" : "partial";
    const statuses = {
      dominus: organizationsOk ? sourceStatus({ observedAt: evidence.dominus.observedAt, minimumObservedAt: cutoff, available: evidence.dominus.status !== "unavailable" }) : "partial",
      database: databaseStatus,
      security: securityStatus,
      migrations: migrationsStatus,
      remediation: remediationStatus,
      paperclip: sourceStatus({ observedAt: evidence.paperclip.observedAt, minimumObservedAt: cutoff, available: evidence.paperclip.status === "ok" }),
      gateway: sourceStatus({ observedAt: evidence.gateway.observedAt, minimumObservedAt: cutoff, available: evidence.gateway.service === "running" && evidence.gateway.whatsapp === "connected" }),
      agents: agentRunsOk ? "fresh" : "partial",
    };
    const globalStatus = worstStatus(Object.values(statuses));
    const orgs = evidence.dominus.organizations || [];
    const lines = orgs.length ? orgs.map(org => org.campaignContacts ? `${org.name}: enviadas ${org.campaignContacts.sent}, na fila ${org.campaignContacts.queued}, não enviadas ${org.campaignContacts.notSent}, falhas ${org.campaignContacts.failed}` : `${org.name}: indisponível`) : ["Mensageria: indisponível"];
    const report = [`RELATÓRIO DIÁRIO DOMINUS · ${shiftDay(day, -1)}`, "", `STATUS: ${globalStatus === "fresh" ? "EVIDÊNCIA ATUAL" : "FALHA PARCIAL"}`, `EVIDÊNCIAS: dominus=${statuses.dominus}; banco=${statuses.database}; segurança=${statuses.security}; migrations=${statuses.migrations}; remediação=${statuses.remediation}; paperclip=${statuses.paperclip}; gateway=${statuses.gateway}`, `GERADO EM: ${new Date().toISOString()}`, `CONFIG: ${CONFIG.version}`, "", ...lines, "", `BANCO: cron falhas 24h=${cronFailures}; locks=${db?.operations?.blockedLocks ?? "indisponível"}; transações longas=${db?.operations?.longTransactions ?? "indisponível"}`, `SEGURANÇA: errors=${securityErrors}; warnings=${evidence.advisors.security?.byLevel?.WARN ?? "indisponível"}`, `PERFORMANCE ADVISOR: warnings=${evidence.advisors.performance?.byLevel?.WARN ?? "indisponível"}`, `MIGRATIONS: divergências=${evidence.migrations.mismatchCount ?? "indisponível"}`, "", `PAPERCLIP: ${children.map(item => `${item.identifier}=${item.runStatus}`).join(", ") || "tarefas não localizadas"}`].join("\n");
    const snapshot = redact({ generatedAt: new Date().toISOString(), dataDay: shiftDay(day, -1), configVersion: CONFIG.version, statuses, globalStatus, evidence, report });
    snapshot.hash = stableHash(snapshot);
    const snapshotFile = path.join(STATE_DIR, `${day}-snapshot.json`); const reportFile = path.join(STATE_DIR, `${day}-report.txt`);
    await writeFile(snapshotFile, `${JSON.stringify(redact(snapshot), null, 2)}\n`, { mode: 0o600 }); await writeFile(reportFile, `${report}\n`, { mode: 0o600 });
    state.consolidation = { completedAt: snapshot.generatedAt, reportFile, snapshotFile, snapshotHash: snapshot.hash, statuses, globalStatus };
    if (!options.dryRun && !options.simulated) await createIssueOnce({ parentId: state.audit.parentId, title: `[${day}] Consolidação das 07h`, description: `${report}\n\nSnapshot SHA-256: ${snapshot.hash}`, status: globalStatus === "fresh" ? "done" : "blocked", priority: "high", assigneeAgentId: AGENTS.eliaquim });
    return state.consolidation;
  }, { ...options, force: options.force || !state.consolidation });
}

async function send(day, file, state, options = {}) {
  if (state.delivery?.sentAt) return console.log(`delivery already sent for ${day}: ${state.delivery.messageId}`);
  await consolidate(day, file, state, { ...options, force: true });
  const snapshot = JSON.parse(await readFile(state.consolidation.snapshotFile, "utf8"));
  const suppliedHash = snapshot.hash; delete snapshot.hash;
  if (stableHash(snapshot) !== suppliedHash || suppliedHash !== state.consolidation.snapshotHash) throw new Error("Snapshot integrity check failed; delivery blocked");
  if (options.dryRun || options.simulated) return console.log(`dry-run: no external send; snapshot=${suppliedHash}; status=${snapshot.globalStatus}`);
  const sendLock = path.join(STATE_DIR, `${day}.send.lock`);
  let lock;
  try { lock = await open(sendLock, "wx", 0o600); await lock.writeFile(`${process.pid} ${new Date().toISOString()} ${suppliedHash}\n`); }
  catch (error) {
    if (error?.code === "EEXIST") throw new Error(`Delivery lock exists for ${day}; retry blocked until receipt reconciliation`);
    throw error;
  }
  let result;
  try { result = JSON.parse((await exec("torriani-whatsapp", ["send", "--group", GROUP_ID, "--file", state.consolidation.reportFile, "--idempotency-key", `dominus-daily:${day}`], { timeout: 30000 })).stdout); }
  catch (error) { await lock.close(); await createIssueOnce({ parentId: state.audit.parentId, title: `[${day}] FALHA na entrega das 08h`, description: `Resultado ambíguo; retry bloqueado pelo lock ${sendLock}. Reconciliar recibo antes de liberar. Snapshot ${suppliedHash}. Erro: ${String(error.message || error).slice(0, 800)}`, status: "blocked", priority: "critical", assigneeAgentId: AGENTS.eliaquim }); throw error; }
  state.delivery = { sentAt: new Date().toISOString(), messageId: result.messageId || result.id || null, snapshotHash: suppliedHash, result: redact(result) }; await saveState(file, state);
  await lock.close(); await unlink(sendLock);
  await createIssueOnce({ parentId: state.audit.parentId, title: `[${day}] Entrega das 08h`, description: `Recibo: ${state.delivery.messageId || "aceito sem ID"}. Snapshot: ${suppliedHash}.`, status: "done", priority: "high" });
}

async function watchdog(day, file, state, options = {}) {
  state.watchdog ||= { recoveryAttempts: {} }; const incidents = []; const recoveries = [];
  for (const phase of CONFIG.phases) {
    const attempts = state.watchdog.recoveryAttempts[phase.id] || 0;
    const record = phase.id === "send" && state.delivery?.sentAt ? { status: "succeeded" } : state.phases?.[phase.id];
    const scheduledAt = parseLocalCutoff(day, `${String(phase.hour).padStart(2, "0")}:${String(phase.minute).padStart(2, "0")}`, CONFIG.timezone);
    const startedAt = record?.status === "running" ? Date.parse(record.startedAt || "") : NaN;
    const recoveryEligibleAt = record?.status === "running" ? (Number.isFinite(startedAt) ? startedAt : scheduledAt) + phase.timeoutMinutes * 60000 : scheduledAt;
    const decision = watchdogDecision({ now: Date.now(), scheduledAt: recoveryEligibleAt, record, warningMinutes: CONFIG.watchdog.warningDelayMinutes, criticalMinutes: CONFIG.watchdog.criticalDelayMinutes, attempts, maxAttempts: CONFIG.watchdog.maxRecoveryAttempts });
    if (decision.severity === "none") continue;
    incidents.push({ phase: phase.id, ...decision });
    if (decision.recover && !options.dryRun) { state.watchdog.recoveryAttempts[phase.id] = attempts + 1; recoveries.push(phase.id); }
    if (!options.dryRun) await createIssueOnce({ title: `[${day}] WATCHDOG ${phase.id} ${decision.severity.toUpperCase()}`, description: `Fase perdida/sem evidência. recovery=${decision.recover}; attempt=${attempts}; config=${CONFIG.version}.`, status: decision.recover ? "in_progress" : "blocked", priority: decision.severity });
  }
  state.watchdog.lastHeartbeatAt = new Date().toISOString(); state.watchdog.lastResult = incidents; await saveState(file, state);
  const recoveryResults = [];
  for (const phase of recoveries) {
    try {
      await exec(process.execPath, [path.join(ROOT, "orchestrate.mjs"), phase, `--day=${day}`], { timeout: (CONFIG.phases.find(item => item.id === phase)?.timeoutMinutes || 15) * 60000 });
      recoveryResults.push({ phase, status: "resumed" });
    } catch (error) { recoveryResults.push({ phase, status: "failed", error: String(error.message || error).slice(0, 500) }); }
  }
  console.log(JSON.stringify({ heartbeat: state.watchdog.lastHeartbeatAt, incidents, recoveryResults }, null, 2));
}
async function canary(day, file, state) {
  const options = { force: true, simulated: true, dryRun: true };
  await baseline(day, file, state, options); await diagnose(day, file, state, options); await remediate(day, file, state, options); await reverify(day, file, state, options); await preflight(day, file, state, options);
  await audit(day, file, state, options); await consolidate(day, file, state, options); await send(day, file, state, options);
  console.log("canary completed: no external communication and no direct mutation");
}

async function main() {
  const phase = process.argv[2]; const day = process.argv.find(arg => arg.startsWith("--day="))?.slice(6) || defaultRunDay();
  const options = { dryRun: process.argv.includes("--dry-run"), simulated: process.argv.includes("--canary"), force: process.argv.includes("--force") };
  const { file, state } = await loadState(day);
  const handlers = { status: () => phaseStatus(day, state), catalog: phaseCatalog, baseline: () => baseline(day, file, state, options), diagnose: () => diagnose(day, file, state, options), remediate: () => remediate(day, file, state, options), reverify: () => reverify(day, file, state, options), preflight: () => preflight(day, file, state, options), audit: () => audit(day, file, state, options), consolidate: () => consolidate(day, file, state, options), send: () => send(day, file, state, options), watchdog: () => watchdog(day, file, state, options), canary: () => canary(day, file, state) };
  if (!handlers[phase]) throw new Error("Uso: orchestrate.mjs <status|catalog|baseline|diagnose|remediate|reverify|preflight|audit|consolidate|send|watchdog|canary> [--day=AAAA-MM-DD] [--dry-run] [--force]");
  return handlers[phase]();
}
main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
