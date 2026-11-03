/**
 * URL of another Agent HQ API route next to the live stream, e.g. "/api/stream" -> "/api/cron". Null when the
 * stream is not an Agent HQ `/api/stream` over http(s) (the prototype bridge, a static demo, a bad URL): the
 * controls that need these routes only work against the Next.js server.
 */
export function siblingApiUrl(streamUrl: string | null, base: string, leaf: string): string | null {
  if (!streamUrl) return null;
  let u: URL;
  try {
    u = new URL(streamUrl, base);
  } catch {
    return null;
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || !/\/api\/stream\/?$/.test(u.pathname)) return null;
  u.pathname = u.pathname.replace(/\/stream\/?$/, `/${leaf}`);
  u.search = "";
  u.hash = "";
  return u.toString();
}
