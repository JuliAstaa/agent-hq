// GET /api/terminal: where the viewer opens the server's web terminal ({"url": "http://localhost:7681/"}, or null
// when HQ_TERMINAL_URL is unset), so the office can show its Terminal button (docs/terminal.md). The terminal (ttyd)
// is a separate program with its own password; this route only reads the env. No CORS: only the office reads it.
import { terminalUrl } from "@/lib/terminal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ ok: true, url: terminalUrl(process.env.HQ_TERMINAL_URL) }, { headers: { "Cache-Control": "no-store" } });
}
