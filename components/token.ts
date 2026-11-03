// HQ_TOKEN typed by the viewer for the control panels (schedule, Hermes chat). Kept per tab in sessionStorage and
// sent as an Authorization header, never in a URL.

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
