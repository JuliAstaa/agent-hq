// Hermes chat, panel side: lib/hermes-chat.ts (events -> view), lib/sse.ts (stream frames), lib/api-url.ts.
import { describe, expect, it } from "vitest";
import { siblingApiUrl } from "@/lib/api-url";
import { cronUrlFor } from "@/lib/cron";
import {
  MAX_CHAT_ITEMS, MAX_CHAT_TEXT, appendCapped, applyChatEvent, emptyChatView, hermesUrlFor, upsertItem, type ChatItem,
} from "@/lib/hermes-chat";
import { sseFrames } from "@/lib/sse";

const user = (id: string, text = "hai"): ChatItem => ({ kind: "user", id, text, at: 1 });

describe("applyChatEvent", () => {
  it("snapshot, item upsert, delta, state", () => {
    let v = emptyChatView();
    v = applyChatEvent(v, { type: "chat_snapshot", view: { ...emptyChatView(), sessionId: "s1", items: [user("u1")] } });
    expect(v.sessionId).toBe("s1");
    v = applyChatEvent(v, { type: "chat_item", item: { kind: "assistant", id: "m1", text: "Ha", streaming: true, at: 2 } });
    v = applyChatEvent(v, { type: "chat_delta", id: "m1", delta: "lo" });
    expect(v.items[1]).toMatchObject({ text: "Halo", streaming: true });
    v = applyChatEvent(v, { type: "chat_item", item: { kind: "assistant", id: "m1", text: "Halo!", streaming: false, at: 2 } });
    expect(v.items).toHaveLength(2);
    expect(v.items[1]).toMatchObject({ text: "Halo!", streaming: false });
    v = applyChatEvent(v, { type: "chat_state", phase: "running", thinking: true, sessionId: "s1", title: "Agent HQ x" });
    expect(v).toMatchObject({ phase: "running", thinking: true, title: "Agent HQ x" });
  });
  it("a delta for an unknown or non-text item is ignored", () => {
    const v = applyChatEvent({ ...emptyChatView(), items: [user("u1")] }, { type: "chat_delta", id: "u1", delta: "x" });
    expect(v.items[0]).toMatchObject({ text: "hai" });
    expect(applyChatEvent(v, { type: "chat_delta", id: "nope", delta: "x" })).toBe(v);
  });
  it("caps items and text", () => {
    let items: ChatItem[] = [];
    for (let i = 0; i < MAX_CHAT_ITEMS + 5; i++) items = upsertItem(items, user(`u${i}`));
    expect(items).toHaveLength(MAX_CHAT_ITEMS);
    expect(items[0].id).toBe("u5");
    expect(appendCapped("x".repeat(MAX_CHAT_TEXT - 1), "abc")).toHaveLength(MAX_CHAT_TEXT);
  });
});

describe("URLs next to the live stream", () => {
  it("/api/stream -> /api/hermes and /api/cron, nothing for other streams", () => {
    expect(hermesUrlFor("/api/stream", "http://localhost:8787/")).toBe("http://localhost:8787/api/hermes");
    expect(cronUrlFor("http://127.0.0.1:9787/api/stream?x=1", "http://localhost/")).toBe("http://127.0.0.1:9787/api/cron");
    expect(hermesUrlFor("/stream", "http://localhost/")).toBeNull();
    expect(siblingApiUrl("ws://h/api/stream", "http://localhost/", "hermes")).toBeNull();
    expect(siblingApiUrl(null, "http://localhost/", "hermes")).toBeNull();
  });
});

describe("sseFrames", () => {
  const body = (...chunks: string[]) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const s of chunks) c.enqueue(new TextEncoder().encode(s));
        c.close();
      },
    });
  it("frames split across chunks, CRLF, comments, multi-line data", async () => {
    const out = [];
    for await (const f of sseFrames(body(": keepalive\n\nevent: run.sta", "rted\ndata: {\"a\":1}\n", "\nevent: x\r\ndata: l1\r\ndata: l2\r\n\r\n", "data: tail\n\n"))) out.push(f);
    expect(out).toEqual([
      { event: "run.started", data: '{"a":1}' },
      { event: "x", data: "l1\nl2" },
      { event: "", data: "tail" },
    ]);
  });
});
