// Secret redaction and string helpers for the bridge (prd.md §8.4). Port of references/server.js.
// Must run before anything leaves the server. Extend the patterns; never remove one.

import path from "node:path";

/** Collapse whitespace, trim, and cut to n chars with an ellipsis. */
export const trunc = (s: unknown, n: number): string => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

/** `user:pass` -> `user:***`, keeping surrounding quotes. Values without a colon are left alone. */
const maskUserPass = (v: string): string => {
  const q = v[0] === '"' || v[0] === "'" ? v[0] : "";
  const inner = q ? v.slice(1, -1) : v;
  const i = inner.indexOf(":");
  return i < 0 ? v : `${q}${inner.slice(0, i + 1)}***${q}`;
};

/** Hide secrets that often show up in commands and prompts. */
export const redact = (s: unknown): string =>
  String(s ?? "")
    // ---- prototype patterns (references/server.js) ----
    .replace(/(bearer\s+)[\w.\-~+/=]+/gi, "$1***")
    .replace(/((?:api[_-]?key|token|secret|passw(?:or)?d|pwd|authorization)\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, "$1***")
    .replace(/(-p\s*)\S+(?=.*\bmysql\b)/gi, "$1***")
    .replace(/\b(sk|pk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{10,}\b/g, "***")
    // ---- B2 additions (approved 2026-11-03). Flags are case-sensitive on purpose: -P is a port, -U differs. ----
    // mysql / mysqldump / mysqladmin / mariadb -p<password> written after the command word.
    // A bare `-p` (password prompt) is followed by a space and is left alone.
    .replace(/(\b(?:mysql|mysqldump|mysqladmin|mariadb)\b[^|;&\n]*?\s-p)(?!\*\*\*)("[^"]*"|'[^']*'|\S+)/g, "$1***")
    // curl -u / --user / -U / --proxy-user user:pass (attached or separated, optionally quoted).
    .replace(/(\bcurl\b[^|;&\n]*?\s(?:-[uU]\s*|--(?:proxy-)?user(?:\s+|=)))("[^"]*"|'[^']*'|[^\s"']+)/g, (_m, pre: string, val: string) => pre + maskUserPass(val))
    // Credentials in URLs: scheme://user:pass@host
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^\s:@/?#]+):([^\s@/?#]+)@/gi, "$1$2:***@")
    // sshpass -p <password>
    .replace(/(\bsshpass\b[^|;&\n]*?\s-p\s*)("[^"]*"|'[^']*'|[^\s"']+)/g, "$1***");

/** Last path segment, '' for empty input. */
export const base = (p: unknown): string => (p ? path.basename(String(p)) : "");
