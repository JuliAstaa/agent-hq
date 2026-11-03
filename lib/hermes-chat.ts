// Hermes chat (docs/hermes.md "Chat Hermes"): the conversation the Agent HQ server holds with the Hermes API server,
// as the chat panel sees it. Shared by the bridge (lib/bridge/hermes-chat.ts, which builds it) and the panel
// (components/HermesPanel.tsx, which applies the events). Pure types and functions only.

import { siblingApiUrl } from "./api-url";

export type ApprovalChoice = "once" | "session" | "always" | "deny";
export const APPROVAL_CHOICES: ApprovalChoice[] = ["once", "session", "always", "deny"];
export const APPROVAL_LABEL: Record<ApprovalChoice, string> = {
  once: "Izinkan sekali",
  session: "Izinkan sesi ini",
  always: "Selalu izinkan",
  deny: "Tolak",
};

export type ToolStatus = "running" | "ok" | "error";

export type ChatItem =
  | { kind: "user"; id: string; text: string; at: number }
  | { kind: "assistant"; id: string; text: string; streaming: boolean; at: number }
  | { kind: "tool"; id: string; name: string; preview: string; status: ToolStatus; at: number }
  | { kind: "note"; id: string; text: string; tone: "info" | "error"; at: number }
  | {
      kind: "approval";
      id: string;
      command: string;
      description: string;
      choices: ApprovalChoice[];
      /** "pending" until answered; "expired" when the turn ended without an answer. */
      status: "pending" | "expired" | ApprovalChoice;
      at: number;
    };

/** idle: ready for a message. starting: creating the session / opening the stream. approval: waiting for a choice. */
export type ChatPhase = "idle" | "starting" | "running" | "approval" | "stopping";

export interface ChatView {
  sessionId: string | null;
  title: string;
  phase: ChatPhase;
  /** Hermes is reasoning (no text or tool yet). */
  thinking: boolean;
  items: ChatItem[];
}

/** Server -> panel events on GET /api/hermes/stream. */
export type ChatEvent =
  | { type: "chat_snapshot"; view: ChatView }
  | { type: "chat_item"; item: ChatItem }
  | { type: "chat_delta"; id: string; delta: string }
  | { type: "chat_state"; phase: ChatPhase; thinking: boolean; sessionId: string | null; title: string };

/** Items kept by the bridge and by the panel (oldest dropped first, same rule on both sides). */
export const MAX_CHAT_ITEMS = 300;
/** Longest text of one assistant item; the rest of a runaway answer is dropped. */
export const MAX_CHAT_TEXT = 40_000;
/** Longest message a viewer can send. */
export const MAX_CHAT_MESSAGE = 8000;

export const PHASE_LABEL: Record<ChatPhase, { label: string; color: string }> = {
  idle: { label: "Siap", color: "#a6e22e" },
  starting: { label: "Mengirim", color: "#ffd23f" },
  running: { label: "Bekerja", color: "#ffd23f" },
  approval: { label: "Menunggu izin", color: "#ff9f1c" },
  stopping: { label: "Menghentikan", color: "#ff9f1c" },
};

export const emptyChatView = (): ChatView => ({ sessionId: null, title: "", phase: "idle", thinking: false, items: [] });

export const appendCapped = (text: string, delta: string): string =>
  text.length >= MAX_CHAT_TEXT ? text : (text + delta).slice(0, MAX_CHAT_TEXT);

/** Insert or replace an item by id, keeping the newest MAX_CHAT_ITEMS. */
export function upsertItem(items: ChatItem[], item: ChatItem): ChatItem[] {
  const i = items.findIndex((x) => x.id === item.id);
  if (i >= 0) {
    const next = items.slice();
    next[i] = item;
    return next;
  }
  const next = [...items, item];
  return next.length > MAX_CHAT_ITEMS ? next.slice(next.length - MAX_CHAT_ITEMS) : next;
}

/** Apply one stream event to the panel's copy of the conversation. */
export function applyChatEvent(view: ChatView, ev: ChatEvent): ChatView {
  switch (ev.type) {
    case "chat_snapshot":
      return ev.view;
    case "chat_item":
      return { ...view, items: upsertItem(view.items, ev.item) };
    case "chat_delta": {
      const i = view.items.findIndex((x) => x.id === ev.id);
      const it = view.items[i];
      if (!it || it.kind !== "assistant") return view;
      const items = view.items.slice();
      items[i] = { ...it, text: appendCapped(it.text, ev.delta) };
      return { ...view, items };
    }
    case "chat_state":
      return { ...view, phase: ev.phase, thinking: ev.thinking, sessionId: ev.sessionId, title: ev.title };
    default:
      return view;
  }
}

/** Chat endpoint next to the live stream: /api/stream -> /api/hermes. */
export const hermesUrlFor = (streamUrl: string | null, base: string): string | null => siblingApiUrl(streamUrl, base, "hermes");
