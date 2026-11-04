// Server room screen on floor 2 (server monitor, prd.md §7.8): CPU, RAM, disk and uptime of the machine Agent HQ
// runs on. Not in the prototype; hidden until the bridge sends a sample. Redrawn every second while floor 2 is
// visible, like the mission board, and right away when a sample arrives.

import { ago } from "@/lib/format";
import { diskPct, fmtBytes, fmtPair, fmtUptime, LEVEL_COLOR, levelOf, memPct, pctText, serverStale, serverState, type ServerStats } from "@/lib/server";
import type { Fonts } from "../scene/fonts";
import type { CanvasTex } from "../scene/kit";

/** Canvas size, same aspect as the screen face (2.3 x 1.2). */
export const SERVER_SCREEN_W = 640;
export const SERVER_SCREEN_H = 334;
const W = SERVER_SCREEN_W, H = SERVER_SCREEN_H, HEAD = 54;
const PAPER = "#fff6e3";
/** LED rows per rack (engine/world/floor2.ts). */
export const RACK_ROWS = 6;

/** LED rows lit from the bottom for a share `p` (0..1): at least one, so a live rack never looks dead. */
export const litRows = (p: number, rows = RACK_ROWS) => Math.max(1, Math.min(rows, Math.ceil(p * rows - 1e-6)));

function bar(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  const r = h / 2;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fill();
}

/** `F` is null until fonts are ready: then only the background. */
export function drawServerScreen(F: Fonts | null, face: CanvasTex, s: ServerStats | null, now: number): void {
  const { ctx, tex } = face;
  ctx.fillStyle = "#1b1530";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#2a1f4d";
  ctx.fillRect(0, 0, W, HEAD);
  tex.needsUpdate = true;
  if (!F || !s) return;

  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.fillStyle = "#ffd23f";
  ctx.font = `30px ${F.bungee}`;
  ctx.fillText("SERVER", 20, 39);
  const st = serverState(s, now);
  ctx.font = `600 23px ${F.fredoka}`;
  ctx.textAlign = "right";
  ctx.fillStyle = st.color;
  ctx.fillText(st.label, W - 20, 36);
  ctx.beginPath();
  ctx.arc(W - 20 - ctx.measureText(st.label).width - 14, 28, 7, 0, Math.PI * 2);
  ctx.fill();

  const cpuSub = [s.cores ? `${s.cores} core` : "", s.load ? `load ${s.load.map((x) => x.toFixed(2)).join(" ")}` : ""].filter(Boolean).join(" · ");
  const rows: { label: string; p: number | null; sub: string }[] = [
    { label: "CPU", p: s.cpu, sub: cpuSub },
    { label: "RAM", p: memPct(s), sub: s.memTotal ? fmtPair(s.memUsed ?? 0, s.memTotal) : "" },
    { label: "DISK", p: diskPct(s), sub: s.diskSize ? fmtPair(s.diskUsed ?? 0, s.diskSize) : "" },
  ];
  const BX = 116, BW = 352, BH = 24;
  rows.forEach((r, i) => {
    const y = HEAD + 12 + i * 76;
    const color = r.p == null ? "rgba(255,246,227,.45)" : LEVEL_COLOR[levelOf(r.p)];
    ctx.textAlign = "left";
    ctx.fillStyle = PAPER;
    ctx.font = `24px ${F.bungee}`;
    ctx.fillText(r.label, 20, y + 31);
    ctx.fillStyle = "rgba(255,246,227,.12)";
    bar(ctx, BX, y + 10, BW, BH);
    if (r.p != null) {
      ctx.fillStyle = color;
      bar(ctx, BX, y + 10, Math.max(BH, BW * r.p), BH);
    }
    ctx.textAlign = "right";
    ctx.fillStyle = color;
    ctx.font = `28px ${F.bungee}`;
    ctx.fillText(r.p == null ? "-" : pctText(r.p), W - 20, y + 34);
    if (r.sub) {
      ctx.textAlign = "left";
      ctx.fillStyle = "rgba(255,246,227,.7)";
      ctx.font = `500 21px ${F.fredoka}`;
      ctx.fillText(r.sub, BX, y + 59);
    }
  });

  const foot = [s.uptimeS != null ? `Uptime ${fmtUptime(s.uptimeS)}` : "", s.appRss != null ? `Agent HQ ${fmtBytes(s.appRss)}` : ""].filter(Boolean).join(" · ");
  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(255,246,227,.6)";
  ctx.font = `500 20px ${F.fredoka}`;
  if (foot) ctx.fillText(foot, W / 2, H - 11);

  if (serverStale(s, now)) {
    ctx.fillStyle = "rgba(27,21,48,.9)";
    ctx.fillRect(0, HEAD, W, H - HEAD);
    ctx.fillStyle = LEVEL_COLOR.hot;
    ctx.font = `34px ${F.bungee}`;
    ctx.fillText("TERPUTUS", W / 2, 186);
    ctx.fillStyle = "rgba(255,246,227,.75)";
    ctx.font = `500 22px ${F.fredoka}`;
    ctx.fillText(`data server terakhir ${ago(s.receivedAt, now)}`, W / 2, 222);
  }
}
