// GET /api/hermes: whether the Hermes chat is configured ({"enabled"}), so the office can show its button.
// POST /api/hermes: a chat action from the panel, {"action": "send" | "approve" | "stop" | "new", ...}
// (lib/bridge/hermes-chat.ts). No CORS headers and no OPTIONS handler on purpose: a message to Hermes can run
// anything Hermes' tools can run, so only the office itself may post here (chatGuard).
import { readBody } from "@/lib/bridge/auth";
import { chatAction, chatConfig, chatGuard } from "@/lib/bridge/hermes-chat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (status: number, body: unknown) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export function GET() {
  return json(200, { ok: true, enabled: chatConfig().enabled });
}

export async function POST(req: Request) {
  const denied = chatGuard(req, true);
  if (denied) return denied;
  let body: unknown;
  try {
    body = JSON.parse(await readBody(req, 64_000));
  } catch {
    return json(400, { ok: false, error: "body bukan JSON" });
  }
  const r = await chatAction(body);
  return json(r.status, r.body);
}
