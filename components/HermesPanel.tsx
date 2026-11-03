"use client";

// Hermes chat panel (docs/hermes.md "Chat Hermes"): talk to Hermes from the office while watching it work. The Agent
// HQ server holds the conversation with the Hermes API server (lib/bridge/hermes-chat.ts); this panel reads it from
// GET /api/hermes/stream and sends actions to POST /api/hermes. Hermes keeps working when the panel is closed.
// Every Hermes string is rendered as React text.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import {
  APPROVAL_LABEL, MAX_CHAT_MESSAGE, PHASE_LABEL, applyChatEvent, emptyChatView, hermesUrlFor,
  type ApprovalChoice, type ChatEvent, type ChatItem, type ChatView, type ToolStatus,
} from "@/lib/hermes-chat";
import { sseFrames } from "@/lib/sse";
import { hqStore } from "@/lib/store";
import { authHeader, readToken, saveToken } from "./token";
import { Button, CARD, OFF, PILL, cn } from "./ui";

type Conn = "connecting" | "open" | "down" | "auth";

const TOOL_DOT: Record<ToolStatus, string> = { running: "#ffd23f", ok: "#a6e22e", error: "#ff4f5e" };
const here = () => (typeof location === "undefined" ? "http://localhost/" : location.href);

/** True when the page is live on an Agent HQ server whose Hermes chat is configured (GET /api/hermes). */
export function useHermesAvailable(liveUrl: () => string | null): boolean {
  const live = useStore(hqStore, (s) => s.conn.mode === "live");
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    const url = live ? hermesUrlFor(liveUrl(), here()) : null;
    if (!url) return;
    const ac = new AbortController();
    fetch(url, { signal: ac.signal, cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { enabled?: boolean } | null) => setEnabled(!!b?.enabled))
      .catch(() => {});
    return () => ac.abort();
  }, [live, liveUrl]);
  return live && enabled;
}

function ApprovalCard({ item, busy, onAnswer }: { item: Extract<ChatItem, { kind: "approval" }>; busy: boolean; onAnswer: (c: ApprovalChoice) => void }) {
  return (
    <div className="self-stretch bg-[#ffe6a6] border-[2.5px] border-ink rounded-[12px] px-[10px] py-2 text-[13px]">
      <b>Hermes minta izin</b>
      {item.command && <pre className="m-0 mt-1 font-mono text-[12px] bg-white border-2 border-ink rounded-[8px] px-2 py-1 whitespace-pre-wrap break-all">{item.command}</pre>}
      {item.description && <div className="mt-1 text-[12.5px]">{item.description}</div>}
      {item.status === "pending" ? (
        <div className="flex gap-[6px] flex-wrap mt-2">
          {item.choices.map((c) => (
            <Button key={c} size="log" className={OFF} disabled={busy} tone={c === "deny" ? "alert" : c === "once" ? "primary" : "paper"} onClick={() => onAnswer(c)}>
              {APPROVAL_LABEL[c]}
            </Button>
          ))}
        </div>
      ) : (
        <div className="mt-1 text-[12px] font-semibold">{item.status === "expired" ? "Tidak dijawab (pekerjaan sudah selesai)" : `Dijawab: ${APPROVAL_LABEL[item.status]}`}</div>
      )}
    </div>
  );
}

function ChatRow({ item, busy, onAnswer }: { item: ChatItem; busy: boolean; onAnswer: (id: string, c: ApprovalChoice) => void }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="self-end max-w-[85%] bg-thinking border-[2.5px] border-ink rounded-[12px] rounded-br-[4px] shadow-[2px_2px_0_var(--ink)] px-[10px] py-[6px] text-[13.5px] whitespace-pre-wrap break-words">
          {item.text}
        </div>
      );
    case "assistant":
      return (
        <div className="self-start max-w-[92%] bg-white border-[2.5px] border-ink rounded-[12px] rounded-bl-[4px] px-[10px] py-[6px] text-[13.5px] whitespace-pre-wrap break-words">
          {item.text}
          {item.streaming && <span className="animate-[hq-pulse_1.4s_infinite]">▍</span>}
        </div>
      );
    case "tool":
      return (
        <div className="self-start flex items-center gap-[6px] max-w-full font-mono text-[12px]" title={item.preview}>
          <i
            className={cn("inline-block w-[10px] h-[10px] rounded-full border-2 border-ink shrink-0", item.status === "running" && "animate-[hq-pulse_1.4s_infinite]")}
            style={{ background: TOOL_DOT[item.status] }}
          />
          <b className="shrink-0">{item.name}</b>
          <span className="truncate opacity-80">{item.preview}</span>
        </div>
      );
    case "note":
      return (
        <div className={cn("self-center max-w-[95%] text-[12px] px-2 py-[3px] border-2 border-ink rounded-[8px] break-words", item.tone === "error" ? "bg-[#ffd0d4]" : "bg-paper2")}>
          {item.text}
        </div>
      );
    case "approval":
      return <ApprovalCard item={item} busy={busy} onAnswer={(c) => onAnswer(item.id, c)} />;
  }
}

export default function HermesPanel({ onClose, liveUrl }: { onClose: () => void; liveUrl: () => string | null }) {
  const [url] = useState(() => hermesUrlFor(liveUrl(), here()));
  const [view, setView] = useState<ChatView>(emptyChatView);
  const [conn, setConn] = useState<Conn>("connecting");
  const [connErr, setConnErr] = useState("");
  const [err, setErr] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [tokenDraft, setTokenDraft] = useState("");
  const [tokenRev, setTokenRev] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // Read the conversation; reconnect after a drop (the server keeps it, nothing is lost).
  useEffect(() => {
    if (!url) return;
    const ac = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    const again = (ms: number, why: string) => {
      setConn("down");
      setConnErr(why);
      retry = setTimeout(run, ms);
    };
    async function run() {
      const token = readToken();
      try {
        const res = await fetch(`${url}/stream`, { headers: authHeader(token), signal: ac.signal, cache: "no-store" });
        if (res.status === 401) {
          setConn("auth");
          setConnErr(token ? "Token salah. Masukkan lagi." : "Agent HQ memakai HQ_TOKEN. Masukkan tokennya dulu.");
          return;
        }
        if (!res.ok || !res.body) {
          const b = (await res.json().catch(() => null)) as { error?: string } | null;
          if (res.status === 403 || res.status === 404) {
            setConn("down");
            setConnErr(b?.error || `Chat Hermes tidak tersedia (HTTP ${res.status})`);
            return;
          }
          return again(3000, b?.error || `Gagal membuka chat (HTTP ${res.status}), mencoba lagi...`);
        }
        setConn("open");
        setConnErr("");
        for await (const { data } of sseFrames(res.body)) {
          let ev: ChatEvent;
          try {
            ev = JSON.parse(data) as ChatEvent;
          } catch {
            continue;
          }
          setView((v) => applyChatEvent(v, ev));
        }
        if (!ac.signal.aborted) again(2000, "Koneksi chat terputus, menyambung lagi...");
      } catch {
        if (!ac.signal.aborted) again(3000, "Agent HQ tidak bisa dihubungi, menyambung lagi...");
      }
    }
    void run();
    return () => {
      ac.abort();
      clearTimeout(retry);
    };
  }, [url, tokenRev]);

  const hasDraft = draft.trim() !== "";
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !hasDraft) onClose(); // never drop a typed message
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, hasDraft]);

  // Follow new messages only while the list is scrolled to the bottom.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [view]);

  async function post(body: Record<string, unknown>): Promise<boolean> {
    if (!url) return false;
    setBusy(true);
    try {
      const token = readToken();
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...authHeader(token) }, body: JSON.stringify(body) });
      if (res.status === 401) {
        setConn("auth");
        setConnErr(token ? "Token salah. Masukkan lagi." : "Agent HQ memakai HQ_TOKEN. Masukkan tokennya dulu.");
        return false;
      }
      if (!res.ok) {
        const b = (await res.json().catch(() => null)) as { error?: string } | null;
        setErr(b?.error || `Gagal (HTTP ${res.status})`);
        return false;
      }
      setErr("");
      return true;
    } catch (e) {
      setErr(`Agent HQ tidak bisa dihubungi: ${(e as Error).message}`);
      return false;
    } finally {
      setBusy(false);
    }
  }

  const phase = view.phase;
  const working = phase !== "idle";
  const ready = conn === "open";

  async function send() {
    const text = draft.trim();
    if (!text || working || busy || !ready) return;
    setDraft("");
    stick.current = true;
    if (!(await post({ action: "send", text }))) setDraft((d) => d || text);
  }

  const pill = ready ? PHASE_LABEL[phase] : conn === "auth" ? { label: "Butuh token", color: "#ff9f1c" } : conn === "connecting" ? { label: "Menyambung", color: "#ffd23f" } : { label: "Terputus", color: "#ff4f5e" };
  const status = phase === "approval" ? "Menunggu izin kamu..." : phase === "stopping" ? "Menghentikan..." : view.thinking ? "Hermes sedang berpikir..." : "Hermes bekerja...";

  return (
    <section
      data-hq-ui="hermes"
      role="dialog"
      aria-label="Chat Hermes"
      className={cn(
        CARD,
        "fixed top-[84px] right-[14px] bottom-[14px] w-[min(440px,calc(100vw-28px))] flex flex-col z-[6]",
        "max-[820px]:top-auto max-[820px]:h-[60vh] max-[820px]:w-auto max-[820px]:left-[14px]",
      )}
    >
      <header className="flex items-center gap-2 px-3 pt-[10px] pb-2 border-b-[3px] border-ink">
        <h2 className="m-0 font-display text-[15px]">HERMES</h2>
        <span className={PILL} style={{ background: pill.color }}>
          {pill.label}
        </span>
        <span className="flex-1" />
        <Button
          size="log"
          className={OFF}
          title="Mulai percakapan baru. Sesi lama tetap tersimpan di Hermes."
          disabled={!ready || working || busy || !view.items.length}
          onClick={() => void post({ action: "new" })}
        >
          Baru
        </Button>
        <Button size="log" onClick={onClose}>
          Tutup
        </Button>
      </header>
      <p className="m-0 px-3 py-[6px] text-[11.5px] leading-[1.4] border-b-2 border-ink bg-paper2">
        Pesan dijalankan Hermes di mesinnya dengan semua tool aktif. Hermes tetap bekerja walau panel ini ditutup.
        {view.title && (
          <>
            {" "}
            Sesi: <b className="break-all">{view.title}</b>
          </>
        )}
      </p>
      {!url && <p className="m-0 mx-3 mt-2 text-[13px] bg-[#ffe6a6] border-2 border-ink rounded-[10px] px-[10px] py-2">Chat hanya jalan saat halaman tersambung ke Agent HQ lewat /api/stream.</p>}
      {connErr && conn !== "open" && <p className="m-0 mx-3 mt-2 text-[13px] bg-[#ffd0d4] border-2 border-ink rounded-[10px] px-[10px] py-2">{connErr}</p>}
      {err && <p className="m-0 mx-3 mt-2 text-[13px] bg-[#ffd0d4] border-2 border-ink rounded-[10px] px-[10px] py-2">{err}</p>}
      {conn === "auth" && (
        <div className="flex gap-2 items-center mx-3 mt-2">
          <input
            type="password"
            value={tokenDraft}
            onChange={(e) => setTokenDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && tokenDraft.trim()) {
                saveToken(tokenDraft);
                setTokenDraft("");
                setTokenRev((n) => n + 1);
              }
            }}
            placeholder="HQ_TOKEN"
            className="flex-1 min-w-0 font-mono text-[13px] px-[10px] py-2 border-[2.5px] border-ink rounded-[10px] bg-white"
          />
          <Button
            tone="primary"
            className={OFF}
            disabled={!tokenDraft.trim()}
            onClick={() => {
              saveToken(tokenDraft);
              setTokenDraft("");
              setTokenRev((n) => n + 1);
            }}
          >
            Simpan token
          </Button>
        </div>
      )}
      <div
        ref={listRef}
        className="flex-1 overflow-auto px-3 py-[10px] flex flex-col gap-2"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 12;
        }}
      >
        {!view.items.length && ready && <p className="m-0 my-6 text-[13px] opacity-70 text-center">Belum ada pesan. Tulis perintah untuk Hermes di bawah.</p>}
        {view.items.map((it) => (
          <ChatRow key={it.id} item={it} busy={busy} onAnswer={(id, choice) => void post({ action: "approve", id, choice })} />
        ))}
        {working && ready && <div className="self-start text-[12px] italic opacity-75">{status}</div>}
      </div>
      <footer className="border-t-[3px] border-ink p-[10px] flex gap-2 items-end">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          rows={2}
          maxLength={MAX_CHAT_MESSAGE}
          disabled={!ready}
          aria-label="Pesan untuk Hermes"
          placeholder={working ? "Tunggu Hermes selesai atau tekan Hentikan" : "Tulis pesan (Enter kirim, Shift+Enter baris baru)"}
          className="flex-1 min-w-0 resize-none [font-family:inherit] text-[13.5px] px-[10px] py-2 border-[2.5px] border-ink rounded-[10px] bg-white max-h-[140px] disabled:opacity-60"
        />
        {working ? (
          <Button tone="alert" className={OFF} disabled={!ready || busy || phase === "stopping"} onClick={() => void post({ action: "stop" })}>
            Hentikan
          </Button>
        ) : (
          <Button tone="primary" className={OFF} disabled={!ready || busy || !draft.trim()} onClick={() => void send()}>
            Kirim
          </Button>
        )}
      </footer>
    </section>
  );
}
