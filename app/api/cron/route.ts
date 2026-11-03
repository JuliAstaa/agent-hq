// POST /api/cron: a control command from the office's schedule panel, {"action": "run"|"pause"|"resume", "job": id}.
// Queued for the schedule source (examples/hermes/hq_cron.py), which runs it. No CORS headers and no OPTIONS
// handler on purpose: other websites in the viewer's browser must not be able to trigger jobs.
import { authorized, readBody } from "@/lib/bridge/auth";
import { crossSite, enqueueCommand } from "@/lib/bridge/cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (status: number, body: unknown) => Response.json(body, { status });

export async function POST(req: Request) {
  if (crossSite(req)) return json(403, { ok: false, error: "Ditolak: permintaan dari situs lain" });
  if (!authorized(req)) return json(401, { ok: false, error: "token salah" });
  if (!/^application\/json\b/i.test(req.headers.get("content-type") || "")) return json(415, { ok: false, error: "content-type harus application/json" });
  let body: unknown;
  try {
    body = JSON.parse(await readBody(req, 4096));
  } catch {
    return json(400, { ok: false, error: "body bukan JSON" });
  }
  const r = enqueueCommand(body);
  return json(r.status, r.body);
}
