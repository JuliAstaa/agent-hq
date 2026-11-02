// GET /api/health: short status.
import { CORS_HEADERS, preflight } from "@/lib/bridge/auth";
import { hub } from "@/lib/bridge/hub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return new Response(JSON.stringify({ ok: true, agents: hub.agents.size, viewers: hub.subs.size }), {
    status: 200,
    headers: { ...CORS_HEADERS, "content-type": "application/json" },
  });
}

export const OPTIONS = preflight;
