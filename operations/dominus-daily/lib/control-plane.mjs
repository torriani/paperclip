import { createHash } from "node:crypto";

export function parseLocalCutoff(day, hhmm, timeZone = "America/Sao_Paulo") {
  const [hour, minute] = hhmm.split(":").map(Number);
  const wanted = `${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  const guess = new Date(`${wanted}:00-03:00`);
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(guess);
  const got = Object.fromEntries(parts.map(part => [part.type, part.value]));
  if (`${got.year}-${got.month}-${got.day}T${got.hour}:${got.minute}` !== wanted) throw new Error(`Unable to resolve local cutoff ${wanted} in ${timeZone}`);
  return guess.getTime();
}

export function sourceStatus({ observedAt, minimumObservedAt, available = true }) {
  if (!available || !observedAt) return "unavailable";
  return Date.parse(observedAt) >= minimumObservedAt ? "fresh" : "stale";
}

export function worstStatus(statuses) {
  const rank = { fresh: 0, partial: 1, stale: 2, unavailable: 3 };
  return statuses.reduce((worst, value) => (rank[value] > rank[worst] ? value : worst), "fresh");
}

export function stableHash(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

export function redact(value) {
  if (typeof value === "string") return value
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:eyJ|sbp_)[A-Za-z0-9._~-]{16,}\b/g, "[REDACTED]");
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [/token|secret|password|authorization|api[_-]?key/i.test(key) ? key : key, /token|secret|password|authorization|api[_-]?key/i.test(key) ? "[REDACTED]" : redact(item)]));
  return value;
}

export function shouldRunPhase(record) {
  return !record || !["succeeded", "simulated"].includes(record.status);
}

export function watchdogDecision({ now, scheduledAt, record, warningMinutes = 10, criticalMinutes = 30, attempts = 0, maxAttempts = 1 }) {
  if (record?.status === "succeeded" || now < scheduledAt) return { severity: "none", recover: false };
  const delayMinutes = (now - scheduledAt) / 60000;
  if (delayMinutes >= criticalMinutes) return { severity: "critical", recover: attempts < maxAttempts };
  if (delayMinutes >= warningMinutes) return { severity: "warning", recover: attempts < maxAttempts };
  return { severity: "none", recover: false };
}
