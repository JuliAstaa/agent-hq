// Terminal button (docs/terminal.md). The terminal itself is ttyd, a separate program on the server with its own
// password; Agent HQ never talks to it. The server only tells the office where the viewer's browser can open it
// (HQ_TERMINAL_URL, usually http://localhost:7681 through the SSH tunnel), and the panel shows that page in a frame.

import { siblingApiUrl } from "./api-url";

/**
 * The terminal address from HQ_TERMINAL_URL, or null when it is unset or not a plain http(s) URL. A URL with
 * user:password is refused, because GET /api/terminal hands it to the browser and secrets never go in URLs.
 */
export function terminalUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password) return null;
  return u.toString();
}

/** GET /api/terminal next to the live stream, or null when the page is not live on the Next.js server. */
export const terminalApiUrlFor = (streamUrl: string | null, base: string): string | null => siblingApiUrl(streamUrl, base, "terminal");
