import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { discussionAction, discussionSnapshot, discussions, ensureDiscussions, resetDiscussions, subscribeDiscussions } from "@/lib/bridge/discussions";
import { chat, chatAction, hermesAgentId, resetChat } from "@/lib/bridge/hermes-chat";
import { hub, publish, reloadOverrides, resetHub } from "@/lib/bridge/hub";
import { createHQStore } from "@/lib/store";
import { readDiscussion, type DiscussionParticipant, type DiscussionView } from "@/lib/discussions";
import { startFakeHermes, type FakeHermes } from "../helpers/fake-hermes-api";

let fake: FakeHermes;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "hq-meetings-"));
const keys = ["HQ_HERMES_API_KEY", "HQ_HERMES_API_URL", "HQ_HERMES_CHAT_FILE", "HQ_STATE_FILE", "HQ_MEETINGS_FILE"] as const;
const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
const until = async (check: () => boolean) => {
  const end = Date.now() + 5000;
  while (!check()) { if (Date.now() > end) throw new Error("condition timed out"); await new Promise((r) => setTimeout(r, 10)); }
};
const create = async (name: string, model?: unknown) => {
  const result = await discussionAction({ action: "create_agent", agent: { name, role: `${name} reviewer`, team: "office" }, model });
  expect(result.status).toBe(200);
  return result.body.participant as DiscussionParticipant;
};
const start = (participants: DiscussionParticipant[], extra: Record<string, unknown> = {}) => discussionAction({ action: "start", room: 0, goal: "Rancang rilis", sessions: participants.map((p) => p.sessionId), rounds: 1, ...extra });
const end = () => until(() => discussions.jobs.size === 0);

beforeAll(async () => { fake = await startFakeHermes(); });
beforeEach(() => {
  resetDiscussions(); resetChat(); resetHub();
  reloadOverrides(path.join(temp, "names.json"));
  process.env.HQ_STATE_FILE = "0";
  process.env.HQ_HERMES_API_KEY = fake.key;
  process.env.HQ_HERMES_API_URL = fake.url;
  process.env.HQ_HERMES_CHAT_FILE = path.join(temp, "models.json");
  fake.calls.length = 0; fake.sessions.length = 0; fake.messages.clear(); fake.streamStatus = 0;
  fake.script = async (t) => {
    t.send("run.started");
    t.send("assistant.delta", { delta: `Pendapat ${t.sessionId}` });
    t.send("assistant.completed", { content: `Pendapat ${t.sessionId}` });
    t.send("run.completed"); t.send("done");
  };
});
afterEach(async () => {
  for (const job of discussions.jobs.values()) await discussionAction({ action: "stop", room: job.view.room, id: job.view.id });
  await end(); resetDiscussions(); resetChat(); resetHub();
});
afterAll(async () => {
  for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  reloadOverrides(); await fake.close(); fs.rmSync(temp, { recursive: true, force: true });
});

describe("manual discussions", () => {
  it("creates a real agent in the background with its identity and model, without switching ordinary chat", async () => {
    await chatAction({ action: "new", agent: { name: "Chat biasa" } });
    const selected = chat.view.sessionId;
    const p = await create("Arsitek", { provider: "test", model: "reasoner" });
    expect(chat.view.sessionId).toBe(selected);
    expect(fake.sessions).toHaveLength(2);
    expect(p).toMatchObject({ name: "Arsitek", role: "Arsitek reviewer", model: { provider: "test", model: "reasoner" } });
    expect(hub.agents.get(p.agentId)).toMatchObject({ name: "Arsitek", status: "idle" });
    expect(chat.sessions.get(p.sessionId)?.view.model?.model).toBe("reasoner");
    expect((await discussionAction({ action: "create_agent", agent: { name: "x".repeat(61) } })).status).toBe(400);
    expect(fake.sessions).toHaveLength(2);
  });

  it("forwards real answers between participants, uses each model, finishes within the round limit, and retains the chat", async () => {
    const original = fake.script;
    fake.script = async (t) => {
      t.send("run.started"); t.send("assistant.delta", { delta: "Sedang berdiskusi" });
      await new Promise((r) => setTimeout(r, 90));
      await original(t);
    };
    const a = await create("Arsitek", { model: "model-a" }), b = await create("Penguji", { model: "model-b" });
    const seen: DiscussionView[] = [];
    const off = subscribeDiscussions((e) => seen.push(e.view));
    const started = await start([a, b]);
    expect(started.status).toBe(202);
    await end(); off();
    const calls = fake.calls.filter((c) => c.path.endsWith("/chat/stream"));
    expect(calls).toHaveLength(3); // two opinions and the facilitator's summary
    expect(calls[0]).toMatchObject({ body: { model: "model-a" } });
    expect(calls[1]).toMatchObject({ body: { model: "model-b", message: expect.stringContaining(`Pendapat ${a.sessionId}`) } });
    expect(calls[2]).toMatchObject({ body: { message: expect.stringContaining(`Pendapat ${b.sessionId}`) } });
    const view = discussionSnapshot()[0];
    expect(view.phase).toBe("done"); expect(view.round).toBe(1);
    expect(view.messages.filter((m) => m.kind === "agent")).toHaveLength(2);
    expect(view.summary).toContain(`Pendapat ${a.sessionId}`);
    expect(seen.some((v) => v.messages.some((m) => m.streaming))).toBe(true);
    for (const p of [a, b]) {
      expect(chat.sessions.get(p.sessionId)?.meetingOwner).toBeNull();
      expect(hub.agents.has(p.agentId)).toBe(true);
    }
    expect(chat.view.sessionId).toBeNull();
  });

  it("pins idle participants to the selected room and releases them at the end without creating a fake agent", async () => {
    const store = createHQStore();
    hub.subs.add((event) => store.getState().applyEvent(event));
    const a = await create("A"), b = await create("B");
    const first = start([a, b], { room: 2 });
    await first;
    expect(store.getState().agents.get(b.agentId)?.meeting).toMatchObject({ room: 2, seat: 1, discussionId: discussions.rooms.get(2)!.id });
    await end();
    expect(store.getState().agents.size).toBe(2);
    expect(store.getState().agents.get(a.agentId)?.meeting).toBeNull();
    expect(store.getState().discussions[0].phase).toBe("done");
    expect(readDiscussion({ room: 8 })).toBeNull();
    store.getState().applyEvent({ type: "meeting_state", discussion: { room: 8 } });
    expect(store.getState().agents.size).toBe(2);
  });

  it("locks participants against overlapping meetings and ordinary messages; new directions reach the next speaker; stop is scoped", async () => {
    fake.script = async (t) => {
      t.send("run.started"); t.send("assistant.delta", { delta: "Masih berdiskusi" });
      await t.stopped; t.send("run.cancelled"); t.send("done");
    };
    const a = await create("A"), b = await create("B"), c = await create("C"), d = await create("D");
    expect((await start([a, b])).status).toBe(202);
    expect((await start([a, c], { room: 1 })).status).toBe(409);
    expect((await chatAction({ action: "send", sessionId: a.sessionId, text: "bentrok" })).status).toBe(409);
    expect((await chatAction({ action: "delete", sessionId: b.sessionId })).status).toBe(409);
    expect((await start([c, d], { room: 1 })).status).toBe(202);
    const view = discussionSnapshot().find((v) => v.room === 0)!;
    expect((await discussionAction({ action: "message", room: 0, id: view.id, text: "Utamakan pengujian" })).status).toBe(200);
    expect((await discussionAction({ action: "stop", room: 0, id: "stale" })).status).toBe(409);
    await discussionAction({ action: "stop", room: 0, id: view.id });
    await until(() => !discussions.jobs.has(0));
    expect(discussions.jobs.has(1)).toBe(true);
    expect(discussionSnapshot().find((v) => v.room === 0)?.phase).toBe("stopped");
  });

  it("delivers an interjection to the next participant and keeps redaction in both streamed and saved messages", async () => {
    const a = await create("A"), b = await create("B");
    let finishFirst!: () => void;
    const hold = new Promise<void>((r) => { finishFirst = r; });
    fake.script = async (t) => {
      t.send("run.started");
      if (t.sessionId === a.sessionId && !String(t.message).includes("Sebagai fasilitator")) await hold;
      t.send("assistant.completed", { content: "Usulan token=sk-live-rahasia0123456789" });
      t.send("run.completed"); t.send("done");
    };
    await start([a, b]);
    const id = discussionSnapshot()[0].id;
    await discussionAction({ action: "message", room: 0, id, text: "Prioritaskan tes regresi" });
    finishFirst(); await end();
    const second = fake.calls.filter((c) => c.path.endsWith("/chat/stream"))[1];
    expect(second.body).toMatchObject({ message: expect.stringContaining("Prioritaskan tes regresi") });
    expect(JSON.stringify(discussionSnapshot())).not.toContain("sk-live-rahasia");
  });

  it("rejects occupied rooms and invalid participants, and marks a failed run without making a summary", async () => {
    const a = await create("A"), b = await create("B");
    publish({ type: "agent_update", id: "leader", status: "working" });
    publish({ type: "agent_update", id: "sub", parent: "leader", status: "working" });
    expect((await start([a, b])).status).toBe(409);
    expect((await start([a, a], { room: 1 })).status).toBe(400);
    expect((await start([a, b], { room: 1, rounds: 10 })).status).toBe(400);
    fake.script = async (t) => { t.send("run.started"); t.send("run.failed", { error: "Provider gagal" }); t.send("done"); };
    await start([a, b], { room: 1 }); await end();
    expect(discussionSnapshot().find((v) => v.room === 1)).toMatchObject({ phase: "error", summary: "" });
    expect(fake.calls.filter((c) => c.path.endsWith("/chat/stream"))).toHaveLength(1);
  });

  it("persists the transcript and treats an interrupted restart as an error without replaying any model call", async () => {
    process.env.HQ_STATE_FILE = path.join(temp, "state.json");
    process.env.HQ_MEETINGS_FILE = path.join(temp, "meetings.json");
    const a = await create("A"), b = await create("B");
    await start([a, b]); await end();
    const file = process.env.HQ_MEETINGS_FILE;
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(stored.rooms[0].messages).toHaveLength(3);
    stored.rooms[0].phase = "running";
    fs.writeFileSync(file, JSON.stringify(stored));
    const calls = fake.calls.length;
    resetDiscussions(); ensureDiscussions();
    expect(discussionSnapshot()[0]).toMatchObject({ phase: "error", error: expect.stringContaining("Server dimulai ulang") });
    expect(fake.calls).toHaveLength(calls);
    expect(hermesAgentId(a.sessionId)).toBe(a.agentId);
  });

  it("loads existing sessions after a restart without selecting a conversation in the ordinary panel", async () => {
    const a = await create("A"), b = await create("B");
    chat.sessions.clear(); chat.resumed = null;
    await start([a, b]); await end();
    expect(chat.view.sessionId).toBeNull();
    expect(discussionSnapshot()[0].phase).toBe("done");
  });

  it("routes approval to the speaking participant and resumes the discussion after the user's choice", async () => {
    const a = await create("A"), b = await create("B");
    let first = true;
    fake.script = async (t) => {
      t.send("run.started");
      if (first) { first = false; await t.approval({ command: "cek akses", choices: ["once", "deny"] }); }
      t.send("assistant.completed", { content: "Pendapat setelah izin" });
      t.send("run.completed"); t.send("done");
    };
    await start([a, b]);
    await until(() => discussionSnapshot()[0].phase === "approval");
    const view = discussionSnapshot()[0];
    const m = view.messages.find((m) => m.approval?.status === "pending")!;
    expect((await discussionAction({ action: "approve", room: 0, id: view.id, sessionId: b.sessionId, itemId: m.approval!.itemId, choice: "once" })).status).toBe(409);
    expect((await discussionAction({ action: "approve", room: 0, id: view.id, sessionId: a.sessionId, itemId: m.approval!.itemId, choice: "once" })).status).toBe(200);
    await end();
    expect(discussionSnapshot()[0].messages.find((item) => item.id === m.id)?.approval?.status).toBe("once");
    expect(discussionSnapshot()[0].phase).toBe("done");
  });
});
