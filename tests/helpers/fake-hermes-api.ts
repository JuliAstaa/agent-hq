// A stand-in for the Hermes API server (gateway platform api_server) with the parts the chat bridge uses:
// sessions, the session chat stream, run status, approval, and stop. Each test scripts the turn.

import http from "node:http";
import type { AddressInfo } from "node:net";

export interface Call {
  method: string;
  path: string;
  auth: string;
  body: unknown;
}

export interface Turn {
  sessionId: string;
  runId: string;
  message: unknown;
  send(event: string, data?: Record<string, unknown>): void;
  /** Send approval.request and wait for POST /v1/runs/{id}/approval; resolves with its body. */
  approval(fields?: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Resolves when POST /v1/runs/{id}/stop arrives. */
  stopped: Promise<void>;
  /** Resolves when the client disconnects. */
  gone: Promise<void>;
  /** Cut the connection without ending the stream. */
  drop(): void;
}

export interface FakeHermes {
  url: string;
  key: string;
  calls: Call[];
  sessions: { id: string; title: string | null }[];
  messages: Map<string, unknown[]>;
  script: (t: Turn) => Promise<void>;
  /** Canonical session owner: approvals need {request_id, execution_generation, choice} exactly. */
  canonical: boolean;
  rejectTitle: boolean;
  /** Status code for every chat/stream request (e.g. 401, 429), 0 = normal. */
  streamStatus: number;
  close(): Promise<void>;
}

export const helloTurn = async (t: Turn) => {
  t.send("run.started", { user_message: { role: "user", content: t.message } });
  t.send("message.started", { message: { id: "msg_1", role: "assistant" } });
  t.send("tool.started", { tool_name: "terminal", preview: "uname -a", args: { command: "uname -a" } });
  t.send("tool.completed", { tool_name: "terminal", preview: null });
  t.send("assistant.delta", { delta: "Ha" });
  t.send("assistant.delta", { delta: "lo" });
  t.send("assistant.completed", { content: "Halo!", completed: true, partial: false, interrupted: false });
  t.send("run.completed", { completed: true });
  t.send("done", {});
};

export async function startFakeHermes(key = "kunci-uji-0123456789abcdef"): Promise<FakeHermes> {
  let n = 0;
  const runs = new Map<string, { pending: { prompt_id: string; resolve: (b: Record<string, unknown>) => void }[]; stop: () => void; generation: number }>();
  const fake: FakeHermes = {
    url: "",
    key,
    calls: [],
    sessions: [],
    messages: new Map(),
    script: helloTurn,
    canonical: false,
    rejectTitle: false,
    streamStatus: 0,
    close: async () => {},
  };
  const reply = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: unknown = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {}
    const u = new URL(req.url || "/", "http://x");
    const path = u.pathname;
    fake.calls.push({ method: req.method || "", path: path + u.search, auth: String(req.headers.authorization || ""), body });
    if (req.headers.authorization !== `Bearer ${fake.key}`) return reply(res, 401, { error: { message: "Invalid gateway API key (API_SERVER_KEY)" } });
    const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    let m: RegExpMatchArray | null;

    if (req.method === "GET" && path === "/api/sessions") return reply(res, 200, { object: "list", data: [...fake.sessions].reverse() });
    if (req.method === "POST" && path === "/api/sessions") {
      if (fake.rejectTitle && b.title) return reply(res, 400, { error: { message: "title taken" } });
      const s = { id: `api_${++n}`, title: typeof b.title === "string" ? b.title : null };
      fake.sessions.push(s);
      return reply(res, 201, { object: "hermes.session", session: s });
    }
    if (req.method === "GET" && (m = path.match(/^\/api\/sessions\/([^/]+)\/messages$/))) {
      return reply(res, 200, { object: "list", data: fake.messages.get(decodeURIComponent(m[1])) || [] });
    }
    if (req.method === "POST" && (m = path.match(/^\/api\/sessions\/([^/]+)\/chat\/stream$/))) {
      const sid = decodeURIComponent(m[1]);
      if (fake.streamStatus) return reply(res, fake.streamStatus, { error: { message: `status ${fake.streamStatus}` } });
      if (!fake.sessions.some((s) => s.id === sid)) return reply(res, 404, { error: { message: `Session not found: ${sid}` } });
      const runId = `run_${++n}`;
      let seq = 0;
      let stop = () => {};
      const stopped = new Promise<void>((r) => (stop = r));
      const run = { pending: [] as { prompt_id: string; resolve: (b: Record<string, unknown>) => void }[], stop, generation: 7 };
      runs.set(runId, run);
      res.writeHead(200, { "content-type": "text/event-stream", "x-hermes-session-id": sid });
      res.write(": keepalive\n\n");
      const gone = new Promise<void>((r) => res.on("close", () => r()));
      const turn: Turn = {
        sessionId: sid,
        runId,
        message: b.message,
        send(event, data = {}) {
          if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify({ ...data, session_id: sid, run_id: runId, seq: ++seq })}\n\n`);
        },
        approval(fields = {}) {
          const prompt_id = `prm_${++n}`;
          return new Promise((resolve) => {
            run.pending.push({ prompt_id, resolve });
            turn.send("approval.request", { command: "rm -r /tmp/x", description: "hapus folder", choices: ["once", "session", "always", "deny"], ...(fake.canonical ? {} : { request_id: prompt_id }), ...fields });
          });
        },
        stopped,
        gone,
        drop: () => res.socket?.destroy(),
      };
      try {
        await fake.script(turn);
      } finally {
        runs.delete(runId);
        if (!res.writableEnded) res.end();
      }
      return;
    }
    if (req.method === "GET" && (m = path.match(/^\/v1\/runs\/([^/]+)$/))) {
      const run = runs.get(m[1]);
      if (!run || !fake.canonical) return reply(res, 404, { error: { message: "Run not found" } });
      return reply(res, 200, { run_id: m[1], status: "waiting_for_approval", execution_generation: run.generation, pending_controls: run.pending.map((p) => ({ prompt_id: p.prompt_id, kind: "approval" })) });
    }
    if (req.method === "POST" && (m = path.match(/^\/v1\/runs\/([^/]+)\/approval$/))) {
      const run = runs.get(m[1]);
      if (!run || !run.pending.length) return reply(res, 409, { error: { message: "approval_not_pending" } });
      if (fake.canonical) {
        const keys = Object.keys(b).sort().join(",");
        if (keys !== "choice,execution_generation,request_id" || b.execution_generation !== run.generation) return reply(res, 400, { error: { message: "invalid_params" } });
      }
      const i = Math.max(0, run.pending.findIndex((p) => p.prompt_id === b.request_id));
      const [p] = run.pending.splice(i, 1);
      p.resolve(b);
      return reply(res, 200, { run_id: m[1], choice: b.choice });
    }
    if (req.method === "POST" && (m = path.match(/^\/v1\/runs\/([^/]+)\/stop$/))) {
      const run = runs.get(m[1]);
      if (!run) return reply(res, 409, { error: { message: "run_not_active" } });
      run.stop();
      return reply(res, 200, { run_id: m[1], status: "stopping" });
    }
    reply(res, 404, { error: { message: "no route" } });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () =>
    new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
  return fake;
}
