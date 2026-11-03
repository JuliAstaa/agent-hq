// Token totals end to end: POST /api/hook with a transcript_path -> agent_update {tokens} on /api/stream.
// Needs a production build (`npm run build`); skipped otherwise.

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
// A server build (not the static demo export, which also lives in .next) has the API route compiled.
const BUILT = fs.existsSync(path.join(ROOT, ".next/BUILD_ID")) && fs.existsSync(path.join(ROOT, ".next/server/app/api/hook"));
const SID = "7a1b2c3d-0000-4000-8000-000000000001";

const assistant = (id: string, input: number, output: number, cacheRead = 0) =>
  JSON.stringify({ type: "assistant", message: { id, role: "assistant", usage: { input_tokens: input, cache_creation_input_tokens: 0, cache_read_input_tokens: cacheRead, output_tokens: output } } }) + "\n";

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!BUILT)("token totals from transcripts", () => {
  let proc: ChildProcess;
  let base = "";
  let tmp = "";
  let transcript = "";

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hq-tok-int-"));
    transcript = path.join(tmp, "proj", `${SID}.jsonl`);
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, assistant("m1", 100, 20, 5000));
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    proc = spawn(process.execPath, [path.join(ROOT, "node_modules/next/dist/bin/next"), "start", "-H", "127.0.0.1", "-p", String(port)], {
      cwd: ROOT,
      env: { ...process.env, HQ_TRANSCRIPT_ROOTS: tmp, HQ_NAMES_FILE: path.join(tmp, "names.json"), HQ_TOKEN: "" },
      stdio: "ignore",
    });
    for (let i = 0; i < 200; i++) {
      try {
        if ((await fetch(base + "/api/health")).ok) return;
      } catch {}
      await sleep(150);
    }
    throw new Error("next start did not come up");
  }, 60000);

  afterAll(() => {
    proc?.kill();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("publishes and grows the cumulative total across turns", async () => {
    const frames: Record<string, unknown>[] = [];
    const ctrl = new AbortController();
    const reading = (async () => {
      try {
        const res = await fetch(base + "/api/stream", { signal: ctrl.signal });
        const reader = res.body!.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const f = buf.slice(0, i);
            buf = buf.slice(i + 2);
            if (f.startsWith("data: ")) frames.push(JSON.parse(f.slice(6)));
          }
        }
      } catch {}
    })();
    const hook = (body: Record<string, unknown>) =>
      fetch(base + "/api/hook", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_id: SID, cwd: "/x/proj", transcript_path: transcript, ...body }) });
    const tokens = () => frames.filter((f) => f.id === "cc-7a1b2c3d" && "tokens" in f && f.type === "agent_update").map((f) => f.tokens);

    await sleep(300);
    const r = await hook({ hook_event_name: "UserPromptSubmit", prompt: "hai" });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("");
    await sleep(500);
    expect(tokens()).toEqual([5120]);

    // Turn ends; the last reply lands in the transcript after the Stop hook (async write) -> re-read catches it.
    await hook({ hook_event_name: "Stop", last_assistant_message: "selesai" });
    fs.appendFileSync(transcript, assistant("m2", 10, 90));
    await sleep(2200);
    expect(tokens()).toEqual([5120, 5220]);

    // The session continues later: the total keeps growing instead of resetting.
    fs.appendFileSync(transcript, assistant("m3", 1, 1, 200));
    await hook({ hook_event_name: "UserPromptSubmit", prompt: "lanjut" });
    await sleep(500);
    expect(tokens()).toEqual([5120, 5220, 5422]);

    // New viewers get it in the snapshot.
    ctrl.abort();
    await reading;
    const snap = await fetch(base + "/api/stream");
    const reader = snap.body!.getReader();
    let text = "";
    while (!text.includes("snapshot")) text += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    expect(text).toContain('"tokens":5422');
  }, 30000);
});
