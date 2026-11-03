// Canvas displays on floors 1-2: desk monitors, name plates, TV, arcade, whiteboard, mission board.
// Ported 1:1 from references/agent-hq.html; fonts come from the resolved next/font families.

import { STATUS } from "@/lib/events";
import { fmtNum, truncate } from "@/lib/format";
import { hashStr } from "@/lib/palette";
import type { Agent, HQState } from "@/lib/store";
import { DEPTS } from "@/lib/teams";
import { locText } from "../agents/movement";
import type { AgentRuntime } from "../agents/animate";
import type { Fonts } from "../scene/fonts";
import { pick, rand, type CanvasTex } from "../scene/kit";
import type { Floor2Props } from "../world/floor2";
import type { Desk } from "../world/props/desk";

export function drawScreen(F: Fonts, rt: AgentRuntime, a: Agent, t: number) {
  const { ctx, tex } = rt.desk.scr, W = 256, H = 160;
  const st = a.status, col = STATUS[st].color, mv = rt.mv, away = mv.mode !== "desk";
  ctx.fillStyle = st === "offline" ? "#0b0816" : "#150e2c";
  ctx.fillRect(0, 0, W, H);
  ctx.textAlign = "left";
  if (st === "working" && away && mv.dest.kind === "station") {
    ctx.fillStyle = DEPTS[mv.dest.dept].color; ctx.font = `40px ${F.bungee}`; ctx.textAlign = "center"; ctx.fillText("DI LT.3", W / 2, 80);
    ctx.font = `600 20px ${F.fredoka}`; ctx.fillStyle = "#fff6e3"; ctx.fillText(mv.dest.room, W / 2, 118);
  } else if (st === "working" && !away) {
    const off = (t * 40) % 18;
    for (let i = 0; i < 11; i++) {
      const y = 10 + i * 18 - off, s = hashStr(a.id + Math.floor(i + (t * 40) / 18));
      ctx.fillStyle = i % 3 === 0 ? "#ff6fd8" : col;
      const indent = (s % 4) * 14;
      ctx.fillRect(12 + indent, y, 30 + (s % 140), 8);
      ctx.fillStyle = "#59c3ff";
      ctx.fillRect(12 + indent + 40 + (s % 140), y, (s >>> 5) % 50, 8);
    }
  } else if (st === "thinking") {
    for (let i = 0; i < 3; i++) {
      const r = 10 + 6 * Math.max(0, Math.sin(t * 5 - i * 0.8));
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(80 + i * 48, 80, r, 0, Math.PI * 2); ctx.fill();
    }
  } else if (st === "error") {
    if (Math.floor(t * 3) % 2 === 0) { ctx.fillStyle = col; ctx.fillRect(0, 0, W, H); ctx.fillStyle = "#150e2c"; }
    else ctx.fillStyle = col;
    ctx.font = `64px ${F.bungee}`; ctx.textAlign = "center"; ctx.fillText("ERR!", W / 2, 104);
  } else if (st === "waiting") {
    ctx.fillStyle = col; ctx.font = `72px ${F.bungee}`; ctx.textAlign = "center"; ctx.fillText("?", W / 2, 90 + Math.sin(t * 4) * 6);
    ctx.font = `600 20px ${F.fredoka}`; ctx.fillText("butuh input", W / 2, 135);
  } else if (st !== "offline") {
    if (away && mv.dest.kind === "station") {
      ctx.fillStyle = DEPTS[mv.dest.dept].color; ctx.font = `44px ${F.bungee}`; ctx.textAlign = "center"; ctx.fillText("DI LT.3", W / 2, 80);
      ctx.font = `600 20px ${F.fredoka}`; ctx.fillStyle = "#fff6e3"; ctx.fillText(mv.dest.room, W / 2, 118);
    } else if (away && (mv.fetching || mv.carrying)) {
      ctx.fillStyle = "#ffd23f"; ctx.font = `34px ${F.bungee}`; ctx.textAlign = "center"; ctx.fillText("TUGAS BARU", W / 2, 82 + Math.sin(t * 4) * 3);
      ctx.font = `600 18px ${F.fredoka}`; ctx.fillStyle = "#fff6e3"; ctx.fillText(mv.carrying ? "lagi dibawa ke meja" : "diambil di papan", W / 2, 120);
    } else if (away) {
      ctx.fillStyle = "#59c3ff"; ctx.font = `50px ${F.bungee}`; ctx.textAlign = "center"; ctx.fillText("AFK", W / 2, 82 + Math.sin(t * 2) * 4);
      ctx.font = `600 18px ${F.fredoka}`; ctx.fillStyle = "#fff6e3"; ctx.fillText(truncate(locText(rt).what || "santai", 22), W / 2, 120);
    } else {
      const x = 128 + Math.sin(t * 0.9) * 90, y = 80 + Math.sin(t * 1.3) * 45;
      ctx.fillStyle = "#ff9ecf"; ctx.beginPath(); ctx.arc(x, y, 16, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "#ffd9a8"; ctx.lineWidth = 3; ctx.beginPath(); ctx.ellipse(x, y, 28, 8, -0.3, 0, Math.PI * 2); ctx.stroke();
    }
  }
  if (a.progress != null && st !== "offline") {
    ctx.fillStyle = "rgba(255,255,255,.15)"; ctx.fillRect(0, H - 8, W, 8);
    ctx.fillStyle = col; ctx.fillRect(0, H - 8, W * a.progress, 8);
  }
  tex.needsUpdate = true;
}

/** Unassigned desk: dark monitor with STANDBY (same style as empty floor-3 stations) and a blank name plate.
 *  Text is drawn only once fonts are ready; before that both stay blank. */
export function drawEmptyDesk(F: Fonts | null, d: Desk) {
  const s = d.scr;
  s.ctx.fillStyle = "#150e2c"; s.ctx.fillRect(0, 0, 256, 160);
  if (F) {
    s.ctx.fillStyle = "rgba(255,255,255,.25)"; s.ctx.font = `24px ${F.bungee}`; s.ctx.textAlign = "center";
    s.ctx.fillText("STANDBY", 128, 90);
  }
  s.tex.needsUpdate = true;
  d.plate.ctx.fillStyle = "#fff6e3"; d.plate.ctx.fillRect(0, 0, 256, 64);
  d.plate.tex.needsUpdate = true;
  d.plateName = undefined;
}

/** Cork face of the task board (deviation 14). Text only once fonts are ready. */
export function drawTaskBoard(F: Fonts | null, face: CanvasTex) {
  const { ctx, tex } = face, W = 512, H = 320;
  ctx.fillStyle = "#c98a4b"; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "rgba(90,50,20,.18)";
  for (let i = 0; i < 260; i++) ctx.fillRect((i * 97) % W, (i * 57) % H, 3 + (i % 3), 2 + (i % 2));
  ctx.fillStyle = "#1b1530"; ctx.fillRect(0, 0, W, 56);
  if (F) { ctx.fillStyle = "#ffd23f"; ctx.font = `30px ${F.bungee}`; ctx.textAlign = "center"; ctx.fillText("PAPAN TUGAS", W / 2, 40); }
  tex.needsUpdate = true;
}

export function drawPlate(F: Fonts, rt: AgentRuntime, a: Agent) {
  const { ctx, tex } = rt.desk.plate;
  ctx.fillStyle = "#fff6e3"; ctx.fillRect(0, 0, 256, 64);
  ctx.fillStyle = "#1b1530"; ctx.font = `30px ${F.bungee}`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(truncate(a.name.toUpperCase(), 12), 128, 34);
  ctx.textBaseline = "alphabetic";
  tex.needsUpdate = true;
  rt.desk.plateName = a.name;
}

export function drawTV(F: Fonts, tv: CanvasTex, t: number, on: boolean) {
  const { ctx, tex } = tv, W = 320, H = 180;
  if (!on) {
    ctx.fillStyle = "#120c26"; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "rgba(255,255,255,.07)"; ctx.beginPath(); ctx.moveTo(40, 0); ctx.lineTo(110, 0); ctx.lineTo(30, H); ctx.lineTo(-40, H); ctx.fill();
    tex.needsUpdate = true;
    return;
  }
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, `hsl(${(t * 20) % 360},70%,55%)`); g.addColorStop(1, "#ffb86b");
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#5a3f78"; ctx.beginPath(); ctx.ellipse(160, H + 30, 260, 70, 0, 0, Math.PI * 2); ctx.fill();
  const bx = 160 + Math.sin(t * 1.7) * 90, by = 105 - Math.abs(Math.sin(t * 3.4)) * 45;
  ctx.fillStyle = "#a6e22e"; ctx.beginPath(); ctx.ellipse(bx, by, 26, 26 + Math.sin(t * 6.8) * 3, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(bx + 7, by - 6, 9, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#1b1530"; ctx.beginPath(); ctx.arc(bx + 9, by - 6, 4, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#ffd23f"; ctx.beginPath(); ctx.arc(260, 40, 18, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "rgba(0,0,0,.35)"; ctx.fillRect(10, 10, 52, 18);
  ctx.fillStyle = "#fff"; ctx.font = `600 12px ${F.fredoka}`; ctx.textAlign = "left"; ctx.fillText("LIVE", 18, 24);
  tex.needsUpdate = true;
}

export function drawArcade(F: Fonts, ar: CanvasTex, t: number, on: boolean) {
  const { ctx, tex } = ar;
  ctx.fillStyle = "#0d0a1f"; ctx.fillRect(0, 0, 128, 128);
  if (on) {
    for (let i = 0; i < 14; i++) {
      const s = hashStr("ar" + i + Math.floor(t * 3));
      ctx.fillStyle = ["#ff6fd8", "#59c3ff", "#ffd23f", "#a6e22e"][s % 4];
      ctx.fillRect((s % 8) * 16, 128 - ((s >>> 4) % 5) * 12 - 12, 14, 10);
    }
    const y = (t * 60) % 110;
    ctx.fillStyle = "#ff9f68"; ctx.fillRect(48 + Math.sin(t * 3) * 20, y, 30, 10);
    ctx.fillStyle = "#fff"; ctx.font = `12px ${F.bungee}`; ctx.textAlign = "left";
    ctx.fillText(String(Math.floor(t * 37) % 99999).padStart(5, "0"), 6, 14);
  } else if (Math.floor(t * 1.5) % 2 === 0) {
    ctx.fillStyle = "#ffd23f"; ctx.font = `13px ${F.bungee}`; ctx.textAlign = "center";
    ctx.fillText("INSERT", 64, 58); ctx.fillText("COIN", 64, 78);
  }
  tex.needsUpdate = true;
}

/* Easter egg (user request 2026-11-03): sometimes an agent at the whiteboard writes this, letter by letter. */
export const WB_EGG_TEXT = "hey antek antek asing!";
/** Chance per whiteboard session (an agent starts the "whiteboard" activity). */
export const WB_EGG_CHANCE = 0.25;
const MARKERS = ["#1b1530", "#ff4f5e", "#3a8fd9", "#2e8b6a"];

export interface WhiteboardEgg {
  /** Ticks (90 ms) of normal scribbling before the writing starts. */
  wait: number;
  /** Next letter; -1 = not started (spot not chosen yet). */
  i: number;
  x: number;
  y: number;
  color: string;
}

export const newWhiteboardEgg = (wait = Math.floor(rand(12, 35))): WhiteboardEgg => ({ wait, i: -1, x: 0, y: 0, color: pick(MARKERS) });

/** One letter per tick, slightly tilted and bouncy like handwriting. Returns true while writing. */
function writeEgg(w: Floor2Props["wb"], F: Fonts): boolean {
  const e = w.egg!, c = w.ctx, size = 34;
  c.font = `600 ${size}px ${F.fredoka}`;
  if (e.i < 0) {
    const width = c.measureText(WB_EGG_TEXT).width;
    e.x = rand(24, Math.max(25, 512 - 24 - width));
    e.y = rand(56, 300);
    c.fillStyle = "#ffffff"; // wipe a clean patch first
    c.fillRect(e.x - 12, e.y - size - 4, width + 24, size + 18);
    w.keepOut = [e.x - 16, e.y - size - 8, e.x + width + 16, e.y + 18]; // scribbles stay off it until the next wipe
    e.i = 0;
  }
  const ch = WB_EGG_TEXT[e.i];
  const x = e.x + c.measureText(WB_EGG_TEXT.slice(0, e.i)).width;
  c.save();
  c.translate(x, e.y + rand(-2, 2));
  c.rotate(rand(-0.07, 0.07));
  c.fillStyle = e.color;
  c.textAlign = "left";
  c.fillText(ch, 0, 0);
  c.restore();
  e.i++;
  if (e.i >= WB_EGG_TEXT.length) w.egg = null;
  w.tex.needsUpdate = true;
  return true;
}

/** Scribbles while an agent is at the whiteboard. `F` is null until fonts are ready (no text before that). */
export function drawWhiteboard(w: Floor2Props["wb"], on: boolean, F: Fonts | null = null) {
  if (!on) {
    w.wasOn = false;
    return;
  }
  if (!w.wasOn) {
    w.wasOn = true;
    if (w.forceEgg || Math.random() < WB_EGG_CHANCE) w.egg = newWhiteboardEgg(w.forceEgg ? 0 : undefined);
    w.forceEgg = false;
  }
  if (w.egg) {
    if (w.egg.wait > 0) w.egg.wait--;
    else if (F && writeEgg(w, F)) return;
  }
  const c = w.ctx;
  if (w.strokes > 140) { c.fillStyle = "#ffffff"; c.fillRect(0, 0, 512, 320); w.strokes = 0; w.keepOut = null; }
  // Plan the stroke first (random walk from the last point, sometimes a jump), then draw it.
  let sx = w.cx, sy = w.cy;
  let ex = Math.max(30, Math.min(482, sx + rand(-40, 40)));
  let ey = Math.max(30, Math.min(290, sy + rand(-25, 25)));
  if (Math.random() < 0.05) { sx = ex = rand(40, 460); sy = ey = rand(40, 280); }
  const k = w.keepOut;
  if (k) {
    // Keep the easter-egg text readable: strokes that would touch it start somewhere clear instead.
    const near = (x: number, y: number) => x > k[0] - 24 && x < k[2] + 24 && y > k[1] - 24 && y < k[3] + 24;
    for (let n = 0; n < 20 && (near(sx, sy) || near(ex, ey)); n++) {
      sx = rand(40, 460); sy = rand(40, 280);
      ex = Math.max(30, Math.min(482, sx + rand(-15, 15)));
      ey = Math.max(30, Math.min(290, sy + rand(-10, 10)));
    }
    if (near(sx, sy) || near(ex, ey)) return;
  }
  c.strokeStyle = pick(MARKERS); c.lineWidth = 4; c.lineCap = "round";
  c.beginPath(); c.moveTo(sx, sy);
  c.quadraticCurveTo(ex + rand(-20, 20), ey + rand(-20, 20), ex, ey); c.stroke();
  w.cx = ex; w.cy = ey; w.strokes++;
  w.tex.needsUpdate = true;
}

export function drawBoard(F: Fonts, board: CanvasTex, s: HQState, chilling: number) {
  const { ctx, tex } = board, W = 640, H = 380;
  ctx.fillStyle = "#2a1f4d"; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "rgba(255,246,227,.08)"; ctx.lineWidth = 2;
  for (let y = 60; y < H; y += 40) { ctx.beginPath(); ctx.moveTo(20, y); ctx.lineTo(W - 20, y); ctx.stroke(); }
  ctx.fillStyle = "#ffd23f"; ctx.font = `42px ${F.bungee}`; ctx.textAlign = "left"; ctx.fillText("PAPAN MISI", 34, 66);
  const all = [...s.agents.values()];
  const active = all.filter((a) => a.status === "working" || a.status === "thinking").length;
  const rows: [string, string, string][] = [
    ["Agen aktif", `${active}/${all.length}`, "#a6e22e"],
    ["Lagi santai", String(chilling), "#59c3ff"],
    ["Tugas selesai", String(s.stats.done), "#ffd23f"],
    ["Token terpakai", fmtNum(all.reduce((sum, a) => sum + (a.tokens || 0), 0)), "#ff6fd8"],
    ["Error hari ini", String(s.stats.errors), "#ff4f5e"],
    ["Alert SOC / Temuan", `${s.soc.total} / ${Object.values(s.vuln.counts).reduce((x, y) => x + y, 0)}`, "#ff9f68"],
  ];
  rows.forEach(([k, v, c], i) => {
    const y = 112 + i * 46;
    ctx.font = `600 28px ${F.fredoka}`; ctx.fillStyle = "rgba(255,246,227,.85)"; ctx.fillText(k, 40, y);
    ctx.fillStyle = c; ctx.font = `34px ${F.bungee}`;
    const w = ctx.measureText(v).width;
    ctx.fillText(v, W - 44 - w, y + 2);
  });
  tex.needsUpdate = true;
}
