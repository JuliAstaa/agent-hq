// POST /api/cron/result: the schedule source reports how a command went, {"id", "ok": bool, "message"}.
import { authorized, readBody } from "@/lib/bridge/auth";
import { finishCommand } from "@/lib/bridge/cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!authorized(req)) return Response.json({ ok: false, error: "token salah" }, { status: 401 });
  let body: unknown;
  try {
    body = JSON.parse(await readBody(req, 8192));
  } catch {
    return Response.json({ ok: false, error: "body bukan JSON" }, { status: 400 });
  }
  const r = finishCommand(body);
  return Response.json(r.body, { status: r.status });
}
