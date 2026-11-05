// POST /api/event: one Agent HQ event or an array of events (prd.md §7).
// {"type":"rename"} events pin an agent's name/team/role (prd.md §7.4); {"type":"kick"} sends an idle or offline
// agent out of the office (prd.md §7.10). A single rename or kick answers with its own result.
// {"type":"server_stats"} is dropped: only the bridge itself measures the server (prd.md §7.8).
import { authorized, CORS_HEADERS, preflight, readBody } from "@/lib/bridge/auth";
import { kickAgent, publish, renameAgent, type BridgeEvent } from "@/lib/bridge/hub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (status: number, body: string) =>
  new Response(body, { status, headers: { ...CORS_HEADERS, "content-type": "application/json" } });

type Result = { status: number; body: Record<string, unknown> };

export async function POST(req: Request) {
  if (!authorized(req)) return json(401, '{"ok":false,"error":"token salah"}');
  try {
    const parsed: unknown = JSON.parse(await readBody(req));
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const renames: Result[] = [];
    const kicks: Result[] = [];
    for (const ev of list) {
      if (!ev || typeof ev !== "object") continue;
      const type = String((ev as BridgeEvent).type || "").toLowerCase();
      if (type === "rename") renames.push(renameAgent(ev as BridgeEvent));
      else if (type === "kick") kicks.push(kickAgent(ev as BridgeEvent));
      else if (!["server_stats", "meeting_state"].includes(type)) publish(ev as BridgeEvent);
    }
    const results = [...renames, ...kicks];
    if (!results.length) return json(202, JSON.stringify({ ok: true, received: list.length }));
    if (!Array.isArray(parsed)) return json(results[0].status, JSON.stringify(results[0].body));
    const failed = results.find((r) => r.status >= 400);
    return json(failed ? failed.status : 202, JSON.stringify({
      ok: !failed, received: list.length,
      ...(renames.length ? { renames: renames.map((r) => r.body) } : {}),
      ...(kicks.length ? { kicks: kicks.map((r) => r.body) } : {}),
    }));
  } catch (e) {
    return json(400, JSON.stringify({ ok: false, error: (e as Error).message }));
  }
}

export const OPTIONS = preflight;
