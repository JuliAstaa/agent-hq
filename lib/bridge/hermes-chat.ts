// Hermes chat bridge (docs/hermes.md "Chat Hermes"). The office's chat panel talks to the Hermes API server
// (gateway platform `api_server`, http://127.0.0.1:8642) only through this module:
// - the Agent HQ server opens the session stream itself and keeps reading it, because Hermes stops a turn when its
//   stream client disconnects and the panel may be closed or reloaded mid-turn;
// - the API key (HQ_HERMES_API_KEY = Hermes' API_SERVER_KEY) never leaves the server;
// - the panel gets the conversation over GET /api/hermes/stream and acts with POST /api/hermes, both behind
//   chatGuard() because a message to Hermes can run anything Hermes' tools can run.
// The conversation is shown with redact() applied (like logs); Hermes itself receives the message as typed.
//
// One session is open at a time. The Riwayat list switches between the API server's sessions; they all share
// Hermes' memory, skills and session_search, so a new session still knows what earlier ones taught Hermes.
// Each session has an office character with the id the Hermes hook gives it (so hook and chat move the same
// character), and may have a model of its own (kept in HQ_HERMES_CHAT_FILE).

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sseFrames } from "../sse";
import { DEPTS, normalizeTeam } from "../teams";
import { authorized } from "./auth";
import { crossSite } from "./cron";
import { hub, publish, renameAgent } from "./hub";
import { MAX_IDENTITY_LEN, saveOverrides } from "./overrides";
import { redact, trunc } from "./redact";
import {
  APPROVAL_CHOICES, CHAT_TEAMS, CHAT_TITLE_PREFIX, CHAT_TOPIC_PREFIX, DEFAULT_CHAT_AGENT, MAX_CHAT_ITEMS,
  MAX_CHAT_MESSAGE, MAX_CHAT_TEXT, MAX_CHAT_TOPIC, appendCapped, displayTitle, emptyChatView, modelKey, upsertItem,
  type ApprovalChoice, type ChatAgentInput, type ChatEvent, type ChatItem, type ChatSession, type ChatState,
  type ChatTeam, type ChatView, type ModelChoice, type ModelOptions, type ModelProvider,
} from "../hermes-chat";

/** Sessions this panel creates are titled "Agent HQ <date time>"; the newest one is resumed after a restart. */
export const TITLE_PREFIX = CHAT_TITLE_PREFIX;
export const DEFAULT_HERMES_API_URL = "http://127.0.0.1:8642";
/** A stop that Hermes did not settle within this time drops the stream (Hermes then interrupts the turn). */
export const STOP_FALLBACK_MS = 20_000;
const CALL_TIMEOUT_MS = 15_000;
/** Hermes may fetch provider catalogs to build the model list. */
const MODELS_TIMEOUT_MS = 30_000;
const MODELS_TTL_MS = 60_000;
/** Model choices kept in HQ_HERMES_CHAT_FILE (newest first). */
const MAX_PREFS = 500;
/** Longest automatic topic (the first message) in a title. */
const AUTO_TOPIC = 48;

type Env = Record<string, string | undefined>;
export type Reply = { status: number; body: Record<string, unknown> };
const fail = (status: number, error: string): Reply => ({ status, body: { ok: false, error } });
const ok = (extra: Record<string, unknown> = {}): Reply => ({ status: 200, body: { ok: true, ...extra } });

export function chatConfig(env: Env = process.env): { enabled: boolean; url: string; key: string } {
  const key = (env.HQ_HERMES_API_KEY || "").trim();
  const url = (env.HQ_HERMES_API_URL || DEFAULT_HERMES_API_URL).trim().replace(/\/+$/, "");
  let valid = false;
  try {
    valid = /^https?:$/.test(new URL(url).protocol);
  } catch {}
  return { enabled: !!key && valid, url, key };
}

/* ---------------- request guard ---------------- */

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/;

/** Host name the request was sent to ("localhost" for http://localhost:9787/...). */
export function hostName(req: Request): string {
  try {
    return new URL(`http://${req.headers.get("host") || ""}`).hostname.toLowerCase();
  } catch {
    return "";
  }
}

const json = (status: number, body: unknown) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/**
 * Refuse a chat request unless it comes from the office itself: same origin (no other website), sent to localhost
 * (an SSH tunnel) or to a host listed in HQ_ALLOWED_HOSTS (then HQ_TOKEN is required), with the token when HQ_TOKEN
 * is set. The host check also stops DNS rebinding (a page on evil.example resolving to 127.0.0.1).
 */
export function chatGuard(req: Request, post: boolean, env: Env = process.env): Response | null {
  if (!chatConfig(env).enabled) return json(404, { ok: false, error: "Chat Hermes belum diaktifkan (HQ_HERMES_API_KEY kosong)" });
  if (crossSite(req)) return json(403, { ok: false, error: "Ditolak: permintaan dari situs lain" });
  const host = hostName(req);
  if (!LOOPBACK.test(host)) {
    const allowed = (env.HQ_ALLOWED_HOSTS || "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
    if (!allowed.includes(host)) {
      return json(403, { ok: false, error: `Ditolak: host "${trunc(host, 60)}" tidak diizinkan. Buka lewat localhost (tunnel SSH) atau tambahkan ke HQ_ALLOWED_HOSTS.` });
    }
    if (!env.HQ_TOKEN) return json(403, { ok: false, error: "Chat Hermes lewat alamat selain localhost butuh HQ_TOKEN" });
  }
  if (!authorized(req, env.HQ_TOKEN || "")) return json(401, { ok: false, error: "token salah" });
  if (post && !/^application\/json\b/i.test(req.headers.get("content-type") || "")) {
    return json(415, { ok: false, error: "content-type harus application/json" });
  }
  return null;
}

/* ---------------- small helpers ---------------- */

const enc = encodeURIComponent;
const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** A trimmed id-like string without control characters, "" when missing, too long, or unsafe. */
const cleanId = (v: unknown, max = 200): string => {
  const s = typeof v === "string" ? v.trim() : "";
  return s && s.length <= max && !/\p{Cc}/u.test(s) ? s : "";
};

/** A model as the panel or the file gives it: {"provider"?, "model"}. Null when it is not a usable one. */
export function parseModel(v: unknown): ModelChoice | null {
  if (!isObj(v)) return null;
  const model = cleanId(v.model);
  const provider = v.provider == null || v.provider === "" ? "" : cleanId(v.provider, 80);
  if (!model || (v.provider != null && v.provider !== "" && !provider)) return null;
  return { provider, model };
}
const MODEL_ERR = 'model harus {"provider", "model"} atau null';

/** Epoch seconds or ms (number or string) -> ms; null when unknown. */
const toMs = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? (Number.isFinite(Number(v)) ? Number(v) : Date.parse(v)) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n < 1e12 ? n * 1000 : n);
};

/* ---------------- state ---------------- */

interface SessionPrefs {
  model: ModelChoice;
  updatedAt: string;
}

interface ChatHub {
  view: ChatView;
  /** Hermes run id of the turn in progress ("" before run.started). */
  runId: string;
  /** Pending approval item id -> Hermes request id ("" when the event had none). */
  approvals: Map<string, string>;
  abort: AbortController | null;
  subs: Set<(ev: ChatEvent) => void>;
  seq: number;
  /** Assistant item that text deltas append to; closed by a tool call or an approval. */
  openText: string | null;
  outcome: "" | "completed" | "failed" | "cancelled";
  /** Look-up of the newest "Agent HQ" session in Hermes, once per server start (retried if Hermes was down). */
  resumed: Promise<void> | null;
  stopTimer: ReturnType<typeof setTimeout> | null;
  /** Bumped by resetChat(): a stream from before the reset must not touch the new state. */
  epoch: number;
  /** The title is still the automatic date one: the first message renames the session after its topic. */
  autoTitle: boolean;
  /** Model per Hermes session id, persisted in `prefsFile`. */
  prefs: Map<string, SessionPrefs>;
  prefsFile: string;
  /** Last model list from Hermes (building it can take a while). */
  models: { at: number; value: ModelOptions } | null;
}

/** File with the model picked per session: env HQ_HERMES_CHAT_FILE, default agent-hq-hermes.json in the project root. */
export const chatPrefsFile = (): string => process.env.HQ_HERMES_CHAT_FILE || path.join(process.cwd(), "agent-hq-hermes.json");

/** Read the model choices. Missing file -> none. A broken file -> none plus a warning (never throws). */
function loadPrefs(file: string): Map<string, SessionPrefs> {
  const out = new Map<string, SessionPrefs>();
  let raw: string;
  try {
    // Local data file chosen at runtime: keep it out of Turbopack output tracing (it would trace the whole project).
    raw = fs.readFileSync(/*turbopackIgnore: true*/ file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`[hq] tidak bisa membaca ${file}:`, (e as Error).message);
    return out;
  }
  try {
    const parsed = JSON.parse(raw) as { sessions?: Record<string, unknown> };
    for (const [id, p] of Object.entries(parsed.sessions ?? {})) {
      const model = isObj(p) ? parseModel(p.model) : null;
      if (cleanId(id) && model && isObj(p)) out.set(id, { model, updatedAt: typeof p.updatedAt === "string" ? p.updatedAt : "" });
    }
  } catch (e) {
    console.warn(`[hq] ${file} bukan JSON yang valid, model per sesi diabaikan:`, (e as Error).message);
  }
  return out;
}

const newHub = (): ChatHub => {
  const prefsFile = chatPrefsFile();
  return {
    view: emptyChatView(),
    runId: "",
    approvals: new Map(),
    abort: null,
    subs: new Set(),
    seq: 0,
    openText: null,
    outcome: "",
    resumed: null,
    stopTimer: null,
    epoch: 0,
    autoTitle: false,
    prefs: loadPrefs(prefsFile),
    prefsFile,
    models: null,
  };
};

const g = globalThis as unknown as { __hqChat?: ChatHub };
export const chat: ChatHub = (g.__hqChat ??= newHub());
// A hub kept on globalThis by an older bundle (next dev reload) may predate the session list and model fields.
if (!chat.prefs) {
  chat.prefsFile = chatPrefsFile();
  chat.prefs = loadPrefs(chat.prefsFile);
}
chat.models ??= null;
chat.autoTitle ??= false;
chat.view = { ...emptyChatView(), ...chat.view };

/** Write the model choices atomically (temp file + rename); a failure is logged, the choice still holds in memory. */
function savePrefs(): void {
  const rows = [...chat.prefs].sort(([, a], [, b]) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, MAX_PREFS);
  chat.prefs = new Map(rows);
  const sessions = Object.fromEntries([...rows].sort(([a], [b]) => a.localeCompare(b)));
  const file = chat.prefsFile;
  try {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, sessions }, null, 2) + "\n");
    fs.renameSync(tmp, file);
  } catch (e) {
    console.warn(`[hq] gagal menyimpan ${file}:`, (e as Error).message);
  }
}

/** Remember (or forget, with null) the model of a session. */
function rememberModel(sessionId: string | null, model: ModelChoice | null): void {
  if (!sessionId) return;
  const had = chat.prefs.get(sessionId);
  if (model) {
    if (had && modelKey(had.model) === modelKey(model)) return;
    chat.prefs.set(sessionId, { model, updatedAt: new Date().toISOString() });
  } else if (!chat.prefs.delete(sessionId)) return;
  savePrefs();
}

const nextId = (prefix: string) => `${prefix}${++chat.seq}`;

function emit(ev: ChatEvent): void {
  for (const send of chat.subs) {
    try {
      send(ev);
    } catch {
      chat.subs.delete(send);
    }
  }
}

export const chatSnapshot = (): ChatView => ({ ...chat.view, items: chat.view.items.slice() });
const emitSnapshot = () => emit({ type: "chat_snapshot", view: chatSnapshot() });

function putItem(item: ChatItem): void {
  chat.view.items = upsertItem(chat.view.items, item);
  emit({ type: "chat_item", item });
}

const stateOf = (v: ChatView): ChatState => ({
  sessionId: v.sessionId, title: v.title, phase: v.phase, thinking: v.thinking, agentId: v.agentId, model: v.model, runtime: v.runtime,
});

function setState(p: Partial<ChatState>): void {
  Object.assign(chat.view, p);
  emit({ type: "chat_state", ...stateOf(chat.view) });
}

const note = (text: string, tone: "info" | "error" = "info") => putItem({ kind: "note", id: nextId("n"), text, tone, at: Date.now() });
const find = (id: string | null) => (id ? chat.view.items.find((x) => x.id === id) : undefined);

/** Subscribe a panel stream; returns the unsubscribe function. */
export function subscribeChat(send: (ev: ChatEvent) => void): () => void {
  chat.subs.add(send);
  return () => chat.subs.delete(send);
}

/* ---------------- the session's office character ---------------- */

/** The id the Hermes hook gives a session (agent_id() in examples/hermes/hq_common.py): cc-<8 of sha1(id)>. */
export const hermesAgentId = (sessionId: string): string => `cc-${createHash("sha1").update(sessionId).digest("hex").slice(0, 8)}`;

/**
 * Put a session's character in the office, idle. `who` names it and pins name, role and team like a rename
 * (agent-hq-names.json), so hook events cannot overwrite them. Returns the id and a save error, if any.
 */
function showAgent(sessionId: string, title: string, who?: ChatAgentInput): { id: string; error: string } {
  const id = hermesAgentId(sessionId);
  const ev: Record<string, unknown> = { type: "agent_update", id, status: "idle", task: trunc(`Sesi chat: ${displayTitle(title) || "baru"}`, 140) };
  if (who) Object.assign(ev, { name: who.name, role: who.role, team: who.team });
  else if (!hub.agents.has(id)) Object.assign(ev, DEFAULT_CHAT_AGENT);
  publish(ev);
  if (!who) return { id, error: "" };
  const r = renameAgent({ type: "rename", id, name: who.name, role: who.role, team: who.team === "office" ? null : who.team });
  return { id, error: r.body.ok ? "" : str(r.body.error) };
}

/** The open session's character leaves the office. */
function hideAgent(): void {
  const id = chat.view.agentId;
  if (id && hub.agents.has(id)) publish({ type: "remove", id });
}

/** Status of the open session's character (Agent HQ shows the chat even without the Hermes hook). */
function agentSays(fields: Record<string, unknown>): void {
  const id = chat.view.agentId;
  if (!id) return;
  publish({ type: "agent_update", id, ...(hub.agents.has(id) ? {} : DEFAULT_CHAT_AGENT), ...fields });
}

/**
 * Who the session's character is, for Hermes. Sent as `system_message`, which Hermes adds to its own system prompt
 * for that turn only: memory, skills and the stored transcript stay as they are. Only for a character someone named.
 */
export function personaPrompt(agentId: string | null): string {
  const o = agentId ? hub.overrides.get(agentId) : undefined;
  if (!o || (!o.name && !o.role)) return "";
  const dept = o.team ? normalizeTeam(o.team) : null;
  const who = [o.name && `bernama "${o.name}"`, o.role && `dengan peran "${o.role}"`, dept && `di tim ${DEPTS[dept].label}`].filter(Boolean).join(" ");
  return (
    `Di Agent HQ (kantor virtual yang menampilkan agen AI), sesi ini tampil sebagai karakter ${who}. ` +
    "Pakai nama dan peran itu saat memperkenalkan diri. Memori, skill, dan tool Hermes tetap berlaku seperti biasa."
  );
}

/* ---------------- Hermes API ---------------- */

class HermesError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
  }
}

async function hermes(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal; accept?: string } = {}): Promise<Response> {
  const { url, key } = chatConfig();
  try {
    return await fetch(url + path, {
      method: init.method || "GET",
      headers: {
        authorization: `Bearer ${key}`,
        accept: init.accept || "application/json",
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: init.signal ?? AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  } catch (e) {
    if (init.signal?.aborted) throw e;
    throw new HermesError(`Hermes tidak bisa dihubungi di ${url}. Cek gateway Hermes dan API_SERVER_ENABLED.`);
  }
}

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const b = await res.json();
    return isObj(b) ? b : null;
  } catch {
    return null;
  }
}

/** Hermes' own error text of a failed call, redacted and short. */
async function upstreamText(res: Response): Promise<string> {
  const b = await readJson(res);
  const e = b?.error;
  const msg = typeof e === "string" ? e : isObj(e) && typeof e.message === "string" ? e.message : str(b?.message);
  return trunc(redact(msg || "tanpa keterangan"), 200);
}

/** A short, redacted reason for a failed Hermes call. */
async function upstreamError(res: Response): Promise<HermesError> {
  if (res.status === 401) return new HermesError("Kunci API ditolak Hermes. Samakan HQ_HERMES_API_KEY dengan API_SERVER_KEY di ~/.hermes/.env.");
  if (res.status === 429) return new HermesError("Hermes sedang penuh (batas run bersamaan). Coba lagi sebentar.", 429);
  return new HermesError(`Hermes menolak (HTTP ${res.status}): ${await upstreamText(res)}`, res.status === 409 ? 409 : 502);
}

const pad = (n: number) => String(n).padStart(2, "0");
const clock = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const sessionTitle = (d = new Date()) => `${TITLE_PREFIX} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${clock(d)}`;

async function createSession(): Promise<{ id: string; title: string }> {
  let res = await hermes("/api/sessions", { method: "POST", body: { title: sessionTitle() } });
  if (res.status === 400) res = await hermes("/api/sessions", { method: "POST", body: {} }); // title refused: go untitled
  if (!res.ok) throw await upstreamError(res);
  const s = (await readJson(res))?.session;
  if (!isObj(s) || !s.id) throw new HermesError("Hermes tidak mengembalikan id sesi");
  return { id: str(s.id), title: str(s.title) };
}

/** Text of a message `content` (string, or OpenAI-style parts). */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => (typeof p === "string" ? p : isObj(p) ? (typeof p.text === "string" ? p.text : p.type === "image_url" || p.type === "input_image" ? "[gambar]" : "") : ""))
    .filter(Boolean)
    .join("\n");
}

/** Inline media (data URLs) would flood the panel. */
const dropDataUrls = (s: string) => s.replace(/data:[\w/+.-]+;base64,[A-Za-z0-9+/=]{64,}/g, "[media]");
const shown = (s: string) => redact(dropDataUrls(s)).slice(0, MAX_CHAT_TEXT);

function parseArgs(v: unknown): Record<string, unknown> {
  if (isObj(v)) return v;
  if (typeof v !== "string") return {};
  try {
    const p = JSON.parse(v);
    return isObj(p) ? p : {};
  } catch {
    return {};
  }
}

/** One line describing a tool call: its preview, else the most telling argument. */
export function toolPreview(preview: unknown, args: unknown): string {
  const a = parseArgs(args);
  const pick = str(preview) || str(a.command) || str(a.path) || str(a.file_path) || str(a.query) || str(a.url) || str(Object.values(a).find((x) => typeof x === "string"));
  return trunc(redact(pick), 160);
}

/** Chat items from GET /api/sessions/{id}/messages rows (resume after an Agent HQ restart, open from Riwayat). */
export function historyItems(rows: unknown[]): ChatItem[] {
  const out: ChatItem[] = [];
  const list = rows.filter(isObj);
  if (list.every((m) => typeof m.id === "number")) list.sort((a, b) => Number(a.id) - Number(b.id));
  for (const m of list) {
    if (m.display_kind === "hidden") continue;
    const at = typeof m.timestamp === "number" ? Math.round(m.timestamp * 1000) : Date.now();
    const text = contentText(m.content).trim();
    const id = `h${str(m.id) || out.length}`;
    if (m.role === "user" && text) out.push({ kind: "user", id, text: shown(text), at });
    if (m.role !== "assistant") continue;
    if (text) out.push({ kind: "assistant", id, text: shown(text), streaming: false, at });
    const calls = Array.isArray(m.tool_calls) ? m.tool_calls.filter(isObj) : [];
    calls.forEach((c, i) => {
      const fn = isObj(c.function) ? c.function : {};
      out.push({ kind: "tool", id: `${id}t${i}`, name: str(fn.name || c.name) || "alat", preview: toolPreview("", fn.arguments), status: "ok", at });
    });
  }
  return out.slice(-MAX_CHAT_ITEMS);
}

async function loadHistory(id: string): Promise<ChatItem[]> {
  const m = await hermes(`/api/sessions/${enc(id)}/messages?inline_images=false`);
  const data = m.ok ? (await readJson(m))?.data : null;
  return Array.isArray(data) ? historyItems(data) : [];
}

/** API server sessions, most recently active first, with the raw title (resume) and the row the panel shows. */
async function fetchSessions(): Promise<{ id: string; title: string; row: ChatSession }[]> {
  const res = await hermes("/api/sessions?source=api_server&limit=50");
  if (!res.ok) throw await upstreamError(res);
  const data = (await readJson(res))?.data;
  return sessionRows(Array.isArray(data) ? data : []);
}

/** GET /api/sessions rows -> Riwayat rows: no hidden, archived, internal or foreign sessions; newest activity first. */
export function sessionRows(data: unknown[]): { id: string; title: string; row: ChatSession }[] {
  const rows = data
    .filter(isObj)
    .filter((r) => cleanId(r.id) && r.hidden !== true && r.archived !== true && r.is_internal_child !== true && (!r.source || r.source === "api_server"))
    .map((r) => {
      const id = str(r.id).trim();
      const title = str(r.title);
      const row: ChatSession = {
        id,
        title: trunc(redact(title), 120),
        preview: trunc(redact(dropDataUrls(str(r.preview))), 140),
        lastActive: toMs(r.last_active ?? r.started_at),
        messages: typeof r.message_count === "number" ? r.message_count : 0,
        agent: hub.overrides.get(hermesAgentId(id))?.name ?? "",
      };
      return { id, title, row };
    });
  const at = (x: { row: ChatSession }) => x.row.lastActive ?? -1;
  return rows.map((r, i) => ({ r, i })).sort((a, b) => at(b.r) - at(a.r) || a.i - b.i).map((x) => x.r);
}

/**
 * Make `s` the open session: its history, its model, its character in the office (the previous character leaves).
 * `model` given = the session's new model; otherwise the one remembered for it.
 */
function switchTo(s: { id: string; title: string }, items: ChatItem[], opts: { who?: ChatAgentInput; model?: ModelChoice | null; autoTitle?: boolean } = {}): void {
  hideAgent();
  const agent = showAgent(s.id, s.title, opts.who);
  if (opts.model !== undefined) rememberModel(s.id, opts.model);
  chat.approvals.clear();
  chat.openText = null;
  chat.runId = "";
  chat.outcome = "";
  chat.resumed = Promise.resolve(); // an explicit choice must not be replaced by the newest session
  chat.autoTitle = !!opts.autoTitle;
  chat.view = {
    ...emptyChatView(),
    sessionId: s.id,
    title: redact(s.title),
    agentId: agent.id,
    model: opts.model !== undefined ? opts.model : (chat.prefs.get(s.id)?.model ?? null),
    items,
  };
  emitSnapshot();
  if (agent.error) note(`Nama agen tidak tersimpan: ${trunc(agent.error, 160)}`, "error");
}

/** A session made for the draft (first message, no session yet) keeps the draft's items and model. */
function adoptNew(s: { id: string; title: string }): void {
  const agent = showAgent(s.id, s.title);
  rememberModel(s.id, chat.view.model);
  chat.autoTitle = true;
  setState({ sessionId: s.id, title: redact(s.title), agentId: agent.id });
}

/**
 * After a server start, continue the newest "Agent HQ" session in Hermes (with its history) instead of starting
 * an empty one. Runs once; a Hermes that was down is asked again next time.
 */
export function resumeLatest(): Promise<void> {
  if (!chatConfig().enabled) return Promise.resolve();
  chat.resumed ??= (async () => {
    try {
      const s = (await fetchSessions()).find((r) => r.title.startsWith(`${TITLE_PREFIX} `));
      if (!s || chat.view.sessionId) return;
      const items = await loadHistory(s.id);
      if (chat.view.sessionId || chat.view.items.length || chat.view.phase !== "idle") return; // a message was sent meanwhile
      switchTo(s, items);
    } catch {
      chat.resumed = null;
    }
  })();
  return chat.resumed;
}

/** "cek disk penuh di /var" -> the topic part of the title (redacted, one line, short). */
export const topicOf = (msg: string): string => trunc(redact(msg), AUTO_TOPIC);

/** Name a new session after its first message: "Agent HQ · <topic>" (titles are unique in Hermes; add the time if taken). */
async function retitle(sessionId: string, msg: string): Promise<void> {
  const topic = topicOf(msg);
  if (!topic) return;
  for (const title of [CHAT_TOPIC_PREFIX + topic, `${CHAT_TOPIC_PREFIX}${topic} (${clock()})`]) {
    try {
      const res = await hermes(`/api/sessions/${enc(sessionId)}`, { method: "PATCH", body: { title } });
      if (res.status === 400) continue;
      if (!res.ok) return;
      const s = (await readJson(res))?.session;
      if (chat.view.sessionId === sessionId) setState({ title: redact(isObj(s) && s.title ? str(s.title) : title) });
      return;
    } catch {
      return;
    }
  }
}

/* ---------------- one turn ---------------- */

function closeText(): void {
  const it = find(chat.openText);
  chat.openText = null;
  if (it?.kind === "assistant" && it.streaming) putItem({ ...it, streaming: false });
}

function appendText(delta: string): void {
  const it = find(chat.openText);
  const d = redact(dropDataUrls(delta));
  if (it?.kind === "assistant") {
    chat.view.items = upsertItem(chat.view.items, { ...it, text: appendCapped(it.text, d) });
    emit({ type: "chat_delta", id: it.id, delta: d });
    return;
  }
  const item: ChatItem = { kind: "assistant", id: nextId("m"), text: d.slice(0, MAX_CHAT_TEXT), streaming: true, at: Date.now() };
  chat.openText = item.id;
  putItem(item);
}

/** assistant.completed carries the final answer: it replaces what was streamed for it. */
function finalText(content: string): void {
  const it = find(chat.openText);
  chat.openText = null;
  if (it?.kind === "assistant") {
    putItem({ ...it, text: content ? shown(content) : it.text, streaming: false });
    return;
  }
  if (content) putItem({ kind: "assistant", id: nextId("m"), text: shown(content), streaming: false, at: Date.now() });
}

/** The model that answered (`runtime` on assistant.completed / run.*), shown next to the picker. */
function noteRuntime(v: unknown): void {
  if (!isObj(v)) return;
  const model = cleanId(v.model);
  if (!model) return;
  const rt = { provider: cleanId(v.provider, 80), model };
  if (modelKey(rt) !== modelKey(chat.view.runtime)) setState({ runtime: rt });
}

/**
 * Context compression can move the conversation to a new session id (the turn's `session_id`). Follow it, so the
 * next message continues the compressed transcript; the character and the model move along.
 */
function followSession(v: unknown): void {
  const next = cleanId(v);
  const prev = chat.view.sessionId;
  if (!next || !prev || next === prev) return;
  const from = chat.view.agentId;
  const to = hermesAgentId(next);
  const pinned = from ? hub.overrides.get(from) : undefined;
  if (pinned && !hub.overrides.has(to)) {
    hub.overrides.set(to, { ...pinned, updatedAt: new Date().toISOString() });
    try {
      saveOverrides(hub.overrides, hub.overridesFile);
    } catch (e) {
      console.warn(`[hq] gagal menyimpan ${hub.overridesFile}:`, (e as Error).message);
    }
  }
  rememberModel(next, chat.prefs.get(prev)?.model ?? chat.view.model);
  const was = from ? hub.agents.get(from) : undefined;
  hideAgent();
  publish({ type: "agent_update", id: to, ...(hub.agents.has(to) ? {} : DEFAULT_CHAT_AGENT), status: was?.status ?? "working", task: was?.task ?? "" });
  setState({ sessionId: next, agentId: to });
}

/** Apply one event of the Hermes session stream (/api/sessions/{id}/chat/stream). */
export function handleHermesEvent(name: string, d: Record<string, unknown>): void {
  switch (name) {
    case "run.started":
      chat.runId = str(d.run_id);
      break;
    case "assistant.delta": {
      const delta = str(d.delta);
      if (!delta) break;
      if (chat.view.thinking) setState({ thinking: false });
      appendText(delta);
      break;
    }
    case "assistant.commentary":
      if (d.already_streamed === true || !str(d.text).trim()) break;
      closeText();
      putItem({ kind: "assistant", id: nextId("m"), text: shown(str(d.text)), streaming: false, at: Date.now() });
      break;
    case "tool.progress":
      if (d.tool_name === "_thinking" && !chat.view.thinking) setState({ thinking: true });
      break;
    case "tool.started": {
      closeText();
      if (chat.view.thinking) setState({ thinking: false });
      const item: ChatItem = { kind: "tool", id: nextId("t"), name: str(d.tool_name) || "alat", preview: toolPreview(d.preview, d.args), status: "running", at: Date.now() };
      putItem(item);
      agentSays({ status: "working", task: trunc(`${item.name}: ${item.preview}`, 140) });
      break;
    }
    case "tool.completed":
    case "tool.failed": {
      const name2 = str(d.tool_name);
      const running = chat.view.items.filter((x) => x.kind === "tool" && x.status === "running");
      const it = running.find((x) => x.kind === "tool" && x.name === name2) ?? running[0];
      if (it?.kind === "tool") putItem({ ...it, status: name === "tool.failed" || d.is_error === true || d.error === true ? "error" : "ok" });
      break;
    }
    case "approval.request": {
      closeText();
      const choices = (Array.isArray(d.choices) ? d.choices : []).filter((c): c is ApprovalChoice => APPROVAL_CHOICES.includes(c as ApprovalChoice));
      const id = nextId("a");
      const command = trunc(redact(str(d.command)), 300);
      const description = trunc(redact(str(d.description)), 300);
      putItem({ kind: "approval", id, command, description, choices: choices.length ? choices : ["once", "deny"], status: "pending", at: Date.now() });
      chat.approvals.set(id, str(d.request_id || d.prompt_id));
      if (!chat.runId) chat.runId = str(d.run_id);
      if (chat.view.phase !== "stopping") setState({ phase: "approval", thinking: false });
      agentSays({ status: "waiting", task: trunc(`Minta izin: ${command || description || "perintah"}`, 140) });
      break;
    }
    case "assistant.completed":
      finalText(str(d.content));
      if (d.partial === true) note("Jawaban Hermes terpotong.");
      noteRuntime(d.runtime);
      followSession(d.session_id);
      break;
    case "run.completed":
      chat.outcome = "completed";
      noteRuntime(d.runtime);
      followSession(d.session_id);
      break;
    case "run.failed":
      chat.outcome = "failed";
      note(`Gagal: ${trunc(redact(str(d.error) || str(d.turn_exit_reason) || "Hermes tidak menyelesaikan pekerjaan"), 240)}`, "error");
      break;
    case "run.cancelled":
      chat.outcome = "cancelled";
      note("Dihentikan.");
      break;
    case "error":
      note(`Error dari Hermes: ${trunc(redact(str(d.message)), 240)}`, "error");
      break;
  }
}

function finishTurn(): void {
  closeText();
  for (const it of chat.view.items) {
    if (it.kind === "tool" && it.status === "running") putItem({ ...it, status: chat.outcome === "completed" ? "ok" : "error" });
  }
  for (const id of chat.approvals.keys()) {
    const it = find(id);
    if (it?.kind === "approval" && it.status === "pending") putItem({ ...it, status: "expired" });
  }
  chat.approvals.clear();
  if (chat.stopTimer) clearTimeout(chat.stopTimer);
  chat.stopTimer = null;
  chat.abort = null;
  chat.runId = "";
  setState({ phase: "idle", thinking: false });
  agentSays(chat.outcome === "completed" ? { status: "idle", task: "Menunggu pesan berikutnya" } : chat.outcome === "cancelled" ? { status: "idle", task: "Dihentikan" } : { status: "error" });
}

async function consume(res: Response, abort: AbortController): Promise<void> {
  const epoch = chat.epoch;
  const current = () => chat.epoch === epoch;
  try {
    for await (const { event, data } of sseFrames(res.body!)) {
      if (!current()) return;
      let payload: unknown;
      try {
        payload = JSON.parse(data);
      } catch {
        continue;
      }
      if (!isObj(payload)) continue;
      handleHermesEvent(event || str(payload.event), payload);
      if (event === "done") break;
    }
    if (current() && !chat.outcome && !abort.signal.aborted) note("Stream Hermes selesai tanpa hasil akhir.", "error");
  } catch {
    if (!current()) return;
    if (abort.signal.aborted) {
      if (!chat.outcome) note("Dihentikan.");
    } else note("Koneksi ke Hermes terputus di tengah jalan. Hermes biasanya ikut menghentikan pekerjaannya.", "error");
  } finally {
    if (current()) finishTurn();
  }
}

/* ---------------- actions (POST /api/hermes) ---------------- */

/** Body of one turn: the message as typed, the session's model, and who its character is. */
function turnBody(msg: string): Record<string, unknown> {
  const body: Record<string, unknown> = { message: msg };
  const m = chat.view.model;
  if (m) {
    body.model = m.model;
    if (m.provider) body.provider = m.provider;
  }
  const persona = personaPrompt(chat.view.agentId);
  if (persona) body.system_message = persona;
  return body;
}

export async function sendMessage(text: unknown): Promise<Reply> {
  const msg = typeof text === "string" ? text.trim() : "";
  if (!msg) return fail(400, "Pesan kosong");
  if (msg.length > MAX_CHAT_MESSAGE) return fail(413, `Pesan terlalu panjang (maks ${MAX_CHAT_MESSAGE} karakter)`);
  if (chat.view.phase !== "idle") return fail(409, "Hermes masih mengerjakan pesan sebelumnya. Tunggu atau tekan Hentikan.");
  const abort = new AbortController();
  chat.abort = abort;
  chat.runId = "";
  chat.outcome = "";
  chat.openText = null;
  setState({ phase: "starting", thinking: false });
  putItem({ kind: "user", id: nextId("u"), text: shown(msg), at: Date.now() });
  const open = () =>
    hermes(`/api/sessions/${enc(chat.view.sessionId!)}/chat/stream`, { method: "POST", body: turnBody(msg), signal: abort.signal, accept: "text/event-stream" });
  try {
    await resumeLatest();
    if (!chat.view.sessionId) adoptNew(await createSession());
    agentSays({ status: "thinking", task: trunc(redact(msg), 140), progress: null });
    let res = await open();
    if (res.status === 404) {
      note("Sesi lama tidak ada lagi di Hermes, jadi percakapan baru dimulai.");
      hideAgent();
      setState({ sessionId: null, title: "", agentId: null });
      adoptNew(await createSession());
      agentSays({ status: "thinking", task: trunc(redact(msg), 140), progress: null });
      res = await open();
    }
    if (!res.ok || !res.body) throw await upstreamError(res);
    setState({ phase: "running" });
    if (chat.autoTitle) {
      chat.autoTitle = false;
      void retitle(chat.view.sessionId!, msg);
    }
    void consume(res, abort);
    return { status: 202, body: { ok: true, sessionId: chat.view.sessionId } };
  } catch (e) {
    const stopped = abort.signal.aborted;
    if (chat.abort !== abort) return fail(409, "Percakapan sudah direset");
    note(stopped ? "Dihentikan sebelum Hermes mulai." : (e as Error).message, stopped ? "info" : "error");
    chat.abort = null;
    setState({ phase: "idle", thinking: false });
    agentSays(stopped ? { status: "idle", task: "Dihentikan" } : { status: "error" });
    if (stopped) return ok({ stopped: true });
    return fail(e instanceof HermesError ? e.status : 502, (e as Error).message);
  }
}

/** Answer a pending approval ({"choice", "id"?}; id defaults to the oldest pending one). */
export async function answerApproval(choice: unknown, itemId?: unknown): Promise<Reply> {
  const id = typeof itemId === "string" && chat.approvals.has(itemId) ? itemId : [...chat.approvals.keys()][0];
  const it = find(id ?? null);
  if (!id || it?.kind !== "approval" || it.status !== "pending") return fail(409, "Tidak ada permintaan izin yang menunggu");
  if (!it.choices.includes(choice as ApprovalChoice)) return fail(400, "Pilihan izin tidak valid");
  if (!chat.runId) return fail(409, "Run Hermes belum dikenal, coba lagi sebentar");
  const runPath = `/v1/runs/${enc(chat.runId)}`;
  try {
    // A gateway with the canonical session owner wants the exact prompt id and generation from the run status;
    // an older gateway takes the choice alone (plus the request id when the event had one).
    let body: Record<string, unknown> = { choice };
    const st = await hermes(runPath);
    const s = st.ok ? await readJson(st) : null;
    const pc = s?.pending_controls;
    const prompts = Array.isArray(pc) ? pc.filter(isObj).filter((x) => x.kind === "approval") : [];
    const want = chat.approvals.get(id) || "";
    const p = prompts.find((x) => x.prompt_id === want) ?? prompts[0];
    if (p && typeof s?.execution_generation === "number") body = { request_id: str(p.prompt_id), execution_generation: s.execution_generation, choice };
    else if (want) body.request_id = want;
    const res = await hermes(`${runPath}/approval`, { method: "POST", body });
    if (!res.ok) throw await upstreamError(res);
    chat.approvals.delete(id);
    putItem({ ...it, status: choice as ApprovalChoice });
    if (chat.view.phase === "approval" && !chat.approvals.size) setState({ phase: "running" });
    agentSays({ status: choice === "deny" ? "thinking" : "working" });
    return ok();
  } catch (e) {
    return fail(e instanceof HermesError ? e.status : 502, (e as Error).message);
  }
}

export async function stopRun(): Promise<Reply> {
  const phase = chat.view.phase;
  if (phase === "idle") return fail(409, "Tidak ada pekerjaan yang berjalan");
  if (phase === "stopping") return { status: 202, body: { ok: true } };
  const abort = chat.abort;
  if (!chat.runId) {
    abort?.abort(); // still starting: dropping the stream stops the turn
    return { status: 202, body: { ok: true } };
  }
  setState({ phase: "stopping" });
  chat.stopTimer = setTimeout(() => {
    if (chat.view.phase === "stopping" && chat.abort === abort) abort?.abort();
  }, STOP_FALLBACK_MS);
  chat.stopTimer.unref?.();
  try {
    const res = await hermes(`/v1/runs/${enc(chat.runId)}/stop`, { method: "POST", body: {} });
    if (!res.ok && res.status !== 409) abort?.abort();
  } catch {
    abort?.abort();
  }
  return { status: 202, body: { ok: true } };
}

const BUSY_SWITCH = "Hermes masih bekerja. Tunggu selesai atau tekan Hentikan sebelum pindah sesi.";

/** {"name"?, "role"?, "team"?} of a new session's character; null when none was given. */
function parseAgent(v: unknown): ChatAgentInput | null | { error: string } {
  if (v == null) return null;
  if (!isObj(v)) return { error: 'agent harus {"name", "role", "team"}' };
  const text = (x: unknown) => (typeof x === "string" ? x.replace(/\s+/g, " ").trim() : "");
  const name = text(v.name);
  const role = text(v.role);
  if (name.length > MAX_IDENTITY_LEN) return { error: `Nama terlalu panjang (maks ${MAX_IDENTITY_LEN} karakter)` };
  if (role.length > MAX_IDENTITY_LEN) return { error: `Peran terlalu panjang (maks ${MAX_IDENTITY_LEN} karakter)` };
  const team = v.team == null || v.team === "" ? "office" : String(v.team);
  if (!CHAT_TEAMS.includes(team as ChatTeam)) return { error: "Tim harus office, red, report, atau blue" };
  return { name: name || DEFAULT_CHAT_AGENT.name, role: role || DEFAULT_CHAT_AGENT.role, team: team as ChatTeam };
}

/**
 * Start over: a new Hermes session right away, so its character can walk in. {"agent"?: {name, role, team}} names
 * the character; {"model"?} picks its model (null = Hermes' default; left out = the open session's model).
 * The old session stays in Hermes and in Riwayat.
 */
export async function newConversation(agent?: unknown, model?: unknown): Promise<Reply> {
  if (chat.view.phase !== "idle") return fail(409, "Hentikan dulu pekerjaan yang sedang berjalan");
  const who = parseAgent(agent);
  if (who && "error" in who) return fail(400, who.error);
  let m = chat.view.model;
  if (model !== undefined) {
    m = model === null ? null : parseModel(model);
    if (model !== null && !m) return fail(400, MODEL_ERR);
  }
  const s = await createSession();
  if (chat.view.phase !== "idle") return fail(409, "Hermes mulai mengerjakan pesan lain. Sesi baru tetap tersimpan di Riwayat.");
  switchTo(s, [], { who: who ?? undefined, model: m, autoTitle: true });
  return ok({ sessionId: s.id, agentId: chat.view.agentId });
}

/**
 * Riwayat: the API server's sessions (other surfaces' sessions cannot be continued through the API server).
 * `now` is the server's clock, so "5 mnt lalu" does not depend on the viewer's clock.
 */
export async function listSessions(): Promise<Reply> {
  const rows = await fetchSessions();
  return ok({ sessions: rows.map((r) => r.row), current: chat.view.sessionId, now: Date.now() });
}

/** Continue another session: load its history, its model, and its character. Only while Hermes is idle. */
export async function openSession(sessionId: unknown): Promise<Reply> {
  const id = cleanId(sessionId);
  if (!id) return fail(400, "sessionId tidak valid");
  if (chat.view.phase !== "idle") return fail(409, BUSY_SWITCH);
  if (id === chat.view.sessionId) return ok({ sessionId: id });
  const res = await hermes(`/api/sessions/${enc(id)}`);
  if (res.status === 404) return fail(404, "Sesi itu tidak ada lagi di Hermes");
  if (!res.ok) throw await upstreamError(res);
  const s = (await readJson(res))?.session;
  if (!isObj(s)) throw new HermesError("Hermes tidak mengembalikan data sesi");
  const source = str(s.source);
  if (source && source !== "api_server") {
    return fail(409, `Sesi dari ${trunc(source, 30)} tidak bisa dilanjutkan dari panel ini. Hermes hanya mengizinkan sesi yang dibuat lewat API server.`);
  }
  const items = await loadHistory(id);
  if (chat.view.phase !== "idle") return fail(409, BUSY_SWITCH);
  switchTo({ id, title: str(s.title) }, items);
  return ok({ sessionId: id });
}

/** Rename a session (default: the open one). The title stays "Agent HQ · <topic>" so it is resumed after a restart. */
export async function renameSession(sessionId: unknown, title: unknown): Promise<Reply> {
  const id = sessionId == null || sessionId === "" ? chat.view.sessionId : cleanId(sessionId);
  if (!id) return fail(400, "Belum ada sesi untuk diganti namanya");
  const topic = typeof title === "string" ? title.replace(/\s+/g, " ").trim() : "";
  if (!topic) return fail(400, "Judul kosong");
  if (topic.length > MAX_CHAT_TOPIC) return fail(400, `Judul terlalu panjang (maks ${MAX_CHAT_TOPIC} karakter)`);
  const res = await hermes(`/api/sessions/${enc(id)}`, { method: "PATCH", body: { title: CHAT_TOPIC_PREFIX + topic } });
  if (res.status === 404) return fail(404, "Sesi itu tidak ada lagi di Hermes");
  if (res.status === 400) return fail(409, `Judul ditolak Hermes (mungkin sudah dipakai sesi lain): ${await upstreamText(res)}`);
  if (!res.ok) throw await upstreamError(res);
  const s = (await readJson(res))?.session;
  const next = redact(isObj(s) && s.title ? str(s.title) : CHAT_TOPIC_PREFIX + topic);
  if (id === chat.view.sessionId) {
    chat.autoTitle = false;
    setState({ title: next });
  }
  return ok({ sessionId: id, title: next });
}

/** Delete a session in Hermes, with its character, its pinned name and its model. The open one only while idle. */
export async function deleteSession(sessionId: unknown): Promise<Reply> {
  const id = cleanId(sessionId);
  if (!id) return fail(400, "sessionId tidak valid");
  const current = id === chat.view.sessionId;
  if (current && chat.view.phase !== "idle") return fail(409, "Hentikan dulu pekerjaan yang sedang berjalan");
  const res = await hermes(`/api/sessions/${enc(id)}`, { method: "DELETE" });
  if (res.status === 409) return fail(409, "Hermes masih mengerjakan sesi ini. Tunggu atau hentikan dulu.");
  if (!res.ok && res.status !== 404) throw await upstreamError(res);
  const agentId = hermesAgentId(id);
  if (current) {
    hideAgent();
    chat.view = { ...emptyChatView(), model: chat.view.model };
    chat.approvals.clear();
    chat.openText = null;
    chat.autoTitle = false;
    chat.resumed = Promise.resolve();
    emitSnapshot();
  } else if (hub.agents.has(agentId)) publish({ type: "remove", id: agentId });
  if (hub.overrides.delete(agentId)) {
    try {
      saveOverrides(hub.overrides, hub.overridesFile);
    } catch (e) {
      console.warn(`[hq] gagal menyimpan ${hub.overridesFile}:`, (e as Error).message);
    }
  }
  rememberModel(id, null);
  return ok({ deleted: id });
}

/** Hermes /api/model/options -> picker providers (authenticated, with models). */
export function modelProviders(b: Record<string, unknown> | null): Pick<ModelOptions, "current" | "providers"> {
  const rows = Array.isArray(b?.providers) ? b.providers.filter(isObj) : [];
  const providers: ModelProvider[] = [];
  for (const p of rows) {
    const slug = cleanId(p.slug, 80);
    if (!slug || p.authenticated === false || providers.length >= 40) continue;
    const models = [...new Set((Array.isArray(p.models) ? p.models : []).map((m) => cleanId(isObj(m) ? m.id ?? m.name : m)).filter(Boolean))].slice(0, 300);
    if (models.length) providers.push({ slug, name: trunc(str(p.name) || slug, 60), current: p.is_current === true, models });
  }
  const model = cleanId(b?.model);
  return { current: model ? { provider: cleanId(b?.provider, 80), model } : null, providers };
}

/** Whether Hermes' memory and session_search are on for the API server (GET /v1/toolsets); null = unknown. */
async function memoryTools(): Promise<Pick<ModelOptions, "memory" | "sessionSearch">> {
  try {
    const res = await hermes("/v1/toolsets");
    const data = res.ok ? (await readJson(res))?.data : null;
    if (!Array.isArray(data)) return { memory: null, sessionSearch: null };
    const on = (tool: string) => data.filter(isObj).some((t) => t.enabled === true && Array.isArray(t.tools) && t.tools.includes(tool));
    return { memory: on("memory"), sessionSearch: on("session_search") };
  } catch {
    return { memory: null, sessionSearch: null };
  }
}

/**
 * The model picker: authenticated providers and their models, Hermes' default, and the memory switches. Cached for
 * a minute ({"refresh": true} asks Hermes to probe again). A missing list comes back as `error`, not as a failure.
 */
export async function listModels(refresh = false): Promise<Reply> {
  const cached = chat.models;
  if (!refresh && cached && Date.now() - cached.at < MODELS_TTL_MS) return ok({ ...cached.value });
  const [memory, list] = await Promise.all([
    memoryTools(),
    (async (): Promise<Pick<ModelOptions, "current" | "providers"> | string> => {
      let res: Response;
      try {
        res = await hermes(`/api/model/options?include_unconfigured=false${refresh ? "&refresh=1" : ""}`, { signal: AbortSignal.timeout(MODELS_TIMEOUT_MS) });
      } catch (e) {
        return e instanceof HermesError ? e.message : "Hermes terlalu lama menyiapkan daftar model. Coba lagi sebentar.";
      }
      if (res.status === 404) return "Hermes ini belum punya daftar model (GET /api/model/options). Update Hermes untuk memilih model dari panel.";
      if (!res.ok) return (await upstreamError(res)).message;
      return modelProviders(await readJson(res));
    })(),
  ]);
  if (typeof list === "string") return ok({ current: null, providers: [], ...memory, error: list });
  const value: ModelOptions = { ...list, ...memory };
  chat.models = { at: Date.now(), value };
  return ok({ ...value });
}

/** The model of the open session (or of the next one, before it exists); null = Hermes' default. */
export function chooseModel(model: unknown): Reply {
  const m = model === null ? null : parseModel(model);
  if (model !== null && !m) return fail(400, MODEL_ERR);
  rememberModel(chat.view.sessionId, m);
  setState({ model: m });
  return ok({ model: m });
}

const ACTIONS = "send, approve, stop, new, sessions, open, rename, delete, models, atau model";

/**
 * POST /api/hermes body: {"action": "send", "text"} | {"action": "approve", "choice", "id"?} | {"action": "stop"} |
 * {"action": "new", "agent"?, "model"?} | {"action": "sessions"} | {"action": "open", "sessionId"} |
 * {"action": "rename", "sessionId"?, "title"} | {"action": "delete", "sessionId"} | {"action": "models", "refresh"?} |
 * {"action": "model", "model": {"provider", "model"} | null}.
 */
export async function chatAction(body: unknown): Promise<Reply> {
  const b = isObj(body) ? body : {};
  try {
    switch (b.action) {
      case "send":
        return await sendMessage(b.text);
      case "approve":
        return await answerApproval(b.choice, b.id);
      case "stop":
        return await stopRun();
      case "new":
        return await newConversation(b.agent, b.model);
      case "sessions":
        return await listSessions();
      case "open":
        return await openSession(b.sessionId);
      case "rename":
        return await renameSession(b.sessionId, b.title);
      case "delete":
        return await deleteSession(b.sessionId);
      case "models":
        return await listModels(b.refresh === true);
      case "model":
        return chooseModel(b.model);
      default:
        return fail(400, `action harus ${ACTIONS}`);
    }
  } catch (e) {
    return fail(e instanceof HermesError ? e.status : 502, (e as Error).message);
  }
}

/** Test helper: drop the conversation and every subscriber (and re-read the model file). */
export function resetChat(): void {
  const epoch = chat.epoch + 1;
  chat.abort?.abort();
  if (chat.stopTimer) clearTimeout(chat.stopTimer);
  Object.assign(chat, newHub(), { epoch });
}
