// Roster rename client (deviation 16): which endpoint it posts to, and live vs demo behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { eventUrlFor, renameAgent, setLiveUrlSource } from "@/lib/rename";

const stubStore = (mode: string) => {
  const applied: unknown[] = [];
  return { applied, store: { getState: () => ({ conn: { mode }, applyEvent: (ev: unknown) => applied.push(ev) }) } };
};

afterEach(() => {
  setLiveUrlSource(() => null);
  vi.unstubAllGlobals();
});

describe("eventUrlFor", () => {
  it("puts /event next to the stream, keeping host and /api prefix", () => {
    const base = "http://localhost:8787/";
    expect(eventUrlFor("/api/stream", base)).toBe("http://localhost:8787/api/event");
    expect(eventUrlFor("/stream", base)).toBe("http://localhost:8787/event");
    expect(eventUrlFor("http://10.0.0.5:9000/stream?x=1", base)).toBe("http://10.0.0.5:9000/event");
    expect(eventUrlFor("ws://localhost:9000/socket", base)).toBeNull();
    expect(eventUrlFor("http://localhost:8787/other", base)).toBeNull();
    expect(eventUrlFor(null, base)).toBeNull();
  });
});

describe("renameAgent", () => {
  it("live: posts a rename event to the bridge", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    setLiveUrlSource(() => "http://localhost:8787/api/stream");
    const { store, applied } = stubStore("live");
    expect(await renameAgent(store, "cc-ab12cd34", { name: "Rexx", team: "red" })).toEqual({ ok: true, local: false });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:8787/api/event");
    expect(JSON.parse(init.body as string)).toEqual({ type: "rename", id: "cc-ab12cd34", name: "Rexx", team: "red" });
    expect(applied).toEqual([]);
  });

  it("live: shows the bridge's error, and a clear message for a token-protected bridge", async () => {
    setLiveUrlSource(() => "/api/stream");
    const { store } = stubStore("live");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: false, error: "Agen tidak ditemukan" }), { status: 404 })));
    expect(await renameAgent(store, "x", { name: "Y" })).toEqual({ ok: false, error: "Agen tidak ditemukan" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 401 })));
    const r = await renameAgent(store, "x", { name: "Y" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/HQ_TOKEN/);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await renameAgent(store, "x", { name: "Y" })).toMatchObject({ ok: false });
  });

  it("demo (or no bridge): changes this screen only; no team means the office desk", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { store, applied } = stubStore("demo");
    expect(await renameAgent(store, "zorp", { name: "Zed", role: "Coder", team: null })).toEqual({ ok: true, local: true });
    expect(applied).toEqual([{ type: "agent_update", id: "zorp", name: "Zed", role: "Coder", team: "office" }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
