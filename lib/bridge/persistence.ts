// Restart snapshots for the single-process bridge. Runtime data stays outside the checkout and .next.
// Only Node built-ins; a temp file + rename keeps the previous snapshot intact if writing fails.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { redact } from "./redact";
import type { BridgeEvent } from "./hub";
import type { Identity } from "./overrides";

export interface Removal {
  at: number;
  mark: number;
}

export interface BridgeSnapshot {
  version: 1;
  agents: BridgeEvent[];
  recent: BridgeEvent[];
  lastSeen: [string, number][];
  sourceIdentity: [string, Identity][];
  removals: [string, Removal][];
}

/** HQ_STATE_FILE=0 disables persistence. Explicit paths also allow isolated restart tests. */
export function stateFile(): string | null {
  if (process.env.NEXT_PHASE === "phase-production-build" || process.env.HQ_STATIC === "1") return null;
  const configured = process.env.HQ_STATE_FILE;
  if (configured === "0") return null;
  if (configured) return path.resolve(configured);
  if (process.env.NODE_ENV === "test") return null;
  return path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "agent-hq", "state.json");
}

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Redact persisted text too: raw /event producers do not necessarily sanitize their own messages. */
function cleanRecord(value: Record<string, unknown>): BridgeEvent {
  const out: BridgeEvent = {};
  for (const [key, v] of Object.entries(value)) {
    if (typeof v === "string") out[key] = key === "id" ? v : redact(v);
    else if (v === null || typeof v === "boolean" || finite(v)) out[key] = v;
  }
  return out;
}

export function loadSnapshot(file: string | null): BridgeSnapshot | null {
  if (!file) return null;
  try {
    // The path is runtime configuration, not an input to Next.js output tracing.
    const raw: unknown = JSON.parse(fs.readFileSync(/*turbopackIgnore: true*/ file, "utf8"));
    if (!record(raw) || raw.version !== 1 || !Array.isArray(raw.agents) || !Array.isArray(raw.recent)
      || !Array.isArray(raw.lastSeen) || !Array.isArray(raw.sourceIdentity) || !Array.isArray(raw.removals)) {
      throw new Error("invalid snapshot");
    }
    const agents = raw.agents.filter((a) => record(a) && typeof a.id === "string" && a.id).map(cleanRecord);
    const ids = new Set(agents.map((a) => a.id));
    const pair = (p: unknown): p is [string, unknown] => Array.isArray(p) && p.length === 2 && typeof p[0] === "string" && ids.has(p[0]);
    return {
      version: 1,
      agents,
      recent: raw.recent.filter((ev) => record(ev) && ["log", "finding", "alert"].includes(String(ev.type))).slice(-80).map(cleanRecord),
      lastSeen: raw.lastSeen.filter((p): p is [string, number] => pair(p) && finite(p[1])),
      sourceIdentity: raw.sourceIdentity.filter((p): p is [string, Identity] => pair(p) && record(p[1])).map(([id, v]) => [id, cleanRecord(v) as Identity]),
      removals: raw.removals.filter((p): p is [string, Removal] => pair(p) && record(p[1]) && finite(p[1].at) && finite(p[1].mark)),
    };
  } catch (e) {
    // Do not log parsed text (it may contain secrets). Missing data on first start is normal.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") console.warn("[hq] snapshot agen tidak bisa dibaca; mulai dengan kantor kosong");
    return null;
  }
}

export function saveSnapshot(file: string, snapshot: BridgeSnapshot): void {
  const tmp = `${file}.${process.pid}.tmp`;
  const safe = {
    ...snapshot,
    agents: snapshot.agents.map(cleanRecord),
    recent: snapshot.recent.slice(-80).map(cleanRecord),
    sourceIdentity: snapshot.sourceIdentity.map(([id, identity]) => [id, cleanRecord(identity)]),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(tmp, JSON.stringify(safe) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
