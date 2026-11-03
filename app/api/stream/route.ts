// GET /api/stream: Server-Sent Events. New viewers get a snapshot, then the last 30 log/finding/alert
// events with _replay: true (so alerts do not re-trigger the siren), then live events.
import { CORS_HEADERS, preflight } from "@/lib/bridge/auth";
import { scheduleForViewer } from "@/lib/bridge/cron";
import { hub, type BridgeEvent } from "@/lib/bridge/hub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const enc = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      const write = (s: string) => ctrl.enqueue(enc.encode(s));
      const send = (ev: BridgeEvent) => write(`data: ${JSON.stringify(ev)}\n\n`);
      write("retry: 2000\n\n");
      send({ type: "snapshot", agents: [...hub.agents.values()] });
      const schedule = scheduleForViewer(); // scheduled jobs (not in the prototype)
      if (schedule) send(schedule);
      for (const ev of hub.recent.slice(-30)) send({ ...ev, _replay: true });
      hub.subs.add(send);
      const ping = setInterval(() => {
        try {
          write(": ping\n\n");
        } catch {
          cleanup();
        }
      }, 15000);
      let done = false;
      cleanup = () => {
        if (done) return;
        done = true;
        clearInterval(ping);
        hub.subs.delete(send);
        try {
          ctrl.close();
        } catch {}
      };
      req.signal.addEventListener("abort", () => cleanup());
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: {
      ...CORS_HEADERS,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

export const OPTIONS = preflight;
