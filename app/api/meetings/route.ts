import { readBody } from "@/lib/bridge/auth";
import { discussionAction, discussionSnapshot } from "@/lib/bridge/discussions";
import { chatGuard } from "@/lib/bridge/hermes-chat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const json = (status: number, body: unknown) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
export function GET(req: Request) {
  return chatGuard(req, false) ?? json(200, { ok: true, rooms: discussionSnapshot() });
}
export async function POST(req: Request) {
  const denied = chatGuard(req, true);
  if (denied) return denied;
  let body: unknown;
  try { body = JSON.parse(await readBody(req, 32_000)); }
  catch { return json(400, { ok: false, error: "body bukan JSON" }); }
  const r = await discussionAction(body);
  return json(r.status, r.body);
}
