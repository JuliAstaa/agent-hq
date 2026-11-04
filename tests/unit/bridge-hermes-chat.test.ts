// Hermes chat, bridge side (lib/bridge/hermes-chat.ts) against a fake Hermes API server: the guard, one turn from
// message to final answer, approvals (legacy and canonical gateway), stop, errors, resume after a restart, redaction,
// and the session tools: Riwayat (list, open, rename, delete), new sessions with their office character, the model
// per session, the persona sent to Hermes, and following a compression rotation.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  chat, chatAction, chatConfig, chatGuard, handleHermesEvent, hermesAgentId, historyItems, modelProviders, personaPrompt,
  resetChat, resumeLatest, sessionRows, subscribeChat, toolPreview, topicOf,
} from "@/lib/bridge/hermes-chat";
import { hub, reloadOverrides, resetHub, type BridgeEvent } from "@/lib/bridge/hub";
import type { ChatEvent, ChatItem, ChatSession } from "@/lib/hermes-chat";
import { helloTurn, startFakeHermes, type FakeHermes } from "../helpers/fake-hermes-api";

let fake: FakeHermes;
let events: ChatEvent[] = [];
let office: BridgeEvent[] = [];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hq-chat-"));
const namesFile = path.join(tmp, "names.json");
const prefsFile = path.join(tmp, "hermes.json");
const ENV = ["HQ_HERMES_API_KEY", "HQ_HERMES_API_URL", "HQ_TOKEN", "HQ_HERMES_CHAT_FILE"] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

beforeAll(async () => {
  fake = await startFakeHermes();
  process.env.HQ_HERMES_API_KEY = fake.key;
  process.env.HQ_HERMES_API_URL = fake.url;
  process.env.HQ_HERMES_CHAT_FILE = prefsFile;
  delete process.env.HQ_TOKEN;
});
afterAll(async () => {
  resetChat();
  resetHub();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  reloadOverrides();
  await fake.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => {
  fs.rmSync(namesFile, { force: true });
  fs.rmSync(prefsFile, { force: true });
  resetHub();
  reloadOverrides(namesFile);
  resetChat();
  Object.assign(fake, { script: helloTurn, canonical: false, rejectTitle: false, streamStatus: 0, modelOptions: null, toolsets: null });
  fake.calls.length = 0;
  fake.sessions.length = 0;
  fake.messages.clear();
  process.env.HQ_HERMES_API_URL = fake.url;
  events = [];
  office = [];
  subscribeChat((e) => events.push(e));
  hub.subs.add((e) => office.push(e));
});
afterEach(() => resetChat());

const until = async (fn: () => boolean, ms = 4000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
};
const idle = () => until(() => chat.view.phase === "idle");
const brief = (i: ChatItem) =>
  i.kind === "tool" ? ["tool", i.preview, i.status] : i.kind === "approval" ? ["approval", i.status] : [i.kind, i.text];
const items = () => chat.view.items.map(brief);
const send = (text: string) => chatAction({ action: "send", text });
const streams = () => fake.calls.filter((c) => c.path.endsWith("/chat/stream"));
const lastStreamBody = () => streams().at(-1)?.body as Record<string, unknown>;
const json = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));

describe("config and guard", () => {
  it("needs a key and an http(s) URL", () => {
    expect(chatConfig({}).enabled).toBe(false);
    expect(chatConfig({ HQ_HERMES_API_KEY: "k", HQ_HERMES_API_URL: "ftp://x" }).enabled).toBe(false);
    expect(chatConfig({ HQ_HERMES_API_KEY: "k", HQ_HERMES_API_URL: "http://127.0.0.1:8642/" })).toMatchObject({ enabled: true, url: "http://127.0.0.1:8642" });
    expect(chatConfig({ HQ_HERMES_API_KEY: "k" }).url).toBe("http://127.0.0.1:8642");
  });

  it("only the office itself, on localhost or an allowed host with HQ_TOKEN", () => {
    const env = { HQ_HERMES_API_KEY: "k" };
    const r = (headers: Record<string, string>) => new Request("http://x/api/hermes", { method: "POST", headers });
    const st = (headers: Record<string, string>, post = false, e: Record<string, string> = env) => chatGuard(r(headers), post, e)?.status ?? 0;
    expect(st({ host: "localhost:8787" }, false, {})).toBe(404); // not configured
    expect(st({ host: "localhost:8787", "content-type": "application/json" }, true)).toBe(0);
    expect(st({ host: "127.0.0.1:9787", origin: "http://127.0.0.1:9787", "sec-fetch-site": "same-origin" })).toBe(0);
    expect(st({ host: "[::1]:8787" })).toBe(0);
    expect(st({ host: "localhost:8787" }, true)).toBe(415);
    expect(st({ host: "localhost:8787", origin: "https://evil.example", "sec-fetch-site": "cross-site" })).toBe(403);
    // DNS rebinding: the browser thinks it is same-origin, but the Host is the attacker's name
    expect(st({ host: "evil.example:8787", origin: "http://evil.example:8787", "sec-fetch-site": "same-origin" })).toBe(403);
    const domain = { ...env, HQ_ALLOWED_HOSTS: "hq.example.com" };
    expect(st({ host: "hq.example.com" }, false, domain)).toBe(403); // a domain also needs HQ_TOKEN
    expect(st({ host: "hq.example.com" }, false, { ...domain, HQ_TOKEN: "t" })).toBe(401);
    expect(st({ host: "hq.example.com", authorization: "Bearer t" }, false, { ...domain, HQ_TOKEN: "t" })).toBe(0);
    expect(st({ host: "localhost:8787" }, false, { ...env, HQ_TOKEN: "t" })).toBe(401);
    expect(st({ host: "localhost:8787", "x-hq-token": "t" }, false, { ...env, HQ_TOKEN: "t" })).toBe(0);
  });
});

describe("a turn", () => {
  it("creates a session, streams, shows the tool, keeps the final answer, names the session after the message", async () => {
    const r = await send("halo hermes");
    expect(r.status).toBe(202);
    await idle();
    expect(fake.sessions).toHaveLength(1);
    const created = fake.calls.find((c) => c.method === "POST" && c.path === "/api/sessions")!;
    expect((created.body as { title: string }).title).toMatch(/^Agent HQ \d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
    await until(() => chat.view.title === "Agent HQ · halo hermes");
    expect(fake.sessions[0].title).toBe("Agent HQ · halo hermes");
    expect(streams()[0]).toMatchObject({ body: { message: "halo hermes" }, auth: `Bearer ${fake.key}` });
    expect(items()).toEqual([
      ["user", "halo hermes"],
      ["tool", "uname -a", "ok"],
      ["assistant", "Halo!"],
    ]);
    // the first piece opens the text item, the rest arrive as deltas
    expect(events).toContainEqual({ type: "chat_item", item: expect.objectContaining({ kind: "assistant", text: "Ha", streaming: true }) });
    expect(events.filter((e) => e.type === "chat_delta").map((e) => e.type === "chat_delta" && e.delta)).toEqual(["lo"]);
    expect(events.filter((e) => e.type === "chat_state").map((e) => e.type === "chat_state" && e.phase)).toEqual(expect.arrayContaining(["starting", "running", "idle"]));
    expect(chat.view.sessionId).toBe(fake.sessions[0].id);
    await send("lagi");
    await idle();
    expect(fake.sessions).toHaveLength(1); // same conversation
    expect(fake.calls.filter((c) => c.method === "PATCH")).toHaveLength(1); // named once
  });

  it("the chat moves the session's character in the office, even without the Hermes hook", async () => {
    await send("halo hermes");
    await idle();
    const id = hermesAgentId(fake.sessions[0].id);
    expect(chat.view.agentId).toBe(id);
    const mine = office.filter((e) => e.id === id && e.type === "agent_update").map((e) => e.status);
    expect(mine).toEqual(["idle", "thinking", "working", "idle"]);
    expect(office.find((e) => e.id === id)).toMatchObject({ name: "Hermes", role: "Chat Hermes" });
    expect(hub.agents.get(id)).toMatchObject({ name: "Hermes", status: "idle", task: "Menunggu pesan berikutnya" });
    expect(office.some((e) => e.type === "task_done" || e.type === "log")).toBe(false); // no double confetti or logs next to the hook
  });

  it("refuses empty, too long, busy, and unknown actions", async () => {
    let release: (() => void) | null = null;
    fake.script = async (t) => {
      t.send("run.started");
      await new Promise<void>((r) => (release = r));
      t.send("run.completed");
      t.send("done");
    };
    expect((await send("   ")).status).toBe(400);
    expect((await send("x".repeat(8001))).status).toBe(413);
    expect((await chatAction({ action: "rm" })).status).toBe(400);
    expect((await send("a")).status).toBe(202);
    await until(() => release !== null);
    expect((await send("b")).status).toBe(409);
    expect((await chatAction({ action: "new" })).status).toBe(409);
    expect((await chatAction({ action: "open", sessionId: "api_x" })).status).toBe(409);
    release!();
    await idle();
    expect((await chatAction({ action: "new" })).status).toBe(200);
    expect(chat.view.items).toEqual([]);
  });

  it("redacts what the panel shows; Hermes gets the message as typed", async () => {
    fake.script = async (t) => {
      t.send("run.started");
      t.send("assistant.delta", { delta: "pakai Bearer abcdefghijklmnop" });
      t.send("run.completed");
      t.send("done");
    };
    await send("simpan token=rahasia123 ya");
    await idle();
    expect(lastStreamBody()).toEqual({ message: "simpan token=rahasia123 ya" });
    expect(items()).toEqual([
      ["user", "simpan token=*** ya"],
      ["assistant", "pakai Bearer ***"],
    ]);
    await until(() => fake.sessions[0].title === "Agent HQ · simpan token=*** ya"); // the title is redacted too
  });
});

describe("approvals", () => {
  const approvalScript = (box: { got: Record<string, unknown> | null }) => async (t: Parameters<FakeHermes["script"]>[0]) => {
    t.send("run.started");
    box.got = await t.approval();
    t.send("assistant.completed", { content: "selesai" });
    t.send("run.completed");
    t.send("done");
  };

  it("older gateway: choice plus the request id from the event", async () => {
    const box = { got: null as Record<string, unknown> | null };
    fake.script = approvalScript(box);
    await send("hapus folder");
    await until(() => chat.view.phase === "approval");
    expect(chat.view.items.find((i) => i.kind === "approval")).toMatchObject({ command: "rm -r /tmp/x", choices: ["once", "session", "always", "deny"], status: "pending" });
    expect(hub.agents.get(chat.view.agentId!)).toMatchObject({ status: "waiting", task: "Minta izin: rm -r /tmp/x" });
    expect((await chatAction({ action: "approve", choice: "selamanya" })).status).toBe(400);
    expect((await chatAction({ action: "approve", choice: "once" })).status).toBe(200);
    await idle();
    expect(box.got).toEqual({ choice: "once", request_id: expect.stringMatching(/^prm_/) });
    expect(items()).toEqual([
      ["user", "hapus folder"],
      ["approval", "once"],
      ["assistant", "selesai"],
    ]);
  });

  it("canonical gateway: exact prompt id and generation from the run status", async () => {
    fake.canonical = true;
    const box = { got: null as Record<string, unknown> | null };
    fake.script = approvalScript(box);
    await send("hapus folder");
    await until(() => chat.view.phase === "approval");
    expect((await chatAction({ action: "approve", choice: "deny" })).status).toBe(200);
    await idle();
    expect(box.got).toEqual({ request_id: expect.stringMatching(/^prm_/), execution_generation: 7, choice: "deny" });
  });

  it("an unanswered request expires when the turn ends", async () => {
    fake.script = async (t) => {
      t.send("run.started");
      void t.approval();
      t.send("run.completed");
      t.send("done");
    };
    await send("x");
    await idle();
    expect(chat.view.items.find((i) => i.kind === "approval")).toMatchObject({ status: "expired" });
    expect((await chatAction({ action: "approve", choice: "once" })).status).toBe(409);
  });
});

describe("stop and failures", () => {
  it("stop asks Hermes to stop the run", async () => {
    fake.script = async (t) => {
      t.send("run.started");
      t.send("tool.started", { tool_name: "terminal", preview: "sleep 100" });
      await t.stopped;
      t.send("run.cancelled", { interrupted: true });
      t.send("done");
    };
    await send("tidur");
    await until(() => chat.view.items.some((i) => i.kind === "tool"));
    expect((await chatAction({ action: "stop" })).status).toBe(202);
    await idle();
    expect(fake.calls.some((c) => /\/v1\/runs\/run_\d+\/stop$/.test(c.path))).toBe(true);
    expect(items().slice(1)).toEqual([
      ["tool", "sleep 100", "error"],
      ["note", "Dihentikan."],
    ]);
    expect((await chatAction({ action: "stop" })).status).toBe(409);
  });

  it("stop before the run started drops the stream", async () => {
    let gone = false;
    fake.script = async (t) => {
      await t.gone;
      gone = true;
    };
    await send("x");
    expect((await chatAction({ action: "stop" })).status).toBe(202);
    await idle();
    await until(() => gone);
    expect(items().at(-1)).toEqual(["note", "Dihentikan."]);
  });

  it("a dropped connection ends the turn with a note", async () => {
    fake.script = async (t) => {
      t.send("run.started");
      t.send("tool.started", { tool_name: "terminal", preview: "make" });
      await new Promise((r) => setTimeout(r, 30));
      t.drop();
    };
    await send("x");
    await idle();
    expect(items().slice(1)).toEqual([
      ["tool", "make", "error"],
      ["note", "Koneksi ke Hermes terputus di tengah jalan. Hermes biasanya ikut menghentikan pekerjaannya."],
    ]);
    expect(hub.agents.get(chat.view.agentId!)).toMatchObject({ status: "error" });
  });

  it("a session deleted in Hermes is replaced", async () => {
    chat.view.sessionId = "api_hilang";
    chat.resumed = Promise.resolve();
    expect((await send("halo")).status).toBe(202);
    await idle();
    expect(chat.view.sessionId).toBe(fake.sessions[0].id);
    expect(items()).toContainEqual(["note", "Sesi lama tidak ada lagi di Hermes, jadi percakapan baru dimulai."]);
  });

  it("a refused title falls back to an untitled session", async () => {
    fake.rejectTitle = true;
    await send("halo");
    await idle();
    await until(() => fake.calls.filter((c) => c.method === "PATCH").length === 2); // topic, then topic + time
    expect(fake.sessions).toEqual([{ id: expect.any(String), title: null }]);
  });

  it("wrong key, busy Hermes, Hermes down", async () => {
    fake.streamStatus = 401;
    let r = await send("a");
    expect(r.status).toBe(502);
    expect(r.body.error).toMatch(/Kunci API ditolak Hermes/);
    expect(chat.view.phase).toBe("idle");
    expect(chat.view.items.at(-1)).toMatchObject({ kind: "note", tone: "error" });
    fake.streamStatus = 429;
    expect((await send("b")).status).toBe(429);
    process.env.HQ_HERMES_API_URL = "http://127.0.0.1:1";
    resetChat();
    r = await send("c");
    expect(r.status).toBe(502);
    expect(r.body.error).toMatch(/tidak bisa dihubungi di http:\/\/127\.0\.0\.1:1/);
  });
});

describe("resume after a restart", () => {
  it("continues the newest Agent HQ session with its history and its character", async () => {
    fake.sessions.push({ id: "api_old", title: "Agent HQ 2026-11-03 10:00:00" }, { id: "api_tg", title: "Telegram" });
    fake.messages.set("api_old", [
      { id: 4, role: "assistant", content: "Disk / terpakai 41%", timestamp: 1793700004 },
      { id: 1, role: "user", content: "cek disk", timestamp: 1793700001 },
      { id: 2, role: "assistant", content: "", tool_calls: [{ function: { name: "terminal", arguments: '{"command":"df -h"}' } }], timestamp: 1793700002 },
      { id: 3, role: "tool", content: "Filesystem ...", timestamp: 1793700003 },
      { id: 5, role: "session_meta", content: null },
    ]);
    await resumeLatest();
    expect(chat.view).toMatchObject({ sessionId: "api_old", title: "Agent HQ 2026-11-03 10:00:00", agentId: hermesAgentId("api_old") });
    expect(items()).toEqual([
      ["user", "cek disk"],
      ["tool", "df -h", "ok"],
      ["assistant", "Disk / terpakai 41%"],
    ]);
    expect(events.at(-1)?.type).toBe("chat_snapshot");
    expect(hub.agents.get(hermesAgentId("api_old"))).toMatchObject({ name: "Hermes", status: "idle" });
    await send("lagi");
    await idle();
    expect(fake.calls.some((c) => c.path === "/api/sessions/api_old/chat/stream")).toBe(true);
    expect(fake.sessions).toHaveLength(2); // nothing new created
    expect(fake.calls.some((c) => c.method === "PATCH")).toBe(false); // a resumed session keeps its title
  });

  it("picks the most recently active one", async () => {
    fake.sessions.push(
      { id: "api_a", title: "Agent HQ · lama", last_active: 1793700000 },
      { id: "api_b", title: "Agent HQ · baru dipakai", last_active: 1793790000 },
      { id: "api_c", title: "Agent HQ · tengah", last_active: 1793750000 },
    );
    await resumeLatest();
    expect(chat.view.sessionId).toBe("api_b");
  });

  it("an explicit new conversation is not replaced by the old one", async () => {
    fake.sessions.push({ id: "api_old", title: "Agent HQ 2026-11-03 10:00:00" });
    expect((await chatAction({ action: "new" })).status).toBe(200);
    await send("mulai baru");
    await idle();
    expect(chat.view.sessionId).not.toBe("api_old");
  });
});

describe("new session with its own character", () => {
  it("creates the session right away; the character walks in named, the previous one leaves", async () => {
    await send("halo");
    await idle();
    const first = chat.view.agentId!;
    const r = await chatAction({ action: "new", agent: { name: "  Budi ", role: "Analis SOC", team: "blue" } });
    expect(r).toMatchObject({ status: 200, body: { ok: true, sessionId: expect.stringMatching(/^api_/) } });
    const sid = r.body.sessionId as string;
    const id = hermesAgentId(sid);
    expect(chat.view).toMatchObject({ sessionId: sid, agentId: id, items: [] });
    expect(office).toContainEqual(expect.objectContaining({ type: "remove", id: first }));
    expect(hub.agents.has(first)).toBe(false);
    expect(hub.agents.get(id)).toMatchObject({ name: "Budi", role: "Analis SOC", team: "blue", status: "idle" });
    // pinned like a roster rename, so later hook events cannot overwrite it
    expect(json(namesFile).agents[id]).toMatchObject({ name: "Budi", role: "Analis SOC", team: "blue" });
    // Hermes learns who it is in this session, on every turn, without touching its memory or transcript
    await send("siapa kamu?");
    await idle();
    expect(lastStreamBody()).toEqual({ message: "siapa kamu?", system_message: personaPrompt(id) });
    expect(personaPrompt(id)).toContain('bernama "Budi" dengan peran "Analis SOC" di tim Blue Team');
    await until(() => chat.view.title === "Agent HQ · siapa kamu?");
  });

  it("refuses a bad character; no character means an unnamed Hermes and no persona", async () => {
    expect((await chatAction({ action: "new", agent: { name: "x".repeat(61) } })).status).toBe(400);
    expect((await chatAction({ action: "new", agent: { team: "purple" } })).status).toBe(400);
    expect((await chatAction({ action: "new", agent: "Budi" })).status).toBe(400);
    expect(fake.sessions).toHaveLength(0);
    expect((await chatAction({ action: "new" })).status).toBe(200);
    expect(hub.agents.get(chat.view.agentId!)).toMatchObject({ name: "Hermes", role: "Chat Hermes" });
    expect(hub.overrides.has(chat.view.agentId!)).toBe(false);
    expect(personaPrompt(chat.view.agentId)).toBe("");
    // a default team with an empty name and role still gets the default identity
    expect((await chatAction({ action: "new", agent: { name: "", role: "", team: "red" } })).status).toBe(200);
    expect(hub.agents.get(chat.view.agentId!)).toMatchObject({ name: "Hermes", role: "Chat Hermes", team: "red" });
  });

  it("the character's id is the one the Hermes hook gives the session (hq_common.agent_id)", () => {
    expect(hermesAgentId("20260225_143052_a1b2c3")).toBe("cc-bf2b0385");
    expect(hermesAgentId("api_1")).toBe("cc-1c012687");
  });

  it("Hermes down: nothing changes", async () => {
    await send("halo");
    await idle();
    const before = chat.view.sessionId;
    process.env.HQ_HERMES_API_URL = "http://127.0.0.1:1";
    const r = await chatAction({ action: "new", agent: { name: "Budi" } });
    expect(r.status).toBe(502);
    expect(chat.view.sessionId).toBe(before);
  });
});

describe("Riwayat", () => {
  it("lists API server sessions, newest activity first, without hidden, archived, internal or foreign ones", async () => {
    fake.sessions.push(
      { id: "api_a", title: "Agent HQ · cek disk", last_active: 1793700000, message_count: 4, preview: "cek  disk\npakai password=abc123" },
      { id: "api_b", title: "Agent HQ · deploy", last_active: 1793790000, message_count: 2 },
      { id: "api_h", title: "x", hidden: true },
      { id: "api_r", title: "y", archived: true },
      { id: "api_k", title: "z", is_internal_child: true },
      { id: "tg_1", title: "Telegram", source: "telegram" },
    );
    hub.overrides.set(hermesAgentId("api_a"), { name: "Budi" });
    const r = await chatAction({ action: "sessions" });
    expect(r.status).toBe(200);
    const rows = r.body.sessions as ChatSession[];
    expect(rows.map((s) => s.id)).toEqual(["api_b", "api_a"]);
    expect(rows[1]).toEqual({ id: "api_a", title: "Agent HQ · cek disk", preview: "cek disk pakai password=***", lastActive: 1793700000000, messages: 4, agent: "Budi" });
    expect(fake.calls.at(-1)?.path).toBe("/api/sessions?source=api_server&limit=50");
    expect(r.body).toMatchObject({ current: null, now: expect.any(Number) }); // server clock for "5 mnt lalu"
  });

  it("sessionRows: ms or seconds, string times, and no time at all", () => {
    const rows = sessionRows([{ id: "a", last_active: 1793700000123 }, { id: "b", started_at: "2026-11-04T10:00:00Z" }, { id: "c" }, { id: "" }, "x"]);
    expect(rows.map((r) => [r.id, r.row.lastActive])).toEqual([["b", Date.parse("2026-11-04T10:00:00Z")], ["a", 1793700000123], ["c", null]]);
  });

  it("open: continues an old session with its history, model and character", async () => {
    await send("halo");
    await idle();
    const first = chat.view.agentId!;
    fake.sessions.push({ id: "api_old", title: "Agent HQ · cek disk" });
    fake.messages.set("api_old", [{ id: 1, role: "user", content: "cek disk" }, { id: 2, role: "assistant", content: "41%" }]);
    fs.writeFileSync(prefsFile, JSON.stringify({ version: 1, sessions: { api_old: { model: { provider: "openrouter", model: "m-1" }, updatedAt: "2026-11-04T00:00:00Z" } } }));
    resetChat(); // re-reads the model file, like a restart
    subscribeChat((e) => events.push(e));
    chat.resumed = Promise.resolve();
    expect((await chatAction({ action: "open", sessionId: "api_old" })).status).toBe(200);
    expect(chat.view).toMatchObject({ sessionId: "api_old", title: "Agent HQ · cek disk", agentId: hermesAgentId("api_old"), model: { provider: "openrouter", model: "m-1" } });
    expect(items()).toEqual([
      ["user", "cek disk"],
      ["assistant", "41%"],
    ]);
    expect(hub.agents.has(hermesAgentId("api_old"))).toBe(true);
    expect(hub.agents.has(first)).toBe(true); // a reset chat no longer knew the first character: it stays
    await send("lagi");
    await idle();
    expect(streams().at(-1)).toMatchObject({ path: "/api/sessions/api_old/chat/stream", body: { message: "lagi", model: "m-1", provider: "openrouter" } });
  });

  it("open: refuses other surfaces' sessions, missing ones and bad ids", async () => {
    fake.sessions.push({ id: "tg_1", title: "Telegram", source: "telegram" });
    const r = await chatAction({ action: "open", sessionId: "tg_1" });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/Sesi dari telegram tidak bisa dilanjutkan/);
    expect((await chatAction({ action: "open", sessionId: "api_nope" })).status).toBe(404);
    expect((await chatAction({ action: "open", sessionId: "a\nb" })).status).toBe(400);
    expect((await chatAction({ action: "open" })).status).toBe(400);
    expect(chat.view.sessionId).toBeNull();
  });

  it("rename keeps the Agent HQ prefix; a taken title is refused", async () => {
    await send("halo");
    await idle();
    await until(() => chat.view.title === "Agent HQ · halo");
    const sid = chat.view.sessionId!;
    expect(await chatAction({ action: "rename", title: "  Audit   nginx " })).toMatchObject({ status: 200, body: { title: "Agent HQ · Audit nginx" } });
    expect(fake.sessions[0].title).toBe("Agent HQ · Audit nginx");
    expect(chat.view.title).toBe("Agent HQ · Audit nginx");
    fake.sessions.push({ id: "api_x", title: "Agent HQ · dipakai" });
    const r = await chatAction({ action: "rename", sessionId: sid, title: "dipakai" });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/Judul ditolak Hermes/);
    expect((await chatAction({ action: "rename", sessionId: "api_x", title: "lain" })).status).toBe(200);
    expect(chat.view.title).toBe("Agent HQ · Audit nginx"); // another session: the open one is untouched
    expect((await chatAction({ action: "rename", title: " " })).status).toBe(400);
    expect((await chatAction({ action: "rename", title: "x".repeat(81) })).status).toBe(400);
    expect((await chatAction({ action: "rename", sessionId: "api_nope", title: "a" })).status).toBe(404);
  });

  it("delete: the open session goes with its character, pinned name and model; a running one is refused", async () => {
    expect((await chatAction({ action: "new", agent: { name: "Budi" }, model: { provider: "p", model: "m" } })).status).toBe(200);
    const sid = chat.view.sessionId!;
    const id = chat.view.agentId!;
    expect(json(prefsFile).sessions[sid]).toMatchObject({ model: { provider: "p", model: "m" } });
    let release: (() => void) | null = null;
    fake.script = async (t) => {
      t.send("run.started");
      await new Promise<void>((r) => (release = r));
      t.send("run.completed");
      t.send("done");
    };
    await send("kerja");
    await until(() => release !== null);
    expect((await chatAction({ action: "delete", sessionId: sid })).status).toBe(409);
    release!();
    await idle();
    expect((await chatAction({ action: "delete", sessionId: sid })).status).toBe(200);
    expect(fake.sessions.some((s) => s.id === sid)).toBe(false);
    expect(chat.view).toMatchObject({ sessionId: null, agentId: null, items: [], model: { provider: "p", model: "m" } });
    expect(hub.agents.has(id)).toBe(false);
    expect(json(namesFile).agents[id]).toBeUndefined();
    expect(json(prefsFile).sessions[sid]).toBeUndefined();
    expect((await chatAction({ action: "delete", sessionId: "api_gone" })).status).toBe(200); // already gone is fine
  });

  it("delete another session: the open one stays", async () => {
    await send("halo");
    await idle();
    fake.sessions.push({ id: "api_x", title: "Agent HQ · lain" });
    expect((await chatAction({ action: "delete", sessionId: "api_x" })).status).toBe(200);
    expect(chat.view.sessionId).toBe(fake.sessions[0].id);
    expect(chat.view.items).toHaveLength(3);
  });
});

describe("models", () => {
  const options = {
    model: "anthropic/claude-sonnet-5.5",
    provider: "openrouter",
    providers: [
      { slug: "openrouter", name: "OpenRouter", is_current: true, authenticated: true, models: ["anthropic/claude-sonnet-5.5", "x-ai/grok-5", "x-ai/grok-5"] },
      { slug: "nous", name: "Nous Portal", authenticated: false, models: ["hermes-5"] },
      { slug: "empty", name: "Kosong", models: [] },
      { slug: "custom", models: [{ id: "llama-local" }, "bad\nid"] },
    ],
  };

  it("lists authenticated providers with models, Hermes' default, and whether memory is on", async () => {
    fake.modelOptions = options;
    fake.toolsets = [
      { name: "memory", enabled: true, tools: ["memory"] },
      { name: "session_search", enabled: false, tools: ["session_search"] },
    ];
    const r = await chatAction({ action: "models" });
    expect(r.body).toEqual({
      ok: true,
      current: { provider: "openrouter", model: "anthropic/claude-sonnet-5.5" },
      providers: [
        { slug: "openrouter", name: "OpenRouter", current: true, models: ["anthropic/claude-sonnet-5.5", "x-ai/grok-5"] },
        { slug: "custom", name: "custom", current: false, models: ["llama-local"] },
      ],
      memory: true,
      sessionSearch: false,
    });
    expect(fake.calls.some((c) => c.path === "/api/model/options?include_unconfigured=false")).toBe(true);
    // cached for a minute; refresh asks Hermes to probe again
    const before = fake.calls.length;
    await chatAction({ action: "models" });
    expect(fake.calls.length).toBe(before);
    await chatAction({ action: "models", refresh: true });
    expect(fake.calls.some((c) => c.path === "/api/model/options?include_unconfigured=false&refresh=1")).toBe(true);
  });

  it("an older Hermes without the list: an error to show, not a failure; memory unknown", async () => {
    const r = await chatAction({ action: "models" });
    expect(r).toMatchObject({ status: 200, body: { ok: true, providers: [], memory: null, sessionSearch: null, error: expect.stringMatching(/belum punya daftar model/) } });
    expect(chat.models).toBeNull(); // asked again next time
  });

  it("the model of a session goes with every message, survives a restart, and carries into a new session", async () => {
    expect((await chatAction({ action: "model", model: { provider: "openrouter", model: "x-ai/grok-5" } })).status).toBe(200);
    expect(events.at(-1)).toMatchObject({ type: "chat_state", model: { provider: "openrouter", model: "x-ai/grok-5" } });
    await send("halo");
    await idle();
    const sid = chat.view.sessionId!;
    expect(lastStreamBody()).toEqual({ message: "halo", model: "x-ai/grok-5", provider: "openrouter" });
    expect(json(prefsFile).sessions[sid].model).toEqual({ provider: "openrouter", model: "x-ai/grok-5" });
    expect((await chatAction({ action: "new" })).status).toBe(200); // carries the open session's model
    expect(chat.view.model).toEqual({ provider: "openrouter", model: "x-ai/grok-5" });
    expect((await chatAction({ action: "new", model: null })).status).toBe(200); // Hermes' default
    expect(chat.view.model).toBeNull();
    await send("lagi");
    await idle();
    expect(lastStreamBody()).toEqual({ message: "lagi" });
    expect((await chatAction({ action: "model", model: { model: "" } })).status).toBe(400);
    expect((await chatAction({ action: "model" })).status).toBe(400);
    expect((await chatAction({ action: "model", model: { provider: "a\nb", model: "m" } })).status).toBe(400);
    expect((await chatAction({ action: "new", model: "gpt" })).status).toBe(400);
  });

  it("shows which model answered", async () => {
    fake.script = async (t) => {
      t.send("run.started");
      t.send("assistant.completed", { content: "ok", runtime: { provider: "openrouter", model: "x-ai/grok-5", route_source: "raw_request" } });
      t.send("run.completed", { runtime: { provider: "openrouter", model: "x-ai/grok-5" } });
      t.send("done");
    };
    await send("halo");
    await idle();
    expect(chat.view.runtime).toEqual({ provider: "openrouter", model: "x-ai/grok-5" });
  });

  it("modelProviders caps and cleans", () => {
    expect(modelProviders(null)).toEqual({ current: null, providers: [] });
    const many = { providers: Array.from({ length: 50 }, (_, i) => ({ slug: `p${i}`, models: ["m"] })) };
    expect(modelProviders(many).providers).toHaveLength(40);
  });
});

describe("context compression moves the conversation", () => {
  it("follows the new session id with the character, its pinned name and the model", async () => {
    expect((await chatAction({ action: "new", agent: { name: "Budi", role: "SRE" }, model: { provider: "p", model: "m" } })).status).toBe(200);
    const sid = chat.view.sessionId!;
    const from = chat.view.agentId!;
    fake.script = async (t) => {
      t.send("run.started");
      t.send("assistant.completed", { content: "ringkas", session_id: "api_tip" });
      t.send("run.completed", { session_id: "api_tip" });
      t.send("done");
    };
    await send("lanjut");
    await idle();
    const to = hermesAgentId("api_tip");
    expect(chat.view).toMatchObject({ sessionId: "api_tip", agentId: to });
    expect(hub.agents.has(from)).toBe(false);
    expect(hub.agents.get(to)).toMatchObject({ name: "Budi", role: "SRE", status: "idle" });
    expect(json(prefsFile).sessions.api_tip.model).toEqual({ provider: "p", model: "m" });
    expect(sid).not.toBe("api_tip");
    fake.sessions.push({ id: "api_tip", title: "Agent HQ · lanjut" });
    fake.script = helloTurn;
    await send("lagi");
    await idle();
    expect(streams().at(-1)?.path).toBe("/api/sessions/api_tip/chat/stream");
  });

  it("the same id is not a move", () => {
    chat.view.sessionId = "api_1";
    handleHermesEvent("run.completed", { session_id: "api_1" });
    handleHermesEvent("run.completed", { session_id: "" });
    expect(chat.view.sessionId).toBe("api_1");
  });
});

describe("helpers", () => {
  it("toolPreview and historyItems", () => {
    expect(toolPreview(null, '{"path":"/etc/hosts"}')).toBe("/etc/hosts");
    expect(toolPreview("git push https://budi:rahasia@git.example/x", null)).toBe("git push https://budi:***@git.example/x");
    expect(toolPreview("", { a: 1, b: "teks" })).toBe("teks");
    expect(historyItems([{ id: 1, role: "user", content: [{ type: "text", text: "lihat" }, { type: "image_url" }] }, { id: 2, role: "user", content: "x", display_kind: "hidden" }]).map(brief)).toEqual([["user", "lihat\n[gambar]"]]);
  });

  it("topicOf: one redacted line, cut short", () => {
    expect(topicOf("cek\n  disk   penuh")).toBe("cek disk penuh");
    expect(topicOf("token=abc " + "x".repeat(80))).toMatch(/^token=\*\*\* x+…$/);
    expect(topicOf("a".repeat(200)).length).toBe(48);
  });
});
