import { describe, expect, it } from "vitest";
import { inferDept, normalizeTeam, DEPT_RX } from "@/lib/teams";

describe("normalizeTeam", () => {
  it("aliases", () => {
    expect(normalizeTeam("red")).toBe("red");
    expect(normalizeTeam("Red-Team")).toBe("red");
    expect(normalizeTeam("offensive")).toBe("red");
    expect(normalizeTeam("VA")).toBe("report");
    expect(normalizeTeam("blue_team")).toBe("blue");
    expect(normalizeTeam("kantor")).toBeNull();
    expect(normalizeTeam("none")).toBeNull();
  });
  it("keyword fallback and unknowns", () => {
    expect(normalizeTeam("nmap crew")).toBe("red");
    expect(normalizeTeam("threat hunting")).toBe("blue");
    expect(normalizeTeam("cvss")).toBe("report");
    expect(normalizeTeam("")).toBeNull();
    expect(normalizeTeam("constructor")).toBeNull();
  });
});

describe("DEPT_RX keyword sets (prd.md §10.2)", () => {
  const cases: [string, "red" | "blue" | "report"][] = [
    ["pentest staging", "red"], ["Scan port & service (nmap)", "red"], ["Uji SQL injection di /login", "red"],
    ["Cek IDOR di API booking", "red"], ["Recon subdomain target", "red"], ["Uji bruteforce form login (scope)", "red"],
    ["Monitor SIEM: login gagal SSH", "blue"], ["Deteksi bruteforce /wp-login", "blue"], ["Blokir IP via fail2ban", "blue"],
    ["Laporan VA: executive summary", "report"], ["Hitung skor CVSS temuan", "report"], ["Rapikan bukti PoC", "report"],
  ];
  it.each(cases)("%s -> %s", (text, dept) => {
    expect(DEPT_RX[dept].test(text)).toBe(true);
  });
  it("does not match ordinary work", () => {
    for (const t of ["Refactor handler auth (Gofiber)", "Menulis dokumentasi API", "Build image Docker multi-stage"]) {
      expect(DEPT_RX.red.test(t) || DEPT_RX.blue.test(t) || DEPT_RX.report.test(t)).toBe(false);
    }
  });
});

describe("inferDept", () => {
  it("explicit wins, including explicit office", () => {
    expect(inferDept({ deptExplicit: "blue", task: "nmap -sV", role: "Red Team" }).dept).toBe("blue");
    expect(inferDept({ deptExplicit: null, task: "nmap -sV" }).dept).toBeNull();
  });
  it("task keywords set sticky", () => {
    expect(inferDept({ task: "$ nmap -sV staging" })).toEqual({ dept: "red", sticky: "red" });
  });
  it("sticky survives a neutral task (pentest session running ls)", () => {
    expect(inferDept({ task: "$ ls -la", deptSticky: "red", role: "Claude Code · repo" })).toEqual({ dept: "red", sticky: "red" });
  });
  it("red is checked before blue for the task", () => {
    expect(inferDept({ task: "pentest and incident" }).dept).toBe("red");
  });
  it("role keywords last", () => {
    expect(inferDept({ task: "Merapikan file", role: "SOC Analyst" })).toEqual({ dept: "blue", sticky: null });
    expect(inferDept({ task: "x", role: "Coder" })).toEqual({ dept: null, sticky: null });
  });
});
