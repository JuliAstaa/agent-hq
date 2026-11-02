// Secret redaction and string helpers for the bridge (prd.md §8.4). Port of references/server.js.
// Must run before anything leaves the server. Extend the patterns; never remove one.

import path from "node:path";

/** Collapse whitespace, trim, and cut to n chars with an ellipsis. */
export const trunc = (s: unknown, n: number): string => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

/** Hide secrets that often show up in commands and prompts. */
export const redact = (s: unknown): string =>
  String(s ?? "")
    .replace(/(bearer\s+)[\w.\-~+/=]+/gi, "$1***")
    .replace(/((?:api[_-]?key|token|secret|passw(?:or)?d|pwd|authorization)\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, "$1***")
    .replace(/(-p\s*)\S+(?=.*\bmysql\b)/gi, "$1***")
    .replace(/\b(sk|pk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{10,}\b/g, "***");

/** Last path segment, '' for empty input. */
export const base = (p: unknown): string => (p ? path.basename(String(p)) : "");
