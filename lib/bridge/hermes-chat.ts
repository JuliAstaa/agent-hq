// Hermes chat bridge (docs/hermes.md "Chat Hermes"). The office's chat panel talks to the Hermes API server
// (gateway platform `api_server`, http://127.0.0.1:8642) only through this module:
// - the Agent HQ server opens the session stream itself and keeps reading it, because Hermes stops a turn when its
//   stream client disconnects and the panel may be closed or reloaded mid-turn;
// - the API key (HQ_HERMES_API_KEY = Hermes' API_SERVER_KEY) never leaves the server;
// - the panel gets the conversation over GET /api/hermes/stream and acts with POST /api/hermes, both behind
//   chatGuard() because a message to Hermes can run anything Hermes' tools can run.
// The conversation is shown with redact() applied (like logs); Hermes itself receives the message as typed.

import { sseFrames } from "../sse";
import { authorized } from "./auth";
import { crossSite } from "./cron";
import { redact, trunc } from "./redact";
import {
  APPROVAL_CHOICES, MAX_CHAT_ITEMS, MAX_CHAT_MESSAGE, MAX_CHAT_TEXT, appendCapped, emptyChatView, upsertItem,
  type ApprovalChoice, type ChatEvent, type ChatItem, type ChatView,
} from "../hermes-chat";

/** Sessions this panel creates are titled "Agent HQ <date time>"; the newest one is resumed after a restart. */
export const TITLE_PREFIX = "Agent HQ";
export const DEFAULT_HERMES_API_URL = "http://127.0.0.1:8642";
/** A stop that Hermes did not settle within this time drops the stream (Hermes then interrupts the turn). */
export const STOP_FALLBACK_MS = 20_000;
const CALL_TIMEOUT_MS = 15_000;

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

/* ---------------- state ---------------- */

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
}

const newHub = (): ChatHub => ({
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
});

const g = globalThis as unknown as { __hqChat?: ChatHub };
export const chat: ChatHub = (g.__hqChat ??= newHub());

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

function setState(p: Partial<Pick<ChatView, "phase" | "thinking" | "sessionId" | "title">>): void {
  Object.assign(chat.view, p);
  const v = chat.view;
  emit({ type: "chat_state", phase: v.phase, thinking: v.thinking, sessionId: v.sessionId, title: v.title });
}

const note = (text: string, tone: "info" | "error" = "info") => putItem({ kind: "note", id: nextId("n"), text, tone, at: Date.now() });
const find = (id: string | null) => (id ? chat.view.items.find((x) => x.id === id) : undefined);

/** Subscribe a panel stream; returns the unsubscribe function. */
export function subscribeChat(send: (ev: ChatEvent) => void): () => void {
  chat.subs.add(send);
  return () => chat.subs.delete(send);
}

/* ---------------- Hermes API ---------------- */

class HermesError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
  }
}

const enc = encodeURIComponent;
const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

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

/** A short, redacted reason for a failed Hermes call. */
async function upstreamError(res: Response): Promise<HermesError> {
  if (res.status === 401) return new HermesError("Kunci API ditolak Hermes. Samakan HQ_HERMES_API_KEY dengan API_SERVER_KEY di ~/.hermes/.env.");
  if (res.status === 429) return new HermesError("Hermes sedang penuh (batas run bersamaan). Coba lagi sebentar.", 429);
  const b = await readJson(res);
  const e = b?.error;
  const msg = typeof e === "string" ? e : isObj(e) && typeof e.message === "string" ? e.message : str(b?.message);
  return new HermesError(`Hermes menolak (HTTP ${res.status}): ${trunc(redact(msg || "tanpa keterangan"), 200)}`, res.status === 409 ? 409 : 502);
}

const pad = (n: number) => String(n).padStart(2, "0");
const sessionTitle = (d = new Date()) =>
  `${TITLE_PREFIX} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

async function createSession(): Promise<void> {
  let res = await hermes("/api/sessions", { method: "POST", body: { title: sessionTitle() } });
  if (res.status === 400) res = await hermes("/api/sessions", { method: "POST", body: {} }); // title refused: go untitled
  if (!res.ok) throw await upstreamError(res);
  const s = (await readJson(res))?.session;
  if (!isObj(s) || !s.id) throw new HermesError("Hermes tidak mengembalikan id sesi");
  setState({ sessionId: str(s.id), title: str(s.title) });
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

/** Chat items from GET /api/sessions/{id}/messages rows (resume after an Agent HQ restart). */
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

/**
 * After a server start, continue the newest "Agent HQ" session in Hermes (with its history) instead of starting
 * an empty one. Runs once; a Hermes that was down is asked again next time.
 */
export function resumeLatest(): Promise<void> {
  if (!chatConfig().enabled) return Promise.resolve();
  chat.resumed ??= (async () => {
    try {
      const res = await hermes("/api/sessions?source=api_server&limit=50");
      if (!res.ok) return;
      const rows = (await readJson(res))?.data;
      const s = Array.isArray(rows) ? rows.filter(isObj).find((r) => str(r.title).startsWith(`${TITLE_PREFIX} `) && r.id) : undefined;
      if (!s || chat.view.sessionId) return;
      const m = await hermes(`/api/sessions/${enc(str(s.id))}/messages?inline_images=false`);
      const data = m.ok ? (await readJson(m))?.data : null;
      if (chat.view.sessionId || chat.view.items.length) return; // a message was sent meanwhile
      chat.view = { ...chat.view, sessionId: str(s.id), title: str(s.title), items: Array.isArray(data) ? historyItems(data) : [] };
      emitSnapshot();
    } catch {
      chat.resumed = null;
    }
  })();
  return chat.resumed;
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
    case "tool.started":
      closeText();
      if (chat.view.thinking) setState({ thinking: false });
      putItem({ kind: "tool", id: nextId("t"), name: str(d.tool_name) || "alat", preview: toolPreview(d.preview, d.args), status: "running", at: Date.now() });
      break;
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
      putItem({
        kind: "approval",
        id,
        command: trunc(redact(str(d.command)), 300),
        description: trunc(redact(str(d.description)), 300),
        choices: choices.length ? choices : ["once", "deny"],
        status: "pending",
        at: Date.now(),
      });
      chat.approvals.set(id, str(d.request_id || d.prompt_id));
      if (!chat.runId) chat.runId = str(d.run_id);
      if (chat.view.phase !== "stopping") setState({ phase: "approval", thinking: false });
      break;
    }
    case "assistant.completed":
      finalText(str(d.content));
      if (d.partial === true) note("Jawaban Hermes terpotong.");
      break;
    case "run.completed":
      chat.outcome = "completed";
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
  const open = () => hermes(`/api/sessions/${enc(chat.view.sessionId!)}/chat/stream`, { method: "POST", body: { message: msg }, signal: abort.signal, accept: "text/event-stream" });
  try {
    await resumeLatest();
    if (!chat.view.sessionId) await createSession();
    let res = await open();
    if (res.status === 404) {
      note("Sesi lama tidak ada lagi di Hermes, jadi percakapan baru dimulai.");
      setState({ sessionId: null, title: "" });
      await createSession();
      res = await open();
    }
    if (!res.ok || !res.body) throw await upstreamError(res);
    setState({ phase: "running" });
    void consume(res, abort);
    return { status: 202, body: { ok: true, sessionId: chat.view.sessionId } };
  } catch (e) {
    const stopped = abort.signal.aborted;
    if (chat.abort !== abort) return fail(409, "Percakapan sudah direset");
    note(stopped ? "Dihentikan sebelum Hermes mulai." : (e as Error).message, stopped ? "info" : "error");
    chat.abort = null;
    setState({ phase: "idle", thinking: false });
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

/** Start over: the next message opens a new Hermes session (the old one stays in Hermes). */
export function newConversation(): Reply {
  if (chat.view.phase !== "idle") return fail(409, "Hentikan dulu pekerjaan yang sedang berjalan");
  chat.view = emptyChatView();
  chat.approvals.clear();
  chat.openText = null;
  chat.resumed = Promise.resolve(); // an explicit new chat must not be replaced by the old one
  emitSnapshot();
  return ok();
}

/** POST /api/hermes body: {"action": "send", "text"} | {"action": "approve", "choice", "id"?} | {"action": "stop"} | {"action": "new"}. */
export async function chatAction(body: unknown): Promise<Reply> {
  const b = isObj(body) ? body : {};
  switch (b.action) {
    case "send":
      return sendMessage(b.text);
    case "approve":
      return answerApproval(b.choice, b.id);
    case "stop":
      return stopRun();
    case "new":
      return newConversation();
    default:
      return fail(400, "action harus send, approve, stop, atau new");
  }
}

/** Test helper: drop the conversation and every subscriber. */
export function resetChat(): void {
  const epoch = chat.epoch + 1;
  chat.abort?.abort();
  if (chat.stopTimer) clearTimeout(chat.stopTimer);
  Object.assign(chat, newHub(), { epoch });
}
