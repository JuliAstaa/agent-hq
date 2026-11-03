// Agent identity overrides (rename): name / role / team pinned per agent id.
// Applied to every published agent_update and task_done (so the next hook cannot overwrite them) and persisted
// to a JSON file: env HQ_NAMES_FILE, default agent-hq-names.json in the project root (process.cwd()).
// Node built-ins only (prd.md §14).

import fs from "node:fs";
import path from "node:path";

export const IDENTITY_FIELDS = ["name", "role", "team"] as const;
export type IdentityField = (typeof IDENTITY_FIELDS)[number];
export type Identity = Partial<Record<IdentityField, string>>;
export interface Override extends Identity {
  updatedAt?: string;
}

/** Longest accepted value for name / role / team. */
export const MAX_IDENTITY_LEN = 60;

export const namesFile = (): string => process.env.HQ_NAMES_FILE || path.join(process.cwd(), "agent-hq-names.json");

const hasIdentity = (o: Override | undefined): o is Override => !!o && IDENTITY_FIELDS.some((f) => o[f] !== undefined);

/** Read the overrides file. Missing file -> empty. Unreadable file -> empty plus a warning (never throws). */
export function loadOverrides(file = namesFile()): Map<string, Override> {
  const out = new Map<string, Override>();
  let raw: string;
  try {
    // Local data file chosen at runtime: keep it out of Turbopack output tracing (it would trace the whole project).
    raw = fs.readFileSync(/*turbopackIgnore: true*/ file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`[hq] tidak bisa membaca ${file}:`, (e as Error).message);
    return out;
  }
  try {
    const parsed = JSON.parse(raw) as { agents?: Record<string, Override> };
    for (const [id, o] of Object.entries(parsed.agents ?? {})) {
      if (!o || typeof o !== "object") continue;
      const clean: Override = {};
      for (const f of IDENTITY_FIELDS) if (typeof o[f] === "string" && o[f]) clean[f] = o[f];
      if (typeof o.updatedAt === "string") clean.updatedAt = o.updatedAt;
      if (hasIdentity(clean)) out.set(id, clean);
    }
  } catch (e) {
    console.warn(`[hq] ${file} bukan JSON yang valid, override nama diabaikan:`, (e as Error).message);
  }
  return out;
}

/** Write all overrides atomically (temp file + rename) so a crash never leaves half a file. */
export function saveOverrides(map: Map<string, Override>, file = namesFile()): void {
  const agents: Record<string, Override> = {};
  for (const [id, o] of [...map].sort(([a], [b]) => a.localeCompare(b))) if (hasIdentity(o)) agents[id] = o;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, agents }, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

/**
 * Apply one rename request to an existing override. For each identity field present in `req`:
 * a non-empty string sets it, null or "" clears it. Returns the new override (or null when nothing is left),
 * the fields that changed, or an error message for invalid input.
 */
export function mergeOverride(
  current: Override | undefined,
  req: Record<string, unknown>,
): { next: Override | null; cleared: IdentityField[]; set: IdentityField[] } | { error: string } {
  const next: Override = { ...(current ?? {}) };
  const cleared: IdentityField[] = [], set: IdentityField[] = [];
  let touched = false;
  for (const f of IDENTITY_FIELDS) {
    if (!(f in req)) continue;
    touched = true;
    const v = req[f];
    if (v === null || v === "" || (typeof v === "string" && !v.trim())) {
      if (next[f] !== undefined) cleared.push(f);
      delete next[f];
    } else if (typeof v === "string") {
      const s = v.replace(/\s+/g, " ").trim();
      if (s.length > MAX_IDENTITY_LEN) return { error: `${f} terlalu panjang (maks ${MAX_IDENTITY_LEN} karakter)` };
      next[f] = s;
      set.push(f);
    } else {
      return { error: `${f} harus string, null, atau ""` };
    }
  }
  if (!touched) return { error: 'rename butuh minimal satu field: "name", "team", atau "role"' };
  next.updatedAt = new Date().toISOString();
  return { next: hasIdentity(next) ? next : null, cleared, set };
}
