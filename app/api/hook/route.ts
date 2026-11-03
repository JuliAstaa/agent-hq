// POST /api/hook: raw Claude Code hook payload (handler type "http"), translated to Agent HQ events.
// Always answers 200 with an empty body so Claude Code is never blocked (prd.md §8.1).
// Token totals are read from the session transcript after the response is sent (lib/bridge/tokens.ts).
import { after } from "next/server";
import { authorized, CORS_HEADERS, preflight, readBody } from "@/lib/bridge/auth";
import { hookToEvents, type HookPayload } from "@/lib/bridge/hooks";
import { publish, scheduleRemove } from "@/lib/bridge/hub";
import { updateTokensFromHook } from "@/lib/bridge/tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!authorized(req)) return new Response(null, { status: 401, headers: CORS_HEADERS });
  try {
    const h = JSON.parse(await readBody(req)) as HookPayload;
    for (const ev of hookToEvents(h, (name) => req.headers.get(name), scheduleRemove)) publish(ev);
    if (h && typeof h === "object") after(() => updateTokensFromHook(h, publish));
    if (process.env.HQ_DEBUG) console.log("[hook]", h.hook_event_name, h.tool_name || "");
  } catch (e) {
    console.warn("[hook] payload tidak terbaca:", (e as Error).message);
  }
  return new Response(null, { status: 200, headers: CORS_HEADERS });
}

export const OPTIONS = preflight;
