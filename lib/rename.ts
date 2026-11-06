// Rename an agent from the roster (deviation 16). Live: POST {"type":"rename"} to the bridge the page is connected to,
// so the override is saved and survives later hooks and restarts (prd.md §7.4). Demo or no bridge: change the
// name on this screen only. The page learns the live stream URL from Office (setLiveUrlSource). The HQ_TOKEN typed in
// this tab (lib/token.ts) goes along as a header.

import type { Dept } from "./teams";
import { authHeader, readToken, tokenError } from "./token";

export interface RenamePatch {
  /** New name; null resets to the name the agent reports itself. */
  name?: string | null;
  role?: string | null;
  /** Team override; null = no team (back to the office desk). */
  team?: Dept | null;
}

/** `needToken`: the bridge uses HQ_TOKEN and the tab has none (or a wrong one); the card asks for it and retries. */
export type RenameResult = { ok: true; local: boolean } | { ok: false; error: string; needToken?: boolean };

/** The parts of the store this needs (kept small so tests can pass a stub). */
interface StoreLike {
  getState: () => { conn: { mode: string }; applyEvent: (raw: unknown) => void };
}

let liveUrlSource: () => string | null = () => null;
export function setLiveUrlSource(fn: () => string | null) {
  liveUrlSource = fn;
}

/** Event endpoint next to an SSE stream URL: /api/stream -> /api/event, /stream -> /event. WebSocket: unknown. */
export function eventUrlFor(streamUrl: string | null, base: string): string | null {
  if (!streamUrl) return null;
  let u: URL;
  try {
    u = new URL(streamUrl, base);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!/\/stream\/?$/.test(u.pathname)) return null;
  u.pathname = u.pathname.replace(/\/stream\/?$/, "/event");
  u.search = "";
  u.hash = "";
  return u.toString();
}

/** Event endpoint of the live bridge, or null in demo mode / without one (also used by lib/kick.ts). */
export function liveEventUrl(st: { conn: { mode: string } }): string | null {
  const base = typeof location === "undefined" ? "http://localhost/" : location.href;
  return st.conn.mode === "live" ? eventUrlFor(liveUrlSource(), base) : null;
}

export async function renameAgent(store: StoreLike, id: string, patch: RenamePatch): Promise<RenameResult> {
  const st = store.getState();
  const url = liveEventUrl(st);
  if (!url) {
    // Demo / no bridge: only this screen. A reset has nothing to go back to here, so it is skipped.
    const ev: Record<string, unknown> = { type: "agent_update", id };
    if (typeof patch.name === "string") ev.name = patch.name;
    if (typeof patch.role === "string") ev.role = patch.role;
    if (patch.team !== undefined) ev.team = patch.team ?? "office";
    st.applyEvent(ev);
    return { ok: true, local: true };
  }
  const token = readToken();
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...authHeader(token) }, body: JSON.stringify({ type: "rename", id, ...patch }) });
    if (res.ok) return { ok: true, local: false };
    if (res.status === 401) return { ok: false, error: tokenError(token), needToken: true };
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return { ok: false, error: body?.error || `Gagal (HTTP ${res.status})` };
  } catch (e) {
    return { ok: false, error: `Bridge tidak bisa dihubungi: ${(e as Error).message}` };
  }
}
