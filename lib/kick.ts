// Kick an agent out of the office (prd.md §7.10). Rules shared by the bridge (lib/bridge/hub.ts) and the client
// store, plus the roster action. Only an agent that is not working can be kicked: idle (Santai) or offline, for
// example a Hermes agent whose session was deleted. The office walks it to the Airlock (front tier) and launches it
// into space. It comes back by itself once it shows activity again; idle updates, token counts and logs keep it out.

import { STATUS, type Status } from "./events";
import { liveEventUrl } from "./rename";
import { authHeader, readToken, tokenError } from "./token";

export const canKick = (status: Status | null | undefined): boolean => status === "idle" || status === "offline";

/** Statuses that bring a kicked agent back: it starts a task or needs attention. */
const WAKE: readonly Status[] = ["thinking", "working", "waiting", "error"];

/**
 * Does an event from a kicked agent bring it back? A status that shows activity does, and so do findings and alerts
 * (security work in progress). Idle and offline updates, token counts, logs and task_done do not.
 */
export function wakesUp(type: string, status: Status | null): boolean {
  return type === "finding" || type === "alert" || (status != null && WAKE.includes(status));
}

/** The bridge forgets a kick after this long; later events then bring the agent back like a new one. */
export const KICK_TTL_MS = 7 * 24 * 3600 * 1000;

/** Answer when the agent may not be kicked (bridge 409, roster). */
export const kickRefusal = (name: string, status: Status) =>
  `${name} berstatus ${STATUS[status].label}. Hanya agen Santai atau Offline yang bisa dikeluarkan.`;

/** `needToken`: the bridge uses HQ_TOKEN and the tab has none (or a wrong one); the card asks for it and retries. */
export type KickResult = { ok: true; local: boolean } | { ok: false; error: string; needToken?: boolean };

/** The parts of the store this needs (kept small so tests can pass a stub). */
interface StoreLike {
  getState: () => {
    conn: { mode: string };
    agents: Map<string, { name: string; status: Status }>;
    applyEvent: (raw: unknown) => void;
  };
}

/**
 * Roster button. Live: POST {"type":"kick"} to the bridge the page watches, which checks the status again and
 * broadcasts the kick to every viewer; the HQ_TOKEN typed in this tab (lib/token.ts) goes along as a header.
 * Demo or no bridge: kick on this screen only.
 */
export async function kickAgent(store: StoreLike, id: string): Promise<KickResult> {
  const st = store.getState();
  const a = st.agents.get(id);
  if (!a) return { ok: false, error: "Agen ini sudah tidak ada di kantor." };
  if (!canKick(a.status)) return { ok: false, error: kickRefusal(a.name, a.status) };
  const url = liveEventUrl(st);
  if (!url) {
    st.applyEvent({ type: "remove", id, reason: "kick" });
    return { ok: true, local: true };
  }
  const token = readToken();
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...authHeader(token) }, body: JSON.stringify({ type: "kick", id }) });
    const body = (await res.json().catch(() => null)) as { kicked?: boolean; error?: string } | null;
    if (res.ok && body?.kicked) return { ok: true, local: false };
    if (res.ok) return { ok: false, error: "Bridge ini belum mendukung kick agen." };
    if (res.status === 401) return { ok: false, error: tokenError(token), needToken: true };
    return { ok: false, error: body?.error || `Gagal (HTTP ${res.status})` };
  } catch (e) {
    return { ok: false, error: `Bridge tidak bisa dihubungi: ${(e as Error).message}` };
  }
}
