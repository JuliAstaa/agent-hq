// Team (department) keywords and inference, ported from references/agent-hq.html (prd.md §10.2).
// Shared by the client store and tests. No DOM, no three.js.

export type Dept = "red" | "report" | "blue";

export const DEPT_KEYS = ["red", "blue", "report"] as const satisfies readonly Dept[];

export const DEPTS: Record<Dept, { label: string; room: string; color: string }> = {
  red: { label: "Red Team", room: "Red Team Lab", color: "#ff4f5e" },
  report: { label: "Laporan VA", room: "Ruang Laporan", color: "#ffd23f" },
  blue: { label: "Blue Team", room: "SOC Blue Team", color: "#59c3ff" },
};

export const DEPT_RX: Record<Dept, RegExp> = {
  red: /pentest|penetration|red ?team|exploit|recon|nmap|sqlmap|burp|payload|privesc|privilege escalation|\bxss\b|sql ?injection|\bsqli\b|\bidor\b|enumera|metasploit|subdomain|port ?scan|scan port|uji penetrasi|\buji\b[^.]{0,20}brute/i,
  blue: /brute ?force|\bsiem\b|\bsoc\b|blue ?team|deteksi|detect|fail2ban|\bids\b|\bwaf\b|threat hunt|incident|insiden|login gagal|failed login|wazuh|suricata|blokir ip|block ip/i,
  report: /\blaporan\b|\breport(ing)?\b|vulnerability assessment|\bva\b|cvss|temuan|executive summary|remediasi|remediation|\bpoc\b/i,
};

// Insertion order matters: matches Object.keys(DEPT_RX) in the prototype (red, blue, report).
const DEPT_RX_ORDER: Dept[] = ["red", "blue", "report"];

export const TEAM_ALIAS: Record<string, Dept | null> = {
  red: "red", redteam: "red", red_team: "red", pentest: "red", offensive: "red",
  report: "report", reporting: "report", laporan: "report", va: "report",
  blue: "blue", blueteam: "blue", blue_team: "blue", soc: "blue", defense: "blue",
  office: null, kantor: null, none: null,
};

/** Explicit `team` / `room` / `dept` value -> dept, or null for office / unknown. */
export function normalizeTeam(team: unknown): Dept | null {
  const k = String(team ?? "").toLowerCase().trim().replace(/[\s-]+/g, "_");
  if (Object.prototype.hasOwnProperty.call(TEAM_ALIAS, k)) return TEAM_ALIAS[k];
  return DEPT_RX_ORDER.find((d) => DEPT_RX[d].test(String(team))) ?? null;
}

export interface DeptInput {
  /** undefined = no explicit team ever set; null = explicitly office. */
  deptExplicit?: Dept | null;
  task?: string;
  role?: string;
  deptSticky?: Dept | null;
}

/**
 * Explicit team > task keywords (sticky until idle/offline) > role keywords.
 * Returns the dept and the new sticky value (the prototype mutated `a.deptSticky` in place).
 */
export function inferDept(a: DeptInput): { dept: Dept | null; sticky: Dept | null } {
  const sticky = a.deptSticky ?? null;
  if (a.deptExplicit !== undefined) return { dept: a.deptExplicit, sticky };
  for (const k of DEPT_KEYS) if (DEPT_RX[k].test(a.task || "")) return { dept: k, sticky: k };
  if (sticky) return { dept: sticky, sticky };
  for (const k of DEPT_KEYS) if (DEPT_RX[k].test(a.role || "")) return { dept: k, sticky };
  return { dept: null, sticky };
}
