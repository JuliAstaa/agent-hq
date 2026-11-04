import { discussionSnapshot, subscribeDiscussions } from "@/lib/bridge/discussions";
import { chatGuard } from "@/lib/bridge/hermes-chat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(req: Request) {
  const denied = chatGuard(req, false);
  if (denied) return denied;
  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (event: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      const off = subscribeDiscussions(send);
      send({ type: "discussion_snapshot", rooms: discussionSnapshot() });
      const ping = setInterval(() => { try { controller.enqueue(encoder.encode(": ping\n\n")); } catch { cleanup(); } }, 15_000);
      cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(ping);
        off();
        req.signal.removeEventListener("abort", cleanup);
        try { controller.close(); } catch {}
      };
      req.signal.addEventListener("abort", cleanup, { once: true });
      if (req.signal.aborted) cleanup();
    },
    cancel() { cleanup(); },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" } });
}
