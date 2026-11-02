// POST /api/event: one Agent HQ event or an array of events (prd.md §7).
import { authorized, CORS_HEADERS, preflight, readBody } from "@/lib/bridge/auth";
import { publish, type BridgeEvent } from "@/lib/bridge/hub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const json = (status: number, body: string) =>
  new Response(body, { status, headers: { ...CORS_HEADERS, "content-type": "application/json" } });

export async function POST(req: Request) {
  if (!authorized(req)) return json(401, '{"ok":false,"error":"token salah"}');
  try {
    const parsed: unknown = JSON.parse(await readBody(req));
    const list = Array.isArray(parsed) ? parsed : [parsed];
    for (const ev of list) if (ev && typeof ev === "object") publish(ev as BridgeEvent);
    return json(202, JSON.stringify({ ok: true, received: list.length }));
  } catch (e) {
    return json(400, JSON.stringify({ ok: false, error: (e as Error).message }));
  }
}

export const OPTIONS = preflight;
