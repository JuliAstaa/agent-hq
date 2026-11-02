// Floor 3 displays: attack-surface wall, VA severity board, SOC video wall, team station monitors.
// Ported 1:1 from references/agent-hq.html.

import { SEV, SEV_KEYS, STATUS } from "@/lib/events";
import { fmtTime, truncate } from "@/lib/format";
import { hashStr } from "@/lib/palette";
import type { Agent, HQState } from "@/lib/store";
import { DEPTS } from "@/lib/teams";
import { RED_EDGES, RED_NODES, SOCLOG, TERM } from "../constants";
import type { Fonts } from "../scene/fonts";
import type { Sec, Station } from "../world/floor3";

/** Time-driven SOC state owned by the engine (series, flash, metric). */
export interface SocAnim {
  series: number[];
  alertUntil: number;
  text: string;
  ip: string;
  sev: string;
  spike: number;
  metric: number | null;
  metricAt: number;
}

export const newSocAnim = (): SocAnim => ({ series: Array(60).fill(4), alertUntil: 0, text: "", ip: "", sev: "high", spike: 0, metric: null, metricAt: -99 });

function rr(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  c.beginPath(); c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
}

const totalFindings = (s: HQState) => Object.values(s.vuln.counts).reduce((x, y) => x + y, 0);

export function drawRedWall(F: Fonts, SEC: Sec, s: HQState, t: number, active: boolean) {
  const { ctx: c, tex } = SEC.redWall, W = 768, H = 256;
  c.fillStyle = "#12060c"; c.fillRect(0, 0, W, H);
  c.strokeStyle = "rgba(255,79,94,.08)"; c.lineWidth = 1;
  for (let x = 0; x < W; x += 32) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke(); }
  for (let y = 0; y < H; y += 32) { c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke(); }
  c.font = `20px ${F.bungee}`; c.fillStyle = "#ff4f5e"; c.textAlign = "left"; c.fillText("ATTACK SURFACE · SCOPE", 18, 30);
  c.font = `600 14px ${F.fredoka}`; c.fillStyle = active ? "#a6e22e" : "#9a94b0"; c.textAlign = "right"; c.fillText(active ? "● ENGAGEMENT AKTIF" : "○ STANDBY", W - 18, 28);
  for (const [a, b] of RED_EDGES) {
    const [x1, y1] = RED_NODES[a], [x2, y2] = RED_NODES[b];
    c.strokeStyle = "rgba(255,120,140,.45)"; c.lineWidth = 2; c.setLineDash([6, 6]);
    c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke(); c.setLineDash([]);
    if (active) {
      const k = (t * 0.5 + (x1 + y2) * 0.003) % 1;
      c.fillStyle = "#ffd23f"; c.beginPath(); c.arc(x1 + (x2 - x1) * k, y1 + (y2 - y1) * k, 5, 0, Math.PI * 2); c.fill();
    }
  }
  for (const [n, [x, y]] of Object.entries(RED_NODES)) {
    const bad = (s.vuln.nodes as string[]).includes(n), pulse = bad ? 4 * Math.abs(Math.sin(t * 4)) : 0;
    c.fillStyle = n === "RED" ? "#ff4f5e" : bad ? "#ff4f5e" : "#1d3550";
    c.strokeStyle = n === "RED" ? "#fff6e3" : bad ? "#ffd23f" : "#59c3ff"; c.lineWidth = 3;
    c.beginPath(); c.arc(x, y, 24 + pulse, 0, Math.PI * 2); c.fill(); c.stroke();
    c.fillStyle = "#fff6e3"; c.font = `12px ${F.bungee}`; c.textAlign = "center"; c.fillText(n, x, y + 4);
    if (bad) { c.fillStyle = "#ffd23f"; c.font = `16px ${F.bungee}`; c.fillText("!", x + 26, y - 18); }
  }
  const n = totalFindings(s);
  c.textAlign = "left"; c.font = `600 15px ${F.fredoka}`; c.fillStyle = "#fff6e3";
  c.fillText(`Temuan: ${n}  ·  Critical ${s.vuln.counts.critical}  ·  High ${s.vuln.counts.high}`, 18, H - 16);
  tex.needsUpdate = true;
}

export function drawReportBoard(F: Fonts, SEC: Sec, s: HQState) {
  const { ctx: c, tex } = SEC.board, W = 640, H = 270;
  c.fillStyle = "#fff6e3"; c.fillRect(0, 0, W, H);
  c.fillStyle = "#1b1530"; c.font = `26px ${F.bungee}`; c.textAlign = "left"; c.fillText("TEMUAN VA", 20, 40);
  const total = totalFindings(s);
  c.font = `600 15px ${F.fredoka}`; c.fillText(`${total} temuan`, 210, 38);
  const max = Math.max(1, ...Object.values(s.vuln.counts));
  SEV_KEYS.forEach((k, i) => {
    const v = SEV[k];
    const y = 62 + i * 40;
    c.fillStyle = "#1b1530"; c.font = `600 17px ${F.fredoka}`; c.fillText(v.label, 20, y + 20);
    c.fillStyle = "rgba(27,21,48,.1)"; rr(c, 110, y + 4, 200, 22, 8); c.fill();
    c.fillStyle = v.color; rr(c, 110, y + 4, Math.max(14, (200 * s.vuln.counts[k]) / max), 22, 8); c.fill();
    c.fillStyle = "#1b1530"; c.font = `18px ${F.bungee}`; c.fillText(String(s.vuln.counts[k]), 320, y + 22);
  });
  c.strokeStyle = "rgba(27,21,48,.25)"; c.setLineDash([5, 5]); c.beginPath(); c.moveTo(370, 20); c.lineTo(370, H - 20); c.stroke(); c.setLineDash([]);
  c.font = `600 15px ${F.fredoka}`; c.fillStyle = "#1b1530"; c.fillText("Terbaru", 386, 40);
  (s.vuln.list.length ? s.vuln.list : [{ sev: "info" as const, title: "Belum ada temuan" }]).slice(0, 5).forEach((f, i) => {
    const y = 58 + i * 40;
    c.fillStyle = SEV[f.sev].color; rr(c, 386, y, 64, 24, 8); c.fill();
    c.fillStyle = "#1b1530"; c.font = `11px ${F.bungee}`; c.fillText(SEV[f.sev].label.toUpperCase().slice(0, 4), 392, y + 17);
    c.font = `600 14px ${F.fredoka}`; c.fillText(truncate(f.title, 20), 458, y + 17);
  });
  tex.needsUpdate = true;
}

export function drawSOC(F: Fonts, SEC: Sec, s: HQState, soc: SocAnim, simTime: number, t: number, active: boolean) {
  const { ctx: c, tex } = SEC.soc, W = 1024, H = 336;
  const alertOn = simTime < soc.alertUntil;
  c.fillStyle = "#06102a"; c.fillRect(0, 0, W, H);
  c.font = `20px ${F.bungee}`; c.fillStyle = "#59c3ff"; c.textAlign = "left"; c.fillText("SOC · LOGIN GAGAL / MENIT", 20, 34);
  c.font = `600 14px ${F.fredoka}`; c.fillStyle = active ? "#a6e22e" : "#9a94b0"; c.fillText(active ? "● analis online" : "○ tidak ada analis", 360, 32);
  const x0 = 24, y0 = 60, w = 620, h = 240, max = Math.max(30, ...soc.series);
  c.strokeStyle = "rgba(89,195,255,.15)"; c.lineWidth = 1;
  for (let i = 0; i <= 4; i++) { const y = y0 + (h * i) / 4; c.beginPath(); c.moveTo(x0, y); c.lineTo(x0 + w, y); c.stroke(); }
  c.fillStyle = "rgba(89,195,255,.6)"; c.font = `600 12px ${F.fredoka}`; c.fillText(String(Math.round(max)), x0 + 4, y0 + 14);
  const th = y0 + h - h * (25 / max);
  c.strokeStyle = "rgba(255,79,94,.6)"; c.setLineDash([6, 5]); c.beginPath(); c.moveTo(x0, th); c.lineTo(x0 + w, th); c.stroke(); c.setLineDash([]);
  c.fillStyle = "#ff8a94"; c.fillText("ambang 25", x0 + w - 70, th - 6);
  c.beginPath();
  soc.series.forEach((v, i) => {
    const x = x0 + (w * i) / (soc.series.length - 1), y = y0 + h - h * Math.min(1, v / max);
    if (i) c.lineTo(x, y); else c.moveTo(x, y);
  });
  c.strokeStyle = alertOn ? "#ff4f5e" : "#59c3ff"; c.lineWidth = 3; c.stroke();
  c.lineTo(x0 + w, y0 + h); c.lineTo(x0, y0 + h); c.closePath();
  c.fillStyle = alertOn ? "rgba(255,79,94,.15)" : "rgba(89,195,255,.12)"; c.fill();
  c.fillStyle = "#0c1c44"; rr(c, 668, 52, 336, 262, 12); c.fill();
  c.fillStyle = "#fff6e3"; c.font = `16px ${F.bungee}`; c.fillText(`ALERT (${s.soc.total})`, 684, 80);
  (s.soc.alerts.length ? s.soc.alerts : [{ sev: "info" as const, text: "Aman, belum ada alert", ip: "", t: 0 }]).slice(0, 5).forEach((al, i) => {
    const y = 94 + i * 42;
    c.fillStyle = SEV[al.sev].color; rr(c, 684, y, 10, 30, 4); c.fill();
    c.fillStyle = "#fff6e3"; c.font = `600 14px ${F.fredoka}`; c.fillText(truncate(al.text, 34), 702, y + 13);
    c.fillStyle = "rgba(255,246,227,.55)"; c.font = `12px ${F.mono}`; c.fillText(al.ip || (al.t ? fmtTime(al.t) : ""), 702, y + 28);
  });
  if (alertOn && Math.floor(t * 4) % 2 === 0) {
    c.fillStyle = "#ff4f5e"; c.fillRect(0, 0, W, 46);
    c.fillStyle = "#fff6e3"; c.font = `22px ${F.bungee}`; c.textAlign = "center";
    c.fillText(truncate(`!! ${soc.text}${soc.ip ? " · " + soc.ip : ""}`, 60), W / 2, 32); c.textAlign = "left";
  }
  tex.needsUpdate = true;
}

export function drawStation(F: Fonts, st: Station, a: Agent | undefined, s: HQState, soc: SocAnim, simTime: number, t: number) {
  const { ctx: c } = st.cv, W = 512, H = 160, d = st.dept;
  const bg = { red: "#16070d", report: "#1d1a2e", blue: "#07122a" }[d];
  c.fillStyle = bg; c.fillRect(0, 0, W, H); c.textAlign = "left";
  if (!a) {
    c.fillStyle = "rgba(255,255,255,.25)"; c.font = `20px ${F.bungee}`; c.textAlign = "center";
    c.fillText("STANDBY", 128, 88); c.fillText(DEPTS[d].label.toUpperCase(), 384, 88);
    st.texs.forEach((x) => (x.needsUpdate = true));
    return;
  }
  const status = a.status, col = STATUS[status].color;
  if (d === "red") {
    c.font = `12px ${F.mono}`;
    const off = status === "working" ? Math.floor(t * 2) : 0;
    for (let i = 0; i < 9; i++) {
      const line = TERM[(i + off) % TERM.length];
      c.fillStyle = line.startsWith("$") ? "#ffd23f" : line.startsWith("[!]") ? "#ff4f5e" : "#ff9eae";
      c.fillText(line, 10, 18 + i * 16);
    }
    c.fillStyle = "#ff4f5e"; c.font = `14px ${F.bungee}`; c.fillText("RECON", 272, 24);
    for (let i = 0; i < 6; i++) {
      const h = hashStr(a.id + i + Math.floor(t));
      c.fillStyle = h % 5 === 0 ? "#ff4f5e" : "#5a2a4a";
      c.fillRect(272 + (i % 3) * 76, 40 + Math.floor(i / 3) * 40, 66, 30);
      c.fillStyle = "#fff6e3"; c.font = `11px ${F.mono}`;
      c.fillText(["22", "80", "443", "3306", "8080", "6379"][i], 280 + (i % 3) * 76, 60 + Math.floor(i / 3) * 40);
    }
  } else if (d === "report") {
    c.fillStyle = "#fff6e3"; c.fillRect(14, 8, 228, 144);
    c.fillStyle = "#1b1530"; c.font = `13px ${F.bungee}`; c.fillText("LAPORAN VA", 24, 28);
    const lines = status === "working" ? (Math.floor(t * 3) % 9) + 1 : 6;
    for (let i = 0; i < lines; i++) {
      const h = hashStr(a.id + i);
      c.fillStyle = i % 4 === 1 ? SEV[SEV_KEYS[h % 5]].color : "rgba(27,21,48,.35)";
      c.fillRect(24, 40 + i * 12, i % 4 === 1 ? 40 : 60 + (h % 140), 7);
    }
    c.fillStyle = "#ffd23f"; c.font = `14px ${F.bungee}`; c.fillText("CVSS", 272, 24);
    SEV_KEYS.forEach((k, i) => { c.fillStyle = SEV[k].color; c.fillRect(272, 38 + i * 22, 20 + Math.min(200, s.vuln.counts[k] * 24), 14); });
  } else {
    const max = Math.max(30, ...soc.series), alertOn = simTime < soc.alertUntil;
    c.beginPath();
    soc.series.slice(-40).forEach((v, i) => {
      const x = 10 + i * 6, y = 150 - 130 * Math.min(1, v / max);
      if (i) c.lineTo(x, y); else c.moveTo(x, y);
    });
    c.strokeStyle = alertOn ? "#ff4f5e" : "#59c3ff"; c.lineWidth = 2.5; c.stroke();
    c.font = `11px ${F.mono}`;
    const off = Math.floor(t * 2.5);
    for (let i = 0; i < 9; i++) {
      const line = SOCLOG[(i + off) % SOCLOG.length];
      c.fillStyle = alertOn && /Failed|401|Invalid/.test(line) ? "#ff8a94" : "#9fd8ff";
      c.fillText(line, 266, 18 + i * 16);
    }
  }
  if (status === "thinking") {
    for (let i = 0; i < 3; i++) {
      const r = 8 + 5 * Math.max(0, Math.sin(t * 5 - i * 0.8));
      c.fillStyle = col; c.beginPath(); c.arc(330 + i * 36, 135, r, 0, Math.PI * 2); c.fill();
    }
  }
  if (status === "waiting" || status === "error") {
    c.fillStyle = status === "error" ? "rgba(255,79,94,.85)" : "rgba(255,159,28,.85)"; c.fillRect(0, 56, W, 48);
    c.fillStyle = "#1b1530"; c.font = `26px ${F.bungee}`; c.textAlign = "center";
    c.fillText(status === "error" ? "ERROR" : "BUTUH INPUT", W / 2, 90);
  }
  st.texs.forEach((x) => (x.needsUpdate = true));
}
