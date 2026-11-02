// Optional shared token (env HQ_TOKEN) for POST /api/event and /api/hook.
// Accepted as `Authorization: Bearer <token>` or `x-hq-token: <token>`. Unset token = open (localhost only).

export function authorized(req: Request, token = process.env.HQ_TOKEN || ""): boolean {
  if (!token) return true;
  const h = req.headers.get("authorization") || "";
  return h === `Bearer ${token}` || req.headers.get("x-hq-token") === token;
}

/** CORS headers the prototype bridge sends on every response. */
export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization, x-hq-token",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export const preflight = () => new Response(null, { status: 204, headers: CORS_HEADERS });

/** Read the request body as UTF-8 (BOM kept, like Buffer#toString) with a size limit. */
export async function readBody(req: Request, limit = 2e6): Promise<string> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw new Error("body terlalu besar");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}
