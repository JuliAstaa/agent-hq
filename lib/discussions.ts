// Shared discussion wire types. Only the guarded meeting stream includes transcripts.
import type { ApprovalChoice, ModelChoice } from "./hermes-chat";

export const MEETING_OPEN_EVENT = "hq:meeting-open";
export const MAX_GOAL = 2000;
export const MAX_DISCUSSION_TEXT = 12000;
export type DiscussionPhase = "starting" | "running" | "approval" | "summarizing" | "stopping" | "done" | "stopped" | "error";
export const DISCUSSION_LABEL: Record<DiscussionPhase, string> = {
  starting: "Menyiapkan", running: "Diskusi", approval: "Menunggu izin", summarizing: "Merangkum",
  stopping: "Menghentikan", done: "Selesai", stopped: "Dihentikan", error: "Terputus",
};
export const discussionActive = (phase: DiscussionPhase) => ["starting", "running", "approval", "summarizing", "stopping"].includes(phase);
export interface DiscussionParticipant {
  sessionId: string;
  agentId: string;
  name: string;
  role: string;
  model: ModelChoice | null;
}
export interface DiscussionSummary {
  id: string;
  room: number;
  goal: string;
  phase: DiscussionPhase;
  round: number;
  rounds: number;
  speaker: string | null;
  participants: DiscussionParticipant[];
  since: number;
  error: string;
}
export interface DiscussionMessage {
  id: string;
  kind: "agent" | "user" | "summary" | "note" | "approval" | "tool";
  name: string;
  agentId: string | null;
  text: string;
  round: number;
  at: number;
  streaming: boolean;
  approval?: { sessionId: string; itemId: string; choices: ApprovalChoice[]; status: string };
}
export interface DiscussionView extends DiscussionSummary {
  messages: DiscussionMessage[];
  summary: string;
}
export function discussionSummary(view: DiscussionView): DiscussionSummary {
  const { id, room, goal, phase, round, rounds, speaker, participants, since, error } = view;
  return { id, room, goal, phase, round, rounds, speaker, participants, since, error };
}

/** Malformed office events must never assign seats or create an agent. */
export function readDiscussion(value: unknown): DiscussionSummary | null {
  if (!value || typeof value !== "object") return null;
  const d = value as DiscussionSummary;
  if (typeof d.id !== "string" || !d.id || !Number.isInteger(d.room) || d.room < 0 || d.room > 2
    || !Object.hasOwn(DISCUSSION_LABEL, d.phase) || typeof d.goal !== "string" || d.goal.length > MAX_GOAL
    || !Number.isFinite(d.since) || !Number.isInteger(d.rounds) || d.rounds < 1 || d.rounds > 5
    || !Number.isInteger(d.round) || d.round < 0 || d.round > d.rounds
    || !Array.isArray(d.participants) || d.participants.length < 2 || d.participants.length > 5) return null;
  if (!d.participants.every((p) => p && typeof p.agentId === "string" && typeof p.sessionId === "string" && typeof p.name === "string" && typeof p.role === "string")) return null;
  if (new Set(d.participants.map((p) => p.agentId)).size !== d.participants.length) return null;
  return d;
}
