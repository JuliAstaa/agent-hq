// Random little actions and chat balloons (user request 2026-11-03). Pure scheduling and content; the engine applies
// the animation (animate.ts) and the balloon DOM (avatar.ts / index.ts). Never shown while an agent needs the human
// (waiting), errors or is offline, so status signals stay readable.

import type { Status } from "@/lib/events";
import type { Dept } from "@/lib/teams";
import type { Activity } from "../constants";
import { pick, rand } from "../scene/kit";

export type Quirk = "stretch" | "dance" | "yawn" | "hop" | "wave" | "spin" | "sneeze" | "lookaround";

/** Seconds each action lasts. */
export const QUIRK_DUR: Record<Quirk, number> = {
  stretch: 2.2, dance: 3.2, yawn: 2.0, hop: 1.1, wave: 2.0, spin: 1.2, sneeze: 1.4, lookaround: 2.6,
};

/** Actions that make sense for a pose ("desk" = seated at a desk or station, the chair can spin). */
const BY_POSE: Record<string, Quirk[]> = {
  stand: ["stretch", "dance", "yawn", "hop", "wave", "spin", "sneeze", "lookaround"],
  sit: ["stretch", "dance", "yawn", "wave", "sneeze", "lookaround"],
  stool: ["stretch", "dance", "yawn", "wave", "sneeze", "lookaround"],
  desk: ["stretch", "yawn", "lookaround", "spin", "sneeze"],
  recline: ["yawn", "stretch", "lookaround"],
  lie: ["yawn", "stretch", "lookaround"],
};

const CALM: Status[] = ["idle", "working", "thinking"];

export interface FunInfo {
  status: Status;
  /** Movement mode: desk | walk | act | fetch (anything else is treated as busy). */
  mode: string;
  pose: string;
  activity: Activity | null;
  dept: Dept | null;
  /** Bubble visible on screen right now. */
  visible: boolean;
  /** Holding a task card (deviation 14): hands are busy, no actions. */
  carrying?: boolean;
  /** Seated at a meeting table (prd.md §7.9): work lines instead of small talk. */
  meeting?: boolean;
  /** Someone at the same meeting table waits or errors: no balloons there. */
  hush?: boolean;
}

export function allowedQuirks(info: Pick<FunInfo, "status" | "mode" | "pose" | "carrying">): Quirk[] {
  if (!CALM.includes(info.status) || info.carrying) return [];
  if (info.mode !== "act" && info.mode !== "desk") return [];
  return BY_POSE[info.pose] ?? [];
}

/* ---------------- chat lines (casual Indonesian; no em dashes) ---------------- */

export const CHAT_IDLE = [
  "makan mie ayam enak nih",
  "siang ini makan apa ya?",
  "gorengan masih ada?",
  "nanti sore ngopi yuk",
  "weekend ke mana nih?",
  "ngantuk banget...",
  "wifi lemot lagi ya",
  "siapa yang bawa martabak?",
  "kangen pulang kampung",
  "es teh manis satu dong",
  "hari ini cerah ya",
  "charger aku di mana ya",
];

export const CHAT_BY_ACTIVITY: Partial<Record<Activity, string[]>> = {
  tv: ["plot twist-nya gila!", "episode berapa ini?", "jangan spoiler ya"],
  phone: ["liat meme ini deh", "grup keluarga rame banget"],
  lie_phone: ["scroll dikit lagi...", "videonya lucu banget"],
  nap: ["zzz...", "lima menit lagi..."],
  coffee: ["kopi ketiga hari ini", "gulanya mana ya?"],
  sip: ["kopinya pas banget", "enak nih buat begadang"],
  fridge: ["yogurt siapa nih?", "kok es krimnya habis"],
  arcade: ["dikit lagi high score!", "skor baru nih!"],
  pingpong: ["smash!", "lawan tembok aja kalah"],
  gaze: ["planetnya bagus ya", "itu bulan ada dua?"],
  whiteboard: ["ini diagram apa ya", "panah ke mana lagi nih"],
  cards: ["kartu as nih!", "giliran siapa?"],
  read: ["bab ini seru", "dikit lagi tamat"],
};

export const CHAT_WORKING = [
  "bentar lagi kelar...",
  "kok test-nya merah?",
  "ini bug atau fitur?",
  "compile dulu ah",
  "siapa yang push ke main?!",
  "kopi mana kopi",
  "tinggal dikit lagi",
];

export const CHAT_BY_DEPT: Record<Dept, string[]> = {
  red: ["scope aman, lanjut", "port-nya kebuka nih", "catat dulu temuannya"],
  report: ["CVSS-nya berapa ya", "tinggal executive summary", "screenshot PoC mana ya"],
  blue: ["login gagal naik nih", "IP ini lagi ini lagi", "alert-nya beneran nggak ya"],
  ops: ["deploy jangan Jumat sore", "rak-nya panas nih", "rollback dulu aja?"],
};

export const CHAT_THINKING = ["hmm...", "kalau begini gimana ya", "coba pikir ulang", "sebentar, mikir dulu"];

export const CHAT_REPLIES = ["wkwk", "setuju!", "boleh juga", "aku ikut!", "seriusan?", "traktir dong", "sama, aku juga", "gas!"];

/** At a meeting table (prd.md §7.9). */
export const CHAT_MEETING = ["aku cek bagian ini ya", "tes-nya hijau!", "bentar, aku baca dulu", "siap, lanjut", "aku ambil yang ini", "oke, digabung ya"];

export function chatLine(info: Pick<FunInfo, "status" | "mode" | "activity" | "dept" | "meeting">): string {
  if (info.meeting) return pick(CHAT_MEETING);
  if (info.status === "thinking") return pick(CHAT_THINKING);
  if (info.status === "working") return pick(info.dept && Math.random() < 0.6 ? CHAT_BY_DEPT[info.dept] : CHAT_WORKING);
  const own = info.mode === "act" && info.activity ? CHAT_BY_ACTIVITY[info.activity] : undefined;
  return pick(own && Math.random() < 0.6 ? own : CHAT_IDLE);
}

/* ---------------- per-agent scheduling ---------------- */

export interface FunState {
  nextQuirk: number;
  nextChat: number;
  quirk: Quirk | null;
  /** Seconds into the current quirk. */
  quirkT: number;
  chat: { text: string; until: number } | null;
  reply: { text: string; at: number } | null;
  /** Sneeze puff already spawned for the current quirk. */
  sneezed?: boolean;
}

/** First action after 8-30 s, first chat after 12-40 s (keeps short visual tests calm). */
export const newFun = (now: number): FunState => ({
  nextQuirk: now + rand(8, 30),
  nextChat: now + rand(12, 40),
  quirk: null,
  quirkT: 0,
  chat: null,
  reply: null,
});

export const CHAT_SECONDS = 4.2;
export const MAX_CHATS = 3;

/** Shared across agents within one engine: how many balloons are open right now. */
export interface ChatSlots {
  open: number;
}

export interface FunStep {
  /** A quirk started this step. */
  quirk?: Quirk;
  /** A balloon opened this step (its text). */
  said?: string;
  /** That balloon answers a neighbour (replies never trigger further replies). */
  isReply?: boolean;
  /** The balloon closed this step. */
  closed?: boolean;
}

export function startQuirk(f: FunState, q: Quirk) {
  f.quirk = q;
  f.quirkT = 0;
  f.sneezed = false;
}

export function say(f: FunState, text: string, now: number, slots: ChatSlots, seconds = CHAT_SECONDS) {
  if (!f.chat) slots.open++;
  f.chat = { text, until: now + seconds };
}

/** Advance one frame. */
export function tickFun(f: FunState, info: FunInfo, now: number, dt: number, slots: ChatSlots): FunStep {
  const out: FunStep = {};
  const calm = CALM.includes(info.status);
  // current action
  if (f.quirk) {
    f.quirkT += dt;
    const allowed = allowedQuirks(info);
    if (f.quirkT >= QUIRK_DUR[f.quirk] || !allowed.includes(f.quirk)) {
      f.quirk = null;
      f.nextQuirk = now + rand(20, 60);
    }
  } else if (now >= f.nextQuirk) {
    const allowed = allowedQuirks(info);
    // Busy agents fidget less often than idle ones.
    if (allowed.length && (info.status === "idle" || Math.random() < 0.5)) {
      startQuirk(f, pick(allowed));
      out.quirk = f.quirk!;
    }
    f.nextQuirk = now + rand(20, 60);
  }
  // balloon
  if (f.chat && (now >= f.chat.until || !calm || !info.visible || info.hush)) {
    f.chat = null;
    slots.open = Math.max(0, slots.open - 1);
    out.closed = true;
  }
  const canTalk = calm && info.visible && !info.hush && info.mode !== "walk" && info.mode !== "fetch";
  if (!f.chat && f.reply && now >= f.reply.at) {
    if (canTalk && slots.open < MAX_CHATS) {
      say(f, f.reply.text, now, slots, 3);
      out.said = f.reply.text;
      out.isReply = true;
    }
    f.reply = null;
  } else if (!f.chat && now >= f.nextChat) {
    if (canTalk && slots.open < MAX_CHATS) {
      const text = chatLine(info);
      say(f, text, now, slots);
      out.said = text;
      f.nextChat = now + rand(25, 70);
    } else f.nextChat = now + rand(5, 15);
  }
  return out;
}
