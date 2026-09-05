import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseLocalCutoff, redact, shouldRunPhase, sourceStatus, stableHash, watchdogDecision, worstStatus } from "../lib/control-plane.mjs";

test("freshness rejects old and missing evidence", () => {
  const cutoff = Date.parse("2026-09-04T07:45:00Z");
  assert.equal(sourceStatus({ observedAt: "2026-09-04T07:44:59Z", minimumObservedAt: cutoff }), "stale");
  assert.equal(sourceStatus({ observedAt: "2026-09-04T07:45:00Z", minimumObservedAt: cutoff }), "fresh");
  assert.equal(sourceStatus({ minimumObservedAt: cutoff }), "unavailable");
  assert.equal(worstStatus(["fresh", "stale", "partial"]), "stale");
});

test("phase state is resumable and idempotent", () => {
  assert.equal(shouldRunPhase(undefined), true);
  assert.equal(shouldRunPhase({ status: "running" }), true);
  assert.equal(shouldRunPhase({ status: "succeeded" }), false);
  assert.equal(shouldRunPhase({ status: "simulated" }), false);
});

test("watchdog retries once and opens circuit afterwards", () => {
  const scheduledAt = Date.parse("2026-09-04T05:00:00Z");
  assert.deepEqual(watchdogDecision({ now: scheduledAt + 11 * 60000, scheduledAt, attempts: 0 }), { severity: "warning", recover: true });
  assert.deepEqual(watchdogDecision({ now: scheduledAt + 31 * 60000, scheduledAt, attempts: 1 }), { severity: "critical", recover: false });
});

test("redaction removes credentials recursively", () => {
  assert.deepEqual(redact({ token: "abc", nested: { message: "Bearer secret.value" } }), { token: "[REDACTED]", nested: { message: "Bearer [REDACTED]" } });
});

test("snapshot hash is deterministic and local cutoff uses Sao Paulo", () => {
  assert.equal(stableHash("same"), stableHash("same"));
  assert.equal(new Date(parseLocalCutoff("2026-09-04", "04:45")).toISOString(), "2026-09-04T07:45:00.000Z");
});

test("preflight policy requires WhatsApp connected, not only service running", async () => {
  const source = await readFile(new URL("../orchestrate.mjs", import.meta.url), "utf8");
  assert.match(source, /gateway\.service === "running" && gateway\.whatsapp === "connected"/);
});

test("dry-run does not create Paperclip issues", async () => {
  const source = await readFile(new URL("../orchestrate.mjs", import.meta.url), "utf8");
  assert.match(source, /const noWrite = options\.dryRun \|\| options\.simulated/);
  assert.match(source, /if \(!options\.dryRun\) await createIssueOnce\(\{ title: `\[\$\{day\}\] WATCHDOG/);
});

test("consolidation includes database, agent runs and connected gateway in global status", async () => {
  const source = await readFile(new URL("../orchestrate.mjs", import.meta.url), "utf8");
  assert.match(source, /database: databaseStatus/);
  assert.match(source, /agents: agentRunsOk \? "fresh" : "partial"/);
  assert.match(source, /evidence\.gateway\.whatsapp === "connected"/);
});

test("canary covers audit, consolidation and simulated send", async () => {
  const source = await readFile(new URL("../orchestrate.mjs", import.meta.url), "utf8");
  assert.match(source, /await audit\(day, file, state, options\); await consolidate\(day, file, state, options\); await send\(day, file, state, options\)/);
});

test("watchdog waits for the declared phase timeout before recovery", async () => {
  const source = await readFile(new URL("../orchestrate.mjs", import.meta.url), "utf8");
  assert.match(source, /Date\.parse\(record\.startedAt/);
  assert.match(source, /Number\.isFinite\(startedAt\) \? startedAt : scheduledAt/);
});

test("consolidation propagates advisors, migration drift and cron failures", async () => {
  const source = await readFile(new URL("../orchestrate.mjs", import.meta.url), "utf8");
  assert.match(source, /security: securityStatus/);
  assert.match(source, /migrations: migrationsStatus/);
  assert.match(source, /cronFailures !== 0/);
});

test("remediation uses only the governed Dominus endpoint", async () => {
  const source = await readFile(new URL("../orchestrate.mjs", import.meta.url), "utf8");
  assert.match(source, /runRemediation/);
  assert.match(source, /torriani-dominus-remediation/);
  assert.doesNotMatch(source, /torriani-whatsapp", \["restart"\]/);
});

test("sender acquires an exclusive lock before external delivery", async () => {
  const source = await readFile(new URL("../orchestrate.mjs", import.meta.url), "utf8");
  const sender = source.slice(source.indexOf("async function send("), source.indexOf("async function watchdog("));
  assert.match(source, /open\(sendLock, "wx", 0o600\)/);
  assert.ok(sender.indexOf('open(sendLock, "wx", 0o600)') < sender.indexOf('exec("torriani-whatsapp"'));
  assert.match(source, /retry blocked until receipt reconciliation/);
});

test("diagnose executes Supabase advisors and migration drift instead of only declaring checks", async () => {
  const source = await readFile(new URL("../orchestrate.mjs", import.meta.url), "utf8");
  assert.match(source, /"db", "advisors", "--linked", "--type", type/);
  assert.match(source, /"migration", "list", "--linked"/);
  assert.match(source, /backupRestore: \{ status: "unavailable"/);
});

test("endpoint pin is checked before Keychain credential access and receipts use createIssueOnce", async () => {
  const source = await readFile(new URL("../orchestrate.mjs", import.meta.url), "utf8");
  const phase = source.slice(source.indexOf("const remediate ="), source.indexOf("const reverify ="));
  assert.ok(phase.indexOf("CONFIG.remediation.endpoint !== REMEDIATION_ENDPOINT") < phase.indexOf('keychain("torriani-dominus-remediation")'));
  assert.match(phase, /onReceipt: async receipt => createIssueOnce/);
  assert.match(source, /"lib\/remediation\.mjs"/);
});
