// Terminal button (docs/terminal.md): which HQ_TERMINAL_URL values turn it on, where the office asks for it, and
// the GET /api/terminal answer.

import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/terminal/route";
import { terminalApiUrlFor, terminalUrl } from "@/lib/terminal";

describe("terminalUrl", () => {
  it("accepts http and https addresses", () => {
    expect(terminalUrl("http://localhost:7681")).toBe("http://localhost:7681/");
    expect(terminalUrl("  https://term.example.com/hq/  ")).toBe("https://term.example.com/hq/");
  });

  it("is off when unset, empty or not a string", () => {
    for (const v of [undefined, null, "", "   ", 7681, {}]) expect(terminalUrl(v)).toBeNull();
  });

  it("refuses other schemes and bad URLs", () => {
    for (const v of ["javascript:alert(1)", "data:text/html,hi", "ftp://localhost:7681", "file:///etc/passwd", "localhost:7681", "not a url", "ws://localhost:7681"]) {
      expect(terminalUrl(v)).toBeNull();
    }
  });

  it("refuses a password in the URL (it would reach the browser)", () => {
    expect(terminalUrl("http://hq:secret@localhost:7681")).toBeNull();
    expect(terminalUrl("http://hq@localhost:7681")).toBeNull();
  });
});

describe("terminalApiUrlFor", () => {
  const base = "http://localhost:9787/";

  it("sits next to the live /api/stream", () => {
    expect(terminalApiUrlFor("/api/stream", base)).toBe("http://localhost:9787/api/terminal");
    expect(terminalApiUrlFor("http://127.0.0.1:8787/api/stream?x=1", base)).toBe("http://127.0.0.1:8787/api/terminal");
  });

  it("is null off the Next.js server", () => {
    expect(terminalApiUrlFor(null, base)).toBeNull();
    expect(terminalApiUrlFor("/stream", base)).toBeNull(); // prototype bridge (examples/server.js)
    expect(terminalApiUrlFor("ws://localhost:8787/api/stream", base)).toBeNull();
  });
});

describe("GET /api/terminal", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("answers the address from HQ_TERMINAL_URL, uncached", async () => {
    vi.stubEnv("HQ_TERMINAL_URL", "http://localhost:7681");
    const res = GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(await res.json()).toEqual({ ok: true, url: "http://localhost:7681/" });
  });

  it("answers null when unset or invalid", async () => {
    vi.stubEnv("HQ_TERMINAL_URL", "");
    expect(await GET().json()).toEqual({ ok: true, url: null });
    vi.stubEnv("HQ_TERMINAL_URL", "http://hq:secret@localhost:7681");
    expect(await GET().json()).toEqual({ ok: true, url: null });
  });
});
