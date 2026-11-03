// Schedule board on floor 2 (Hermes cron, docs/hermes.md "Jadwal"): a departure-style board with the next runs.
// Not in the prototype; hidden until a schedule source reports. Redrawn every second, like the mission board.

import { countdown, cronStale, jobPhase, PHASE, sortJobs, type CronState } from "@/lib/cron";
import type { Fonts } from "../scene/fonts";
import type { CanvasTex } from "../scene/kit";

const W = 640, H = 400, ROWS = 5, TOP = 84, ROW_H = 58;
const PAPER = "#fff6e3";

/** `text` cut with an ellipsis so it fits `max` pixels in the current font. */
function fit(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + "…").width > max) s = s.slice(0, -1);
  return s + "…";
}

/** True when a job is running (the bell rings). `F` is null until fonts are ready: then only the background. */
export function drawScheduleBoard(F: Fonts | null, face: CanvasTex, cron: CronState | null, now: number): boolean {
  const { ctx, tex } = face;
  ctx.fillStyle = "#1b1530";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#2a1f4d";
  ctx.fillRect(0, 0, W, 62);
  tex.needsUpdate = true;
  if (!F || !cron) return false;

  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.fillStyle = "#ffd23f";
  ctx.font = `34px ${F.bungee}`;
  ctx.fillText("PAPAN JADWAL", 22, 44);
  const stale = cronStale(cron, now);
  const [stText, stColor] = stale ? ["TERPUTUS", "#ff4f5e"] : cron.schedulerAlive ? ["AKTIF", "#a6e22e"] : ["SCHEDULER MATI", "#ff9f1c"];
  ctx.font = `600 20px ${F.fredoka}`;
  ctx.textAlign = "right";
  ctx.fillStyle = stColor;
  ctx.fillText(stText, W - 22, 40);
  ctx.beginPath();
  ctx.arc(W - 22 - ctx.measureText(stText).width - 14, 33, 7, 0, Math.PI * 2);
  ctx.fill();

  const jobs = sortJobs(cron.jobs);
  let ringing = false;
  if (!jobs.length) {
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(255,246,227,.8)";
    ctx.font = `600 28px ${F.fredoka}`;
    ctx.fillText("Belum ada jadwal", W / 2, 210);
    ctx.fillStyle = "rgba(255,246,227,.5)";
    ctx.font = `500 18px ${F.fredoka}`;
    ctx.fillText("buat lewat /cron di Hermes", W / 2, 242);
  }
  jobs.slice(0, ROWS).forEach((j, i) => {
    const y = TOP + i * ROW_H;
    const ph = jobPhase(j, now), color = PHASE[ph].color;
    if (ph === "running") ringing = true;
    if (i % 2 === 0) {
      ctx.fillStyle = "rgba(255,246,227,.05)";
      ctx.fillRect(10, y - 2, W - 20, ROW_H - 4);
    }
    const dim = ph === "running" && Math.floor(now / 1000) % 2 === 1; // running jobs blink once a second
    ctx.fillStyle = dim ? "rgba(166,226,46,.3)" : color;
    ctx.beginPath();
    ctx.arc(34, y + 25, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.textAlign = "left";
    ctx.fillStyle = PAPER;
    ctx.font = `600 25px ${F.fredoka}`;
    ctx.fillText(fit(ctx, j.name, 380), 56, y + 24);
    ctx.fillStyle = ph === "error" ? "#ff8a94" : "rgba(255,246,227,.55)";
    ctx.font = `500 16px ${F.fredoka}`;
    const sub = j.schedule + (j.failureStreak >= 2 ? ` · gagal ${j.failureStreak}x` : ph === "error" ? " · terakhir gagal" : "");
    ctx.fillText(fit(ctx, sub, 380), 56, y + 46);
    const right = ph === "running" ? "JALAN" : ph === "paused" ? "JEDA" : ph === "done" ? "SELESAI" : countdown(j.nextRunAt, now).toUpperCase();
    ctx.textAlign = "right";
    ctx.fillStyle = color;
    ctx.font = `26px ${F.bungee}`;
    ctx.fillText(fit(ctx, right, 170), W - 26, y + 36);
  });
  const more = jobs.length - ROWS;
  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(255,246,227,.45)";
  ctx.font = `500 16px ${F.fredoka}`;
  ctx.fillText(`${more > 0 ? `+${more} jadwal lagi · ` : ""}klik papan untuk kontrol`, W / 2, H - 14);

  if (stale) {
    ctx.fillStyle = "rgba(27,21,48,.72)";
    ctx.fillRect(0, 62, W, H - 62);
    ctx.fillStyle = "#ff4f5e";
    ctx.font = `30px ${F.bungee}`;
    ctx.fillText("REPORTER TERPUTUS", W / 2, 220);
    ctx.fillStyle = "rgba(255,246,227,.7)";
    ctx.font = `500 18px ${F.fredoka}`;
    ctx.fillText(cron.offline ? "reporter jadwal berhenti" : "tidak ada kabar dari reporter jadwal", W / 2, 252);
  }
  return ringing && !stale;
}
