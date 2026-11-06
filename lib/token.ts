// HQ_TOKEN typed by the viewer for the control panels (schedule, Hermes chat, meeting) and the roster buttons (rename,
// kick). Kept per tab in sessionStorage and sent as an Authorization header, never in a URL.

const TOKEN_KEY = "agenthq.token";

export function readToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

export function saveToken(token: string): void {
  try {
    sessionStorage.setItem(TOKEN_KEY, token.trim());
  } catch {}
}

export const authHeader = (token = readToken()): Record<string, string> => (token ? { authorization: `Bearer ${token}` } : {});

/** What to show after a 401: no token yet, or the one typed is wrong. */
export const tokenError = (token: string) => (token ? "Token salah. Masukkan lagi." : "Agent HQ memakai HQ_TOKEN. Masukkan tokennya dulu.");
