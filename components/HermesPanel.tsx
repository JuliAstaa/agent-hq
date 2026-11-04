"use client";

// Hermes chat panel (docs/hermes.md "Chat Hermes"): talk to Hermes from the office while watching it work. The Agent
// HQ server holds the conversation with the Hermes API server (lib/bridge/hermes-chat.ts); this panel reads it from
// GET /api/hermes/stream and sends actions to POST /api/hermes. Hermes keeps working when the panel is closed.
// Riwayat switches between sessions, Baru starts one with its own office character, and each session can have its
// own model. Every Hermes string is rendered as React text.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { useStore } from "zustand";
import { ago } from "@/lib/cron";
import {
  APPROVAL_LABEL, CHAT_TEAMS, CHAT_TEAM_LABEL, DEFAULT_CHAT_AGENT, MAX_CHAT_MESSAGE, MAX_CHAT_TOPIC, PHASE_LABEL,
  applyChatEvent, displayTitle, emptyChatView, hermesUrlFor, modelFromKey, modelKey, modelLabel,
  type ApprovalChoice, type ChatEvent, type ChatItem, type ChatSession, type ChatTeam, type ChatView, type ModelChoice,
  type ModelOptions, type ToolStatus,
} from "@/lib/hermes-chat";
import { sseFrames } from "@/lib/sse";
import { hqStore } from "@/lib/store";
import { authHeader, readToken, saveToken } from "./token";
import { Button, CARD, OFF, PILL, cn } from "./ui";

type Conn = "connecting" | "open" | "down" | "auth";
/** What the middle of the panel shows. */
type Mode = "chat" | "history" | "new";
type Reply = Record<string, unknown> & { ok?: boolean; error?: string };

const TOOL_DOT: Record<ToolStatus, string> = { running: "#ffd23f", ok: "#a6e22e", error: "#ff4f5e" };
const FIELD = "w-full font-[inherit] text-[13px] px-2 py-[5px] border-[2.5px] border-ink rounded-[10px] bg-white disabled:opacity-60";
const NOTE = "m-0 text-[12.5px] border-2 border-ink rounded-[10px] px-[10px] py-[6px]";
const here = () => (typeof location === "undefined" ? "http://localhost/" : location.href);

/** Model picker: Hermes' default, then the models of each authenticated provider. */
function ModelSelect({ value, options, onChange, disabled, id }: { value: ModelChoice | null; options: ModelOptions | null; onChange: (m: ModelChoice | null) => void; disabled?: boolean; id?: string }) {
  const key = modelKey(value);
  const listed = !value || !!options?.providers.some((p) => p.slug === value.provider && p.models.includes(value.model));
  return (
    <select id={id} className={FIELD} value={key} disabled={disabled} onChange={(e) => onChange(modelFromKey(e.target.value))}>
      <option value="">Default Hermes{options?.current ? `: ${options.current.model}` : ""}</option>
      {!listed && value && <option value={key}>{modelLabel(value)}</option>}
      {options?.providers.map((p) => (
        <optgroup key={p.slug} label={p.name}>
          {p.models.map((m) => (
            <option key={m} value={modelKey({ provider: p.slug, model: m })}>
              {m}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

/** One line on Hermes' memory for the API server (hidden when Hermes did not say). */
function MemoryLine({ options }: { options: ModelOptions | null }) {
  if (!options || options.memory == null) return null;
  const on = options.memory;
  const text = !on
    ? "Memori Hermes mati untuk API server. Nyalakan: hermes tools enable memory --platform api_server"
    : options.sessionSearch === false
      ? "Memori Hermes aktif. Pencarian sesi lama mati: hermes tools enable session_search --platform api_server"
      : "Memori Hermes aktif, dipakai bersama semua sesi.";
  return (
    <span className="flex items-center gap-[5px]" title="Memori, skill, dan pencarian sesi lama Hermes berlaku untuk semua sesi">
      <i className="inline-block w-[9px] h-[9px] rounded-full border-2 border-ink shrink-0" style={{ background: on ? "#a6e22e" : "#ff9f1c" }} />
      {text}
    </span>
  );
}

function SessionRow({
  s, now, current, busy, onOpen, onRename, onDelete,
}: {
  s: ChatSession;
  now: number;
  current: boolean;
  busy: boolean;
  onOpen: () => void;
  onRename: (title: string) => Promise<boolean>;
  onDelete: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [confirm, setConfirm] = useState(false);
  const title = displayTitle(s.title) || "(tanpa judul)";
  const running = !!s.phase && s.phase !== "idle";
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (draft.trim() && (await onRename(draft.trim()))) setRenaming(false);
  };
  return (
    <div className={cn("border-[2.5px] border-ink rounded-[12px] px-[10px] py-2 text-[13px]", current ? "bg-paper2 shadow-[3px_3px_0_var(--ink)]" : "bg-white")}>
      {renaming ? (
        <form
          className="flex gap-[6px] items-center"
          onSubmit={submit}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.stopPropagation(); // Esc closes the rename, not the panel
            setRenaming(false);
          }}
        >
          <input className={FIELD} value={draft} maxLength={MAX_CHAT_TOPIC} autoFocus aria-label="Judul sesi" onChange={(e) => setDraft(e.target.value)} />
          <Button size="log" tone="primary" type="submit" className={OFF} disabled={busy || !draft.trim()}>
            Simpan
          </Button>
          <Button size="log" onClick={() => setRenaming(false)}>
            Batal
          </Button>
        </form>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <b className="flex-1 min-w-0 truncate" title={title}>
              {title}
            </b>
            {current && (
              <span className={PILL} style={{ background: "#a6e22e" }}>
                Dibuka
              </span>
            )}
            {running && <span className={PILL} style={{ background: PHASE_LABEL[s.phase!].color }}>{PHASE_LABEL[s.phase!].label}</span>}
          </div>
          {s.preview && <div className="truncate text-[12px] opacity-75">{s.preview}</div>}
          <div className="text-[11.5px] opacity-70">
            {s.lastActive && now ? ago(s.lastActive, now) : "waktu tidak diketahui"} · {s.messages} pesan{s.agent ? ` · Agen: ${s.agent}` : ""}
          </div>
          {confirm ? (
            <div className="mt-[6px] flex gap-[6px] items-center flex-wrap text-[12px]">
              <span className="font-semibold">Hapus sesi ini dari Hermes? Riwayatnya dan agennya ikut hilang.</span>
              <Button size="log" tone="alert" className={OFF} disabled={busy || running} onClick={onDelete}>
                Ya, hapus
              </Button>
              <Button size="log" onClick={() => setConfirm(false)}>
                Batal
              </Button>
            </div>
          ) : (
            <div className="mt-[6px] flex gap-[6px] flex-wrap">
              {!current && (
                <Button size="log" tone="primary" className={OFF} disabled={busy} title="Lanjutkan sesi ini" onClick={onOpen}>
                  Buka
                </Button>
              )}
              <Button
                size="log"
                className={OFF}
                disabled={busy}
                onClick={() => {
                  setDraft(displayTitle(s.title));
                  setRenaming(true);
                }}
              >
                Ganti nama
              </Button>
              <Button size="log" className={OFF} disabled={busy || running} onClick={() => setConfirm(true)}>
                Hapus
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

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
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draftKey = view.sessionId ?? "";
  const draft = drafts[draftKey] ?? "";
  const setDraft = (value: string | ((previous: string) => string)) => setDrafts((all) => ({
    ...all, [draftKey]: typeof value === "function" ? value(all[draftKey] ?? "") : value,
  }));
  const [busy, setBusy] = useState(false);
  const [tokenDraft, setTokenDraft] = useState("");
  const [tokenRev, setTokenRev] = useState(0);
  const [mode, setMode] = useState<Mode>("chat");
  const [sessions, setSessions] = useState<ChatSession[] | null>(null);
  const [sessionsErr, setSessionsErr] = useState("");
  /** Server clock when the list was loaded: its "5 mnt lalu" texts count from here. */
  const [sessionsAt, setSessionsAt] = useState(0);
  const [models, setModels] = useState<ModelOptions | null>(null);
  const [modelsErr, setModelsErr] = useState("");
  const [newAgent, setNewAgent] = useState<{ name: string; role: string; team: ChatTeam; model: ModelChoice | null }>({ name: "", role: "", team: "office", model: null });
  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const agent = useStore(hqStore, (s) => (view.agentId ? s.agents.get(view.agentId) : undefined));

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
      if (e.key !== "Escape") return;
      if (mode !== "chat") setMode("chat"); // Riwayat / Sesi baru: back to the conversation first
      else if (!hasDraft) onClose(); // never drop a typed message
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, hasDraft, mode]);

  // Follow new messages only while the list is scrolled to the bottom.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [view, mode]);

  /** POST one action. Returns the reply, or the error text (also shown in the panel unless `quiet`). */
  const request = useCallback(async (body: Record<string, unknown>, quiet = false): Promise<Reply | string> => {
    if (!url) return "Chat tidak tersambung";
    try {
      const token = readToken();
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...authHeader(token) }, body: JSON.stringify(body) });
      if (res.status === 401) {
        setConn("auth");
        setConnErr(token ? "Token salah. Masukkan lagi." : "Agent HQ memakai HQ_TOKEN. Masukkan tokennya dulu.");
        return "token salah";
      }
      const b = (await res.json().catch(() => null)) as Reply | null;
      if (!res.ok || !b) {
        const why = b?.error || `Gagal (HTTP ${res.status})`;
        if (!quiet) setErr(why);
        return why;
      }
      if (!quiet) setErr("");
      return b;
    } catch (e) {
      const why = `Agent HQ tidak bisa dihubungi: ${(e as Error).message}`;
      if (!quiet) setErr(why);
      return why;
    }
  }, [url]);

  /** Like request(), with the buttons disabled meanwhile; true when it worked. */
  async function post(body: Record<string, unknown>): Promise<boolean> {
    setBusy(true);
    try {
      const targeted = ["send", "approve", "stop", "model"].includes(String(body.action));
      return typeof (await request(targeted ? { ...body, sessionId: view.sessionId } : body)) !== "string";
    } finally {
      setBusy(false);
    }
  }

  const phase = view.phase;
  const working = phase !== "idle";
  const ready = conn === "open";

  // The model list (and whether Hermes' memory is on) once the chat is connected; it does not block the buttons.
  const modelsWanted = ready && !models && !modelsErr;
  useEffect(() => {
    if (!modelsWanted || !url) return;
    const ac = new AbortController();
    async function load() {
      try {
        const res = await fetch(url!, {
          method: "POST",
          headers: { "content-type": "application/json", ...authHeader(readToken()) },
          body: JSON.stringify({ action: "models" }),
          signal: ac.signal,
        });
        const b = (await res.json().catch(() => null)) as (ModelOptions & { error?: string }) | null;
        if (!res.ok || !b) return setModelsErr(b?.error || `Gagal (HTTP ${res.status})`);
        setModels(b);
        if (b.error) setModelsErr(b.error);
      } catch (e) {
        if (!ac.signal.aborted) setModelsErr(`Agent HQ tidak bisa dihubungi: ${(e as Error).message}`);
      }
    }
    void load();
    return () => ac.abort();
  }, [modelsWanted, url]);

  const loadSessions = useCallback(async () => {
    setSessionsErr("");
    const r = await request({ action: "sessions" }, true);
    if (typeof r === "string") return setSessionsErr(r);
    setSessionsAt(typeof r.now === "number" ? r.now : 0);
    setSessions(Array.isArray(r.sessions) ? (r.sessions as ChatSession[]) : []);
  }, [request]);

  useEffect(() => {
    if (mode !== "history" || !ready) return;
    const timer = setInterval(() => void loadSessions(), 3000);
    return () => clearInterval(timer);
  }, [mode, ready, loadSessions]);

  async function send() {
    const text = draft.trim();
    if (!text || working || busy || !ready) return;
    setDraft("");
    stick.current = true;
    if (!(await post({ action: "send", text }))) setDraft((d) => d || text);
  }

  async function startNew(e: FormEvent) {
    e.preventDefault();
    const { name, role, team, model } = newAgent;
    // Nothing filled in: an unnamed "Hermes" character (no name pinned, nothing extra told to Hermes).
    const named = name.trim() || role.trim() || team !== "office";
    if (!(await post({ action: "new", model, ...(named ? { agent: { name, role, team } } : {}) }))) return;
    setNewAgent({ name: "", role: "", team: "office", model });
    setMode("chat");
    stick.current = true;
  }

  async function openSession(id: string) {
    if (await post({ action: "open", sessionId: id })) {
      setMode("chat");
      stick.current = true;
    }
  }

  async function renameSession(id: string, title: string): Promise<boolean> {
    const done = await post({ action: "rename", sessionId: id, title });
    if (done) void loadSessions();
    return done;
  }

  async function deleteSession(id: string) {
    if (await post({ action: "delete", sessionId: id })) void loadSessions();
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
          tone={mode === "history" ? "primary" : "paper"}
          title="Sesi lama: lanjutkan, ganti nama, atau hapus"
          aria-pressed={mode === "history"}
          disabled={!ready}
          onClick={() => {
            if (mode === "history") return setMode("chat");
            setMode("history");
            setSessions(null);
            void loadSessions();
          }}
        >
          Riwayat
        </Button>
        <Button
          size="log"
          className={OFF}
          tone={mode === "new" ? "primary" : "paper"}
          title="Mulai sesi baru dengan agen baru di kantor. Sesi lama tetap tersimpan di Hermes."
          aria-pressed={mode === "new"}
          disabled={!ready || busy}
          onClick={() => {
            if (mode === "new") return setMode("chat");
            setNewAgent((a) => ({ ...a, model: view.model }));
            setMode("new");
          }}
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
            Sesi: <b className="break-all">{displayTitle(view.title)}</b>
          </>
        )}
      </p>
      {ready && (
        <div className="px-3 py-[6px] border-b-2 border-ink flex flex-col gap-1 text-[12px]">
          <div className="flex items-center gap-2">
            <label htmlFor="hq-hermes-model" className="font-bold shrink-0">
              Model
            </label>
            <div className="flex-1 min-w-0">
              <ModelSelect id="hq-hermes-model" value={view.model} options={models} disabled={busy} onChange={(model) => void post({ action: "model", model })} />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-[2px] opacity-85">
            {view.agentId && (
              <button
                type="button"
                className="[font-family:inherit] text-[12px] p-0 bg-transparent border-0 underline cursor-pointer text-left"
                title="Lihat agen sesi ini di kantor"
                onClick={() => hqStore.getState().select(view.agentId, true)}
              >
                Agen: {agent ? `${agent.name} (${agent.role})` : DEFAULT_CHAT_AGENT.name}
              </button>
            )}
            {view.runtime && <span title="Model yang menjawab pesan terakhir">Terakhir dijawab: {modelLabel(view.runtime)}</span>}
            <MemoryLine options={models} />
          </div>
          {modelsErr && <span className="text-[11.5px] opacity-80">Daftar model: {modelsErr}</span>}
        </div>
      )}
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
      {mode === "history" && (
        <div className="flex-1 overflow-auto px-3 py-[10px] flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <b className="text-[13px]">Riwayat sesi</b>
            <span className="flex-1" />
            <Button size="log" onClick={() => void loadSessions()}>
              Muat ulang
            </Button>
            <Button size="log" onClick={() => setMode("chat")}>
              Kembali
            </Button>
          </div>
          <p className={cn(NOTE, "bg-[#ffe6a6]")}>Sesi yang sedang bekerja tetap berjalan saat kamu membuka sesi lain atau membuat sesi baru.</p>
          {sessionsErr && <p className={cn(NOTE, "bg-[#ffd0d4]")}>{sessionsErr}</p>}
          {sessions === null && !sessionsErr && <p className="m-0 text-[13px] opacity-70">Memuat riwayat...</p>}
          {sessions?.length === 0 && <p className="m-0 text-[13px] opacity-70">Belum ada sesi. Tekan Baru untuk mulai.</p>}
          {sessions?.map((s) => (
            <SessionRow
              key={s.id}
              s={s}
              now={sessionsAt}
              current={s.id === view.sessionId}
              busy={busy}
              onOpen={() => void openSession(s.id)}
              onRename={(title) => renameSession(s.id, title)}
              onDelete={() => void deleteSession(s.id)}
            />
          ))}
          <p className="m-0 text-[11.5px] leading-[1.4] opacity-70">
            Hanya sesi yang dibuat lewat API server Hermes yang bisa dilanjutkan di sini. Sesi CLI, Telegram, dan Discord tetap di tempatnya.
          </p>
        </div>
      )}
      {mode === "new" && (
        <form className="flex-1 overflow-auto px-3 py-[10px] flex flex-col gap-2" onSubmit={(e) => void startNew(e)}>
          <b className="text-[14px]">Sesi baru</b>
          <p className="m-0 text-[12px] leading-[1.4] opacity-80">
            Agen baru langsung muncul di kantor. Sesi lama tetap tersimpan di Riwayat, dan memori Hermes tetap dipakai bersama semua sesi.
          </p>
          <label className="text-[12px] font-bold">
            Nama
            <input className={FIELD} value={newAgent.name} maxLength={60} placeholder={DEFAULT_CHAT_AGENT.name} autoFocus onChange={(e) => setNewAgent((a) => ({ ...a, name: e.target.value }))} />
          </label>
          <label className="text-[12px] font-bold">
            Peran
            <input className={FIELD} value={newAgent.role} maxLength={60} placeholder={DEFAULT_CHAT_AGENT.role} onChange={(e) => setNewAgent((a) => ({ ...a, role: e.target.value }))} />
          </label>
          <label className="text-[12px] font-bold">
            Tim
            <select className={FIELD} value={newAgent.team} onChange={(e) => setNewAgent((a) => ({ ...a, team: e.target.value as ChatTeam }))}>
              {CHAT_TEAMS.map((t) => (
                <option key={t} value={t}>
                  {CHAT_TEAM_LABEL[t]}
                </option>
              ))}
            </select>
          </label>
          <label className="text-[12px] font-bold">
            Model
            <ModelSelect value={newAgent.model} options={models} onChange={(model) => setNewAgent((a) => ({ ...a, model }))} />
          </label>
          {modelsErr && (
            <span className="flex items-center gap-2 text-[11.5px] opacity-80">
              Daftar model belum ada.
              <Button
                size="log"
                onClick={() => {
                  setModels(null);
                  setModelsErr("");
                }}
              >
                Coba lagi
              </Button>
            </span>
          )}
          <p className="m-0 text-[11.5px] leading-[1.4] opacity-70">
            Nama, peran, dan tim juga diberitahukan ke Hermes di setiap pesan sesi ini. Kosongkan untuk agen Hermes biasa.
          </p>
          <div className="flex gap-2 justify-end">
            <Button onClick={() => setMode("chat")}>Batal</Button>
            <Button tone="primary" type="submit" className={OFF} disabled={!ready || busy}>
              {busy ? "Membuat..." : "Mulai sesi"}
            </Button>
          </div>
        </form>
      )}
      {mode === "chat" && (
      <>
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
      </>
      )}
    </section>
  );
}
