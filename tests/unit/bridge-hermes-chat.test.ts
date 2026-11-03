// Hermes chat, bridge side (lib/bridge/hermes-chat.ts) against a fake Hermes API server: the guard, one turn from
// message to final answer, approvals (legacy and canonical gateway), stop, errors, resume after a restart, redaction.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  chat, chatAction, chatConfig, chatGuard, historyItems, resetChat, resumeLatest, subscribeChat, toolPreview,
} from "@/lib/bridge/hermes-chat";
import type { ChatEvent, ChatItem } from "@/lib/hermes-chat";
import { helloTurn, startFakeHermes, type FakeHermes } from "../helpers/fake-hermes-api";

let fake: FakeHermes;
let events: ChatEvent[] = [];
const saved = { key: process.env.HQ_HERMES_API_KEY, url: process.env.HQ_HERMES_API_URL, token: process.env.HQ_TOKEN };

beforeAll(async () => {
  fake = await startFakeHermes();
  process.env.HQ_HERMES_API_KEY = fake.key;
  process.env.HQ_HERMES_API_URL = fake.url;
  delete process.env.HQ_TOKEN;
});
afterAll(async () => {
  resetChat();
  for (const [k, v] of [["HQ_HERMES_API_KEY", saved.key], ["HQ_HERMES_API_URL", saved.url], ["HQ_TOKEN", saved.token]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await fake.close();
});
beforeEach(() => {
  resetChat();
  Object.assign(fake, { script: helloTurn, canonical: false, rejectTitle: false, streamStatus: 0 });
  fake.calls.length = 0;
  fake.sessions.length = 0;
  fake.messages.clear();
  process.env.HQ_HERMES_API_URL = fake.url;
  events = [];
  subscribeChat((e) => events.push(e));
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
  it("creates a titled session, streams, shows the tool, keeps the final answer", async () => {
    const r = await send("halo hermes");
    expect(r.status).toBe(202);
    await idle();
    expect(fake.sessions).toHaveLength(1);
    expect(fake.sessions[0].title).toMatch(/^Agent HQ \d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
    const stream = fake.calls.find((c) => c.path.endsWith("/chat/stream"))!;
    expect(stream).toMatchObject({ body: { message: "halo hermes" }, auth: `Bearer ${fake.key}` });
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
    expect(fake.calls.find((c) => c.path.endsWith("/chat/stream"))!.body).toEqual({ message: "simpan token=rahasia123 ya" });
    expect(items()).toEqual([
      ["user", "simpan token=*** ya"],
      ["assistant", "pakai Bearer ***"],
    ]);
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
  it("continues the newest Agent HQ session with its history", async () => {
    fake.sessions.push({ id: "api_old", title: "Agent HQ 2026-11-03 10:00:00" }, { id: "api_tg", title: "Telegram" });
    fake.messages.set("api_old", [
      { id: 4, role: "assistant", content: "Disk / terpakai 41%", timestamp: 1793700004 },
      { id: 1, role: "user", content: "cek disk", timestamp: 1793700001 },
      { id: 2, role: "assistant", content: "", tool_calls: [{ function: { name: "terminal", arguments: '{"command":"df -h"}' } }], timestamp: 1793700002 },
      { id: 3, role: "tool", content: "Filesystem ...", timestamp: 1793700003 },
      { id: 5, role: "session_meta", content: null },
    ]);
    await resumeLatest();
    expect(chat.view).toMatchObject({ sessionId: "api_old", title: "Agent HQ 2026-11-03 10:00:00" });
    expect(items()).toEqual([
      ["user", "cek disk"],
      ["tool", "df -h", "ok"],
      ["assistant", "Disk / terpakai 41%"],
    ]);
    expect(events.at(-1)?.type).toBe("chat_snapshot");
    await send("lagi");
    await idle();
    expect(fake.calls.some((c) => c.path === "/api/sessions/api_old/chat/stream")).toBe(true);
    expect(fake.sessions).toHaveLength(2); // nothing new created
  });

  it("an explicit new conversation is not replaced by the old one", async () => {
    fake.sessions.push({ id: "api_old", title: "Agent HQ 2026-11-03 10:00:00" });
    expect((await chatAction({ action: "new" })).status).toBe(200);
    await send("mulai baru");
    await idle();
    expect(chat.view.sessionId).not.toBe("api_old");
  });
});

describe("helpers", () => {
  it("toolPreview and historyItems", () => {
    expect(toolPreview(null, '{"path":"/etc/hosts"}')).toBe("/etc/hosts");
    expect(toolPreview("git push https://budi:rahasia@git.example/x", null)).toBe("git push https://budi:***@git.example/x");
    expect(toolPreview("", { a: 1, b: "teks" })).toBe("teks");
    expect(historyItems([{ id: 1, role: "user", content: [{ type: "text", text: "lihat" }, { type: "image_url" }] }, { id: 2, role: "user", content: "x", display_kind: "hidden" }]).map(brief)).toEqual([["user", "lihat\n[gambar]"]]);
  });
});
