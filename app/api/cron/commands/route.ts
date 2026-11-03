// GET /api/cron/commands?wait=20: the schedule source long-polls for queued commands (up to 25 s).
import { authorized } from "@/lib/bridge/auth";
import { takeCommands, waitForCommands } from "@/lib/bridge/cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!authorized(req)) return Response.json({ ok: false, error: "token salah" }, { status: 401 });
  const wait = Math.max(0, Math.min(25, Number(new URL(req.url).searchParams.get("wait")) || 0));
  await waitForCommands(wait * 1000, req.signal);
  return Response.json({ ok: true, commands: takeCommands() }, { headers: { "Cache-Control": "no-store" } });
}
