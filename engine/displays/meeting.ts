// Meeting room screen on floor 4 (prd.md §7.9): room name, then KOSONG or the team, the leader's task, up to five
// members and how long the meeting has run. Text only once fonts are ready (before that the screen stays blank).

import { STATUS, type Status } from "@/lib/events";
import { truncate } from "@/lib/format";
import type { Fonts } from "../scene/fonts";
import type { CanvasTex } from "../scene/kit";
import { MEETING_SCREEN_H, MEETING_SCREEN_W } from "../world/floor4";

export interface MeetingScreenInfo {
  team: string;
  /** Accent: the team color. */
  color: string;
  /** The leader's task. */
  goal: string;
  members: { name: string; color: string; status: Status; task: string }[];
  /** Meeting start, epoch ms. */
  since: number;
}

/** "rapat 3 mnt", "rapat <1 mnt". */
export const meetingAge = (since: number, now: number) => {
  const m = Math.floor(Math.max(0, now - since) / 60000);
  return `rapat ${m < 1 ? "<1" : m} mnt`;
};

export function drawMeetingScreen(F: Fonts | null, cv: CanvasTex, room: string, info: MeetingScreenInfo | null, now: number) {
  const { ctx, tex } = cv, W = MEETING_SCREEN_W, H = MEETING_SCREEN_H;
  ctx.fillStyle = "#150e2c"; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = info ? info.color : "#3a3360"; ctx.fillRect(0, 0, W, 6);
  if (!F) {
    tex.needsUpdate = true;
    return;
  }
  ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "rgba(255,246,227,.55)"; ctx.font = `22px ${F.bungee}`; ctx.fillText(room.toUpperCase(), 24, 42);
  if (!info) {
    ctx.fillStyle = "rgba(255,255,255,.22)"; ctx.font = `56px ${F.bungee}`; ctx.textAlign = "center";
    ctx.fillText("KOSONG", W / 2, 170);
    ctx.font = `500 22px ${F.fredoka}`; ctx.fillStyle = "#fff6e3"; ctx.fillText("Klik layar untuk diskusi", W / 2, 218);
    tex.needsUpdate = true;
    return;
  }
  ctx.textAlign = "right"; ctx.fillStyle = "rgba(255,246,227,.75)"; ctx.font = `600 20px ${F.fredoka}`;
  ctx.fillText(meetingAge(info.since, now), W - 24, 40);
  ctx.textAlign = "left";
  ctx.fillStyle = info.color; ctx.font = `32px ${F.bungee}`; ctx.fillText(truncate(info.team.toUpperCase(), 26), 24, 84);
  ctx.fillStyle = "rgba(255,246,227,.85)"; ctx.font = `600 19px ${F.fredoka}`;
  ctx.fillText(truncate(info.goal || "-", 54), 24, 112);
  info.members.slice(0, 5).forEach((m, i) => {
    const y = 146 + i * 27;
    ctx.fillStyle = m.color; ctx.strokeStyle = "#1b1530"; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(34, y - 6, 8, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = STATUS[m.status].color; ctx.fillRect(50, y - 13, 8, 14);
    ctx.fillStyle = "#fff6e3"; ctx.font = `600 19px ${F.fredoka}`; ctx.fillText(truncate(m.name, 16), 68, y);
    ctx.fillStyle = "rgba(255,246,227,.6)"; ctx.font = `400 17px ${F.fredoka}`; ctx.fillText(truncate(m.task || STATUS[m.status].label, 40), 230, y);
  });
  tex.needsUpdate = true;
}
