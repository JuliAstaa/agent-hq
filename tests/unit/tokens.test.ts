import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readTranscriptTokens, resetTokens, safeTranscript, transcriptFor, updateTokensFromHook } from "@/lib/bridge/tokens";

let root: string;
let outside: string;
const SID = "5f3c9a1e-7b2d-4c11-9e0f-0123456789ab";

const assistant = (id: string, u: Partial<Record<string, number>>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "assistant", requestId: "req_" + id, message: { id, role: "assistant", usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0, ...u } }, ...extra }) + "\n";
const user = (text: string) => JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n";

beforeEach(() => {
  resetTokens();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hq-tok-root-"));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), "hq-tok-out-"));
});
afterEach(() => {
  resetTokens();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
  vi.useRealTimers();
});

function transcript(name = `proj/${SID}.jsonl`) {
  const f = path.join(root, name);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, "");
  return f;
}

describe("readTranscriptTokens", () => {
  it("sums all four usage fields, once per message id", () => {
    const f = transcript();
    fs.appendFileSync(f, user("hi") + assistant("m1", { input_tokens: 10, cache_creation_input_tokens: 200, cache_read_input_tokens: 3000, output_tokens: 40 }));
    // the same reply split over two more lines (thinking + tool_use blocks) repeats the usage
    fs.appendFileSync(f, assistant("m1", { input_tokens: 10, cache_creation_input_tokens: 200, cache_read_input_tokens: 3000, output_tokens: 40 }).repeat(2));
    expect(readTranscriptTokens(f)).toEqual({ total: 3250, more: false });
  });

  it("is cumulative and incremental: new turns add on top, old lines are not re-read", () => {
    const f = transcript();
    fs.appendFileSync(f, assistant("m1", { input_tokens: 100, output_tokens: 50 }));
    expect(readTranscriptTokens(f).total).toBe(150);
    fs.appendFileSync(f, user("lanjut") + assistant("m2", { input_tokens: 20, cache_read_input_tokens: 1000, output_tokens: 5 }));
    expect(readTranscriptTokens(f).total).toBe(1175);
    expect(readTranscriptTokens(f).total).toBe(1175);
  });

  it("handles a line split across reads and multi-byte characters at the boundary", () => {
    const f = transcript();
    const line = assistant("mé", { input_tokens: 7, output_tokens: 3 }, { note: "ñandú 🚀" });
    const bytes = Buffer.from(line);
    fs.appendFileSync(f, bytes.subarray(0, 40));
    expect(readTranscriptTokens(f).total).toBeNull();
    fs.appendFileSync(f, bytes.subarray(40));
    expect(readTranscriptTokens(f).total).toBe(10);
  });

  it("reads big files in capped chunks", () => {
    const f = transcript();
    let body = "";
    for (let i = 0; i < 200; i++) body += assistant("m" + i, { input_tokens: 1, output_tokens: 1 });
    fs.writeFileSync(f, body);
    let r = readTranscriptTokens(f, 1000);
    let steps = 1;
    while (r.more) {
      r = readTranscriptTokens(f, 1000);
      steps++;
    }
    expect(steps).toBeGreaterThan(5);
    expect(r.total).toBe(400);
  });

  it("ignores garbage and unknown formats (no usage -> null, nothing reported)", () => {
    const f = transcript();
    fs.appendFileSync(f, "not json\n" + user("x") + JSON.stringify({ message: { usage: { input_tokens: "12" } } }) + "\n" + JSON.stringify({ usage: { input_tokens: 5 } }) + "\n");
    expect(readTranscriptTokens(f).total).toBeNull();
  });

  it("starts over when the file is rewritten shorter", () => {
    const f = transcript();
    fs.appendFileSync(f, assistant("m1", { output_tokens: 500 }) + assistant("m2", { output_tokens: 500 }));
    expect(readTranscriptTokens(f).total).toBe(1000);
    fs.writeFileSync(f, assistant("n1", { output_tokens: 7 }));
    expect(readTranscriptTokens(f).total).toBe(7);
  });
});

describe("safeTranscript (path comes from the request body)", () => {
  it("accepts .jsonl files inside an allowed root", () => {
    const f = transcript();
    expect(safeTranscript(f, [root])).toBe(fs.realpathSync(f));
  });
  it("rejects files outside the roots, traversal, non-jsonl, relative paths, directories, missing files", () => {
    const f = transcript();
    const out = path.join(outside, "x.jsonl");
    fs.writeFileSync(out, assistant("m", { output_tokens: 1 }));
    expect(safeTranscript(out, [root])).toBeNull();
    expect(safeTranscript(path.join(root, "proj", "..", "..", path.basename(outside), "x.jsonl"), [root])).toBeNull();
    expect(safeTranscript(f.replace(/\.jsonl$/, ".json"), [root])).toBeNull();
    expect(safeTranscript("proj/a.jsonl", [root])).toBeNull();
    fs.mkdirSync(path.join(root, "dir.jsonl"));
    expect(safeTranscript(path.join(root, "dir.jsonl"), [root])).toBeNull();
    expect(safeTranscript(path.join(root, "nope.jsonl"), [root])).toBeNull();
    expect(safeTranscript(42, [root])).toBeNull();
  });
  it("rejects a symlink inside the root that points outside", () => {
    const out = path.join(outside, "secret.jsonl");
    fs.writeFileSync(out, "");
    const link = path.join(root, "link.jsonl");
    fs.symlinkSync(out, link);
    expect(safeTranscript(link, [root])).toBeNull();
  });
});

describe("transcriptFor", () => {
  it("main session -> transcript_path; subagent -> agent_transcript_path or derived subagents/ file", () => {
    const main = `/r/proj/${SID}.jsonl`;
    expect(transcriptFor({ transcript_path: main })).toBe(main);
    expect(transcriptFor({ transcript_path: main, agent_id: "a1", agent_transcript_path: "/r/x.jsonl" })).toBe("/r/x.jsonl");
    expect(transcriptFor({ transcript_path: main, agent_id: "ae0f8a26" })).toBe(path.join("/r/proj", SID, "subagents", "agent-ae0f8a26.jsonl"));
    expect(transcriptFor({ transcript_path: main, agent_id: "agent-abc123" })).toBe(path.join("/r/proj", SID, "subagents", "agent-abc123.jsonl"));
    expect(transcriptFor({ agent_id: "a1" })).toBeNull();
  });
});

describe("updateTokensFromHook", () => {
  it("publishes the total for the hook's agent id, only when it changed", () => {
    const f = transcript();
    fs.appendFileSync(f, assistant("m1", { input_tokens: 10, output_tokens: 5 }));
    const pub = vi.fn();
    const h = { hook_event_name: "PreToolUse", session_id: SID, transcript_path: f };
    updateTokensFromHook(h, pub, [root]);
    expect(pub).toHaveBeenCalledWith({ type: "agent_update", id: "cc-5f3c9a1e", tokens: 15 });
    updateTokensFromHook(h, pub, [root]);
    expect(pub).toHaveBeenCalledTimes(1);
    fs.appendFileSync(f, assistant("m2", { output_tokens: 85 }));
    updateTokensFromHook({ ...h, hook_event_name: "UserPromptSubmit" }, pub, [root]);
    expect(pub).toHaveBeenLastCalledWith({ type: "agent_update", id: "cc-5f3c9a1e", tokens: 100 });
  });

  it("subagent usage goes to the subagent's id, not the main session", () => {
    const main = transcript();
    fs.appendFileSync(main, assistant("m1", { output_tokens: 1000 }));
    const sub = transcript(`proj/${SID}/subagents/agent-ae0f8a26ac659a4b4.jsonl`);
    fs.appendFileSync(sub, assistant("s1", { input_tokens: 30, output_tokens: 12 }));
    const pub = vi.fn();
    updateTokensFromHook({ hook_event_name: "PreToolUse", session_id: SID, agent_id: "ae0f8a26ac659a4b4", transcript_path: main }, pub, [root]);
    expect(pub).toHaveBeenCalledWith({ type: "agent_update", id: "cc-5f3c9a-ae0f8a26", tokens: 42 });
  });

  it("re-reads shortly after Stop, because the transcript lags the hook", () => {
    vi.useFakeTimers();
    const f = transcript();
    fs.appendFileSync(f, assistant("m1", { output_tokens: 10 }));
    const pub = vi.fn();
    updateTokensFromHook({ hook_event_name: "Stop", session_id: SID, transcript_path: f }, pub, [root]);
    expect(pub).toHaveBeenLastCalledWith(expect.objectContaining({ tokens: 10 }));
    fs.appendFileSync(f, assistant("m2", { output_tokens: 90 }));
    vi.advanceTimersByTime(1600);
    expect(pub).toHaveBeenLastCalledWith(expect.objectContaining({ tokens: 100 }));
  });

  it("does nothing for paths outside the roots or missing files", () => {
    const pub = vi.fn();
    updateTokensFromHook({ hook_event_name: "Stop", session_id: SID, transcript_path: "/etc/passwd" }, pub, [root]);
    updateTokensFromHook({ hook_event_name: "Stop", session_id: SID, transcript_path: path.join(root, "missing.jsonl") }, pub, [root]);
    expect(pub).not.toHaveBeenCalled();
  });
});
