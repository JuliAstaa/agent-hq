// POST /api/event: one Agent HQ event or an array of events (prd.md §7).
// {"type":"rename"} events pin an agent's name/team/role (prd.md §7.4); a single rename answers with its result.
// {"type":"server_stats"} is dropped: only the bridge itself measures the server (prd.md §7.8).
import { authorized, CORS_HEADERS, preflight, readBody } from "@/lib/bridge/auth";
import { publish, renameAgent, type BridgeEvent } from "@/lib/bridge/hub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (status: number, body: string) =>
  new Response(body, { status, headers: { ...CORS_HEADERS, "content-type": "application/json" } });

export async function POST(req: Request) {
  if (!authorized(req)) return json(401, '{"ok":false,"error":"token salah"}');
  try {
    const parsed: unknown = JSON.parse(await readBody(req));
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const renames: { status: number; body: Record<string, unknown> }[] = [];
    for (const ev of list) {
      if (!ev || typeof ev !== "object") continue;
      const type = String((ev as BridgeEvent).type || "").toLowerCase();
      if (type === "rename") renames.push(renameAgent(ev as BridgeEvent));
      else if (!["server_stats", "meeting_state"].includes(type)) publish(ev as BridgeEvent);
    }
    if (!renames.length) return json(202, JSON.stringify({ ok: true, received: list.length }));
    if (!Array.isArray(parsed)) return json(renames[0].status, JSON.stringify(renames[0].body));
    const failed = renames.find((r) => r.status >= 400);
    return json(failed ? failed.status : 202, JSON.stringify({ ok: !failed, received: list.length, renames: renames.map((r) => r.body) }));
  } catch (e) {
    return json(400, JSON.stringify({ ok: false, error: (e as Error).message }));
  }
}

export const OPTIONS = preflight;
