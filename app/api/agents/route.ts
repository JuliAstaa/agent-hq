// GET /api/agents (alias /agents): every known agent as {id, name, role, team, status, renamed},
// to look up a name or id before sending a rename event.
import { CORS_HEADERS, preflight } from "@/lib/bridge/auth";
import { listAgents } from "@/lib/bridge/hub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return new Response(JSON.stringify({ ok: true, agents: listAgents() }), {
    status: 200,
    headers: { ...CORS_HEADERS, "content-type": "application/json" },
  });
}

export const OPTIONS = preflight;
