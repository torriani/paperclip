import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { REMEDIATION_ENDPOINT, remediationKey, runRemediation } from "../lib/remediation.mjs";

const organizations = [
  { name: "Torriani", id: "0d29d163-872c-4d17-a42b-cdf188c76fb8" },
  { name: "Plenna", id: "252b024c-ea47-423b-92b1-844e0de00371" },
];
const config = { endpoint: REMEDIATION_ENDPOINT, organizations, maxCampaignCandidatesPerRun: 5 };
const campaigns = Array.from({ length: 7 }, (_, index) => ({ organizationId: organizations[index % 2].id, campaignId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}` }));

function response(body, status = 200) { return { ok: status >= 200 && status < 300, status, json: async () => body }; }
async function fixture(t) { const directory = await mkdtemp(path.join(tmpdir(), "dominus-remediation-")); t.after(() => rm(directory, { recursive: true, force: true })); return directory; }

test("dry-run reaches backend with dryRun=true and caps candidates at five", async t => {
  const stateDir = await fixture(t); const calls = [];
  const fetchImpl = async (_url, options) => {
    calls.push(options);
    if (options.method === "GET") return response({ enabled: true, candidates: campaigns, actions: ["refresh-monitoring", "reconcile-campaign"] });
    return response({ status: "preview", applied: false, dryRun: true });
  };
  const result = await runRemediation({ day: "2026-09-05", stateDir, config, token: "secret", dryRun: true, fetchImpl });
  const posts = calls.filter(call => call.method === "POST").map(call => JSON.parse(call.body));
  assert.equal(posts.filter(body => body.action === "refresh-monitoring").length, 1);
  assert.equal(posts.filter(body => body.action === "reconcile-campaign").length, 5);
  assert.ok(posts.every(body => body.dryRun === true));
  assert.equal(result.status, "succeeded");
  await assert.rejects(access(path.join(stateDir, "remediation", "2026-09-05.dry-run.lock")));
});

test("idempotency keys are stable and state records before and result", async t => {
  const stateDir = await fixture(t);
  const fetchImpl = async (_url, options) => options.method === "GET"
    ? response({ enabled: true, candidates: campaigns.slice(0, 1), actions: ["refresh-monitoring", "reconcile-campaign"] })
    : response({ status: "succeeded", applied: true, receipt: "ok" });
  await runRemediation({ day: "2026-09-05", stateDir, config, token: "secret", dryRun: false, fetchImpl });
  const state = JSON.parse(await readFile(path.join(stateDir, "remediation", "2026-09-05.production.json"), "utf8"));
  assert.equal(state.actions[0].idempotencyKey, remediationKey("2026-09-05", "refresh-monitoring", organizations[0].id));
  assert.deepEqual(state.actions[0].before, { discovered: true });
  assert.deepEqual(state.actions[0].result, { status: "succeeded", applied: true, receipt: "ok" });
});

test("concurrent runner and stale lock both fail closed", async t => {
  const stateDir = await fixture(t); let releaseGet;
  const waiting = new Promise(resolve => { releaseGet = resolve; });
  const first = runRemediation({ day: "2026-09-05", stateDir, config, token: "secret", dryRun: true, fetchImpl: async (_url, options) => { if (options.method === "GET") { await waiting; return response({ enabled: true, candidates: [], actions: ["refresh-monitoring", "reconcile-campaign"] }); } return response({ status: "preview", applied: false }); } });
  await new Promise(resolve => setTimeout(resolve, 20));
  await assert.rejects(runRemediation({ day: "2026-09-05", stateDir, config, token: "secret", dryRun: true, fetchImpl: async () => response({}) }), /fail closed/);
  releaseGet(); await first;
  await mkdir(path.join(stateDir, "remediation"), { recursive: true });
  await writeFile(path.join(stateDir, "remediation", "2026-09-06.dry-run.lock"), "stale\n");
  await assert.rejects(runRemediation({ day: "2026-09-06", stateDir, config, token: "secret", dryRun: true, fetchImpl: async () => response({}) }), /fail closed/);
});

test("backend failure persists partial state and retains lock", async t => {
  const stateDir = await fixture(t); let post = 0;
  const fetchImpl = async (_url, options) => {
    if (options.method === "GET") return response({ enabled: true, candidates: campaigns.slice(0, 1), actions: ["refresh-monitoring", "reconcile-campaign"] });
    post += 1; return post === 1 ? response({ status: "succeeded", applied: true }) : response({ error: "boom" }, 500);
  };
  await assert.rejects(runRemediation({ day: "2026-09-05", stateDir, config, token: "secret", dryRun: false, fetchImpl }), /500/);
  const state = JSON.parse(await readFile(path.join(stateDir, "remediation", "2026-09-05.production.json"), "utf8"));
  assert.equal(state.status, "partial");
  assert.equal(state.actions.at(-1).status, "failed");
  await access(path.join(stateDir, "remediation", "2026-09-05.production.lock"));
});

test("HTTP 200 failed or blocked result is partial and retains lock", async t => {
  for (const backendStatus of ["failed", "blocked"]) {
    const stateDir = await fixture(t);
    const fetchImpl = async (_url, options) => options.method === "GET"
      ? response({ enabled: true, candidates: [], actions: ["refresh-monitoring", "reconcile-campaign"] })
      : response({ status: backendStatus, replayed: false });
    await assert.rejects(runRemediation({ day: `2026-09-${backendStatus === "failed" ? "07" : "08"}`, stateDir, config, token: "secret", dryRun: false, fetchImpl }), new RegExp(backendStatus));
    const day = backendStatus === "failed" ? "2026-09-07" : "2026-09-08";
    const state = JSON.parse(await readFile(path.join(stateDir, "remediation", `${day}.production.json`), "utf8"));
    assert.equal(state.status, "partial");
    assert.equal(state.actions[0].status, "failed");
    await access(path.join(stateDir, "remediation", `${day}.production.lock`));
  }
});

test("kill switch off still permits backend preview in dry-run", async t => {
  const stateDir = await fixture(t); let posts = 0;
  const fetchImpl = async (_url, options) => {
    if (options.method === "GET") return response({ enabled: false, candidates: [], actions: ["refresh-monitoring", "reconcile-campaign"] });
    posts += 1; return response({ status: "preview", applied: false });
  };
  const result = await runRemediation({ day: "2026-09-09", stateDir, config, token: "secret", dryRun: true, fetchImpl });
  assert.equal(result.status, "succeeded");
  assert.equal(posts, 1);
});

test("empty and unknown statuses never become succeeded", async t => {
  for (const result of [{}, { status: "maybe" }, { status: "preview" }]) {
    const stateDir = await fixture(t);
    const fetchImpl = async (_url, options) => options.method === "GET"
      ? response({ enabled: true, candidates: [], actions: ["refresh-monitoring", "reconcile-campaign"] })
      : response(result);
    await assert.rejects(runRemediation({ day: "2026-09-10", stateDir, config, token: "secret", dryRun: false, fetchImpl }), /returned/);
  }
});

test("dry-run lock and receipt never block production", async t => {
  const stateDir = await fixture(t); const directory = path.join(stateDir, "remediation");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "2026-09-11.dry-run.lock"), "ambiguous preview\n");
  const fetchImpl = async (_url, options) => options.method === "GET"
    ? response({ enabled: true, candidates: [], actions: ["refresh-monitoring", "reconcile-campaign"] })
    : response({ status: "noop", replayed: false });
  const result = await runRemediation({ day: "2026-09-11", stateDir, config, token: "secret", dryRun: false, fetchImpl });
  assert.equal(result.status, "succeeded");
  await access(path.join(directory, "2026-09-11.dry-run.lock"));
  await access(path.join(directory, "2026-09-11.production.json"));
});

test("every request carries a 45 second abort signal", async t => {
  const stateDir = await fixture(t); const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, signal: options.signal, redirect: options.redirect });
    return options.method === "GET"
      ? response({ enabled: false, candidates: [], actions: ["refresh-monitoring", "reconcile-campaign"] })
      : response({ status: "preview" });
  };
  await runRemediation({ day: "2026-09-12", stateDir, config, token: "secret", dryRun: true, fetchImpl });
  assert.equal(requests.length, 2);
  assert.ok(requests.every(item => item.url === REMEDIATION_ENDPOINT && item.redirect === "error"));
  assert.ok(requests.every(item => item.signal instanceof AbortSignal && item.signal.aborted === false));
  const source = await readFile(new URL("../lib/remediation.mjs", import.meta.url), "utf8");
  assert.match(source, /AbortSignal\.timeout\(45000\)/);
});

test("tampered endpoint fails before fetch", async t => {
  const stateDir = await fixture(t); let fetched = false;
  await assert.rejects(runRemediation({ day: "2026-09-13", stateDir, config: { ...config, endpoint: "https://evil.example/remediate" }, token: "must-not-be-sent", dryRun: true, fetchImpl: async () => { fetched = true; return response({}); } }), /pinned/);
  assert.equal(fetched, false);
});

test("production receipts cover succeeded noop and failed while dry-run emits none", async t => {
  const receipts = [];
  for (const [day, backendStatus] of [["2026-09-14", "succeeded"], ["2026-09-15", "noop"], ["2026-09-16", "failed"]]) {
    const stateDir = await fixture(t);
    const fetchImpl = async (_url, options) => options.method === "GET"
      ? response({ enabled: true, candidates: [], actions: ["refresh-monitoring", "reconcile-campaign"] })
      : response({ status: backendStatus, receiptId: `receipt-${backendStatus}` });
    const promise = runRemediation({ day, stateDir, config, token: "secret", dryRun: false, fetchImpl, onReceipt: async receipt => receipts.push(receipt) });
    if (backendStatus === "failed") await assert.rejects(promise, /failed/); else await promise;
  }
  const dryState = await fixture(t);
  await runRemediation({ day: "2026-09-17", stateDir: dryState, config, token: "secret", dryRun: true, fetchImpl: async (_url, options) => options.method === "GET" ? response({ enabled: false, candidates: [], actions: ["refresh-monitoring", "reconcile-campaign"] }) : response({ status: "preview", receiptId: "preview" }), onReceipt: async receipt => receipts.push(receipt) });
  assert.deepEqual(receipts.map(item => item.status), ["succeeded", "noop", "failed"]);
  assert.ok(receipts.every(item => item.receiptId?.startsWith("receipt-")));
});

test("Paperclip receipt failure is fail-closed and replay key stays deduplicable", async t => {
  const stateDir = await fixture(t);
  const fetchImpl = async (_url, options) => options.method === "GET"
    ? response({ enabled: true, candidates: [], actions: ["refresh-monitoring", "reconcile-campaign"] })
    : response({ status: "noop", receiptId: "receipt-1", replayed: true });
  await assert.rejects(runRemediation({ day: "2026-09-18", stateDir, config, token: "secret", dryRun: false, fetchImpl, onReceipt: async () => { throw new Error("Paperclip unavailable"); } }), /Paperclip unavailable/);
  await access(path.join(stateDir, "remediation", "2026-09-18.production.lock"));
  const state = JSON.parse(await readFile(path.join(stateDir, "remediation", "2026-09-18.production.json"), "utf8"));
  assert.equal(state.status, "partial");
  assert.equal(state.actions[0].idempotencyKey, remediationKey("2026-09-18", "refresh-monitoring", organizations[0].id));
});
