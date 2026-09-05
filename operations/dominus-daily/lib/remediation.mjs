import { mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { redact } from "./control-plane.mjs";

const ALLOWED_ACTIONS = new Set(["refresh-monitoring", "reconcile-campaign"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const REMEDIATION_ENDPOINT = "https://ukmropshnxcqiagrahqk.supabase.co/functions/v1/dominus-remediate";

export function remediationKey(day, action, organizationId, campaignId) {
  return ["dominus-daily", day, action, organizationId, campaignId || "organization"].join(":");
}

function validateConfig(config) {
  if (config.endpoint !== REMEDIATION_ENDPOINT) throw new Error("Remediation endpoint does not match the pinned production endpoint");
  if (!Array.isArray(config.organizations) || config.organizations.length !== 2 || config.organizations.some(org => !UUID.test(org.id))) throw new Error("Exactly two valid tenant-scoped organizations are required");
}

async function persist(file, state) {
  state.updatedAt = new Date().toISOString();
  await writeFile(file, `${JSON.stringify(redact(state), null, 2)}\n`, { mode: 0o600 });
}

async function request(fetchImpl, endpoint, token, method, body) {
  const response = await fetchImpl(endpoint, { method, redirect: "error", signal: AbortSignal.timeout(45000), headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`dominus-remediate HTTP ${response.status}`);
  return payload;
}

export async function runRemediation({ day, stateDir, config, token, dryRun, fetchImpl = fetch, onReceipt = async () => {} }) {
  validateConfig(config);
  const directory = path.join(stateDir, "remediation");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const executionKind = dryRun ? "dry-run" : "production";
  const lockFile = path.join(directory, `${day}.${executionKind}.lock`);
  const stateFile = path.join(directory, `${day}.${executionKind}.json`);
  let lock;
  try { lock = await open(lockFile, "wx", 0o600); }
  catch (error) {
    if (error?.code === "EEXIST") throw new Error(`Remediation lock exists for ${day}; fail closed until an operator reconciles ${lockFile}`);
    throw error;
  }
  const state = JSON.parse(await readFile(stateFile, "utf8").catch(() => "{}"));
  state.day = day; state.dryRun = Boolean(dryRun); state.status = "running"; state.startedAt ||= new Date().toISOString(); state.actions ||= [];
  await lock.writeFile(`${process.pid} ${new Date().toISOString()}\n`);
  await persist(stateFile, state);
  try {
    const discovery = await request(fetchImpl, config.endpoint, token, "GET");
    if (discovery.enabled !== true && !dryRun) throw new Error("Backend remediation is not enabled");
    const advertised = new Set((discovery.actions || []).filter(action => ALLOWED_ACTIONS.has(action)));
    for (const required of ALLOWED_ACTIONS) if (!advertised.has(required)) throw new Error(`Backend does not advertise required action ${required}`);
    const allowedOrganizations = new Set(config.organizations.map(org => org.id));
    const candidates = (discovery.candidates || []).filter(candidate => allowedOrganizations.has(candidate.organizationId) && UUID.test(candidate.campaignId || "")).slice(0, config.maxCampaignCandidatesPerRun || 5);
    const planned = [
      { action: "refresh-monitoring", organizationId: config.organizations[0].id },
      ...candidates.map(candidate => ({ action: "reconcile-campaign", organizationId: candidate.organizationId, campaignId: candidate.campaignId })),
    ];
    for (const action of planned) {
      const idempotencyKey = remediationKey(day, action.action, action.organizationId, action.campaignId);
      const record = { ...action, idempotencyKey, dryRun: Boolean(dryRun), before: { discovered: true }, status: "started", startedAt: new Date().toISOString() };
      state.actions.push(record); await persist(stateFile, state);
      const result = await request(fetchImpl, config.endpoint, token, "POST", { ...action, idempotencyKey, dryRun: Boolean(dryRun) });
      record.result = result; await persist(stateFile, state);
      const accepted = dryRun ? result.status === "preview" : ["succeeded", "noop"].includes(result.status);
      if (!accepted) throw new Error(`dominus-remediate returned ${result.status || "unknown"}`);
      Object.assign(record, { status: "succeeded", completedAt: new Date().toISOString(), result }); await persist(stateFile, state);
      if (!dryRun) await onReceipt(redact({ day, action: action.action, organizationId: action.organizationId, campaignId: action.campaignId || null, status: result.status, receiptId: result.receiptId || null, idempotencyKey, before: record.before, result }));
    }
    state.status = "succeeded"; state.completedAt = new Date().toISOString(); state.summary = { refreshMonitoring: 1, campaignCandidates: candidates.length, failed: 0 };
    await persist(stateFile, state); await lock.close(); await unlink(lockFile);
    return state;
  } catch (error) {
    state.status = "partial"; state.completedAt = new Date().toISOString(); state.error = String(error.message || error).slice(0, 1000);
    const active = [...state.actions].reverse().find(action => action.status === "started");
    if (active) Object.assign(active, { status: "failed", completedAt: new Date().toISOString(), error: state.error });
    await persist(stateFile, state); await lock.close();
    if (!dryRun && active) await onReceipt(redact({ day, action: active.action, organizationId: active.organizationId, campaignId: active.campaignId || null, status: "failed", receiptId: active.result?.receiptId || null, idempotencyKey: active.idempotencyKey, before: active.before, result: active.result || { error: state.error } }));
    // Deliberately retain the lock. An ambiguous/partial run must be reconciled before retry.
    throw error;
  }
}
