// Token usage per Claude Code session, read from the session transcript (prd.md M2; requested by the user
// 2026-11-03: count every token type, cumulative per session, so it keeps growing when the session continues).
//
// Hooks carry `transcript_path` (main session) and, on SubagentStop, `agent_transcript_path`
// (<session>/subagents/agent-<agent_id>.jsonl). The transcript format is NOT documented by Claude Code, so parsing
// is defensive: only lines with a numeric `message.usage` count, and if nothing matches no event is sent.
// Observed format: one JSON object per line; an assistant reply can span several lines that repeat the same
// `message.id` and identical `usage`, so usage is counted once per message id.
//
// Safety: the path comes from the request body. Only `.jsonl` files whose real path (symlinks resolved) is inside
// an allowed root are read (default ~/.claude/projects and $CLAUDE_CONFIG_DIR/projects; override with
// HQ_TRANSCRIPT_ROOTS, path-delimiter separated). Reads are incremental and capped per call; only numbers leave.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { hookAgentId, type HookPayload } from "./hooks";
import type { BridgeEvent } from "./hub";

export const USAGE_FIELDS = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"] as const;

const CHUNK = 4 * 1024 * 1024; // bytes parsed per step (keeps the event loop responsive on big transcripts)
const MAX_LINE = 8 * 1024 * 1024; // a "line" longer than this without a newline is dropped
const REREAD_AFTER_STOP_MS = 1500; // transcripts are written asynchronously and can lag the Stop hook

interface FileState {
  offset: number;
  decoder: StringDecoder;
  tail: string;
  /** message id -> tokens counted for it */
  msgs: Map<string, number>;
  total: number;
}

interface TokenState {
  files: Map<string, FileState>;
  /** agent id -> last total sent */
  reported: Map<string, number>;
  timers: Map<string, ReturnType<typeof setTimeout>>;
}

const g = globalThis as unknown as { __hqTokens?: TokenState };
const state: TokenState = (g.__hqTokens ??= { files: new Map(), reported: new Map(), timers: new Map() });

export function transcriptRoots(): string[] {
  const env = process.env.HQ_TRANSCRIPT_ROOTS;
  if (env) return env.split(path.delimiter).filter(Boolean).map((r) => path.resolve(r));
  const roots = [path.join(os.homedir(), ".claude", "projects")];
  if (process.env.CLAUDE_CONFIG_DIR) roots.push(path.join(process.env.CLAUDE_CONFIG_DIR, "projects"));
  return roots;
}

/** Real path of an allowed, existing transcript file, else null. */
export function safeTranscript(p: unknown, roots = transcriptRoots()): string | null {
  if (typeof p !== "string" || !p.endsWith(".jsonl")) return null;
  const expanded = p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
  if (!path.isAbsolute(expanded)) return null;
  try {
    const real = fs.realpathSync(expanded);
    if (!fs.statSync(real).isFile()) return null;
    for (const r of roots) {
      let rr: string;
      try {
        rr = fs.realpathSync(r);
      } catch {
        continue;
      }
      if (real.startsWith(rr + path.sep)) return real;
    }
  } catch {}
  return null;
}

/** Transcript that holds the usage of the agent a hook payload belongs to. */
export function transcriptFor(h: HookPayload): unknown {
  if (!h.agent_id) return h.transcript_path;
  if (h.agent_transcript_path) return h.agent_transcript_path;
  // Inside a running subagent only the main transcript is given; its own file is <session>/subagents/agent-<id>.jsonl.
  if (typeof h.transcript_path !== "string" || !h.transcript_path.endsWith(".jsonl")) return null;
  const aid = String(h.agent_id);
  return path.join(h.transcript_path.slice(0, -".jsonl".length), "subagents", `${aid.startsWith("agent-") ? aid : "agent-" + aid}.jsonl`);
}

function lineTokens(line: string): { id: string; tokens: number } | null {
  if (!line.includes('"usage"')) return null;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  const msg = o && typeof o === "object" ? (o.message as Record<string, unknown> | undefined) : undefined;
  const usage = msg && typeof msg === "object" ? (msg.usage as Record<string, unknown> | undefined) : undefined;
  if (!usage || typeof usage !== "object") return null;
  let tokens = 0, numeric = false;
  for (const f of USAGE_FIELDS) {
    const v = usage[f];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
      tokens += v;
      numeric = true;
    }
  }
  if (!numeric) return null;
  const id = msg!.id ?? o.requestId ?? o.uuid;
  return id == null ? null : { id: String(id), tokens };
}

/**
 * Parse up to `maxBytes` new bytes of `file` and return the cumulative total (null if no usage was recognised yet)
 * and whether more bytes are waiting. A file that shrank (rewritten) is parsed again from the start.
 */
export function readTranscriptTokens(file: string, maxBytes = CHUNK): { total: number | null; more: boolean } {
  const size = fs.statSync(file).size;
  let st = state.files.get(file);
  if (!st || size < st.offset) {
    st = { offset: 0, decoder: new StringDecoder("utf8"), tail: "", msgs: new Map(), total: 0 };
    state.files.set(file, st);
  }
  const want = Math.min(maxBytes, size - st.offset);
  if (want > 0) {
    const buf = Buffer.alloc(want);
    const fd = fs.openSync(file, "r");
    let got = 0;
    try {
      got = fs.readSync(fd, buf, 0, want, st.offset);
    } finally {
      fs.closeSync(fd);
    }
    st.offset += got;
    const lines = (st.tail + st.decoder.write(buf.subarray(0, got))).split("\n");
    st.tail = lines.pop() ?? "";
    if (st.tail.length > MAX_LINE) st.tail = "";
    for (const line of lines) {
      const r = lineTokens(line);
      if (!r) continue;
      st.total += r.tokens - (st.msgs.get(r.id) ?? 0);
      st.msgs.set(r.id, r.tokens);
    }
  }
  return { total: st.msgs.size ? st.total : null, more: st.offset < size };
}

/** Read the agent's transcript and publish {type:"agent_update", id, tokens} when the total changed. */
export function updateTokensFromHook(h: HookPayload, publish: (ev: BridgeEvent) => void, roots?: string[]): void {
  const file = safeTranscript(transcriptFor(h), roots);
  if (!file) return;
  const id = hookAgentId(h);
  const step = () => {
    let r: { total: number | null; more: boolean };
    try {
      r = readTranscriptTokens(file);
    } catch {
      return; // unreadable right now: skip silently
    }
    if (r.more) {
      setImmediate(step);
      return;
    }
    if (r.total == null || state.reported.get(id) === r.total) return;
    state.reported.set(id, r.total);
    publish({ type: "agent_update", id, tokens: r.total });
  };
  step();
  if (h.hook_event_name === "Stop" || h.hook_event_name === "SubagentStop") {
    clearTimeout(state.timers.get(id));
    const t = setTimeout(() => {
      state.timers.delete(id);
      step();
    }, REREAD_AFTER_STOP_MS);
    t.unref?.();
    state.timers.set(id, t);
  }
}

/** Test helper. */
export function resetTokens(): void {
  for (const t of state.timers.values()) clearTimeout(t);
  state.files.clear();
  state.reported.clear();
  state.timers.clear();
}
