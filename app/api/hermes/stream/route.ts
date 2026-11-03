// GET /api/hermes/stream: the Hermes chat for the panel as Server-Sent Events: a chat_snapshot, then chat_item /
// chat_delta / chat_state as the conversation moves (lib/bridge/hermes-chat.ts). Same guard as POST /api/hermes;
// the panel reads it with fetch() so HQ_TOKEN goes in a header, never in the URL. No CORS.
import { chatGuard, chatSnapshot, resumeLatest, subscribeChat } from "@/lib/bridge/hermes-chat";
import type { ChatEvent } from "@/lib/hermes-chat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = chatGuard(req, false);
  if (denied) return denied;
  const enc = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      const write = (s: string) => ctrl.enqueue(enc.encode(s));
      const send = (ev: ChatEvent) => write(`data: ${JSON.stringify(ev)}\n\n`);
      write("retry: 2000\n\n");
      send({ type: "chat_snapshot", view: chatSnapshot() });
      const unsubscribe = subscribeChat(send);
      void resumeLatest(); // first viewer after a restart: continue the newest Agent HQ session (sends a snapshot)
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
        unsubscribe();
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
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
