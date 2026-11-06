"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { siblingApiUrl } from "@/lib/api-url";
import { DISCUSSION_LABEL, discussionActive, MAX_GOAL, type DiscussionParticipant, type DiscussionView } from "@/lib/discussions";
import { APPROVAL_LABEL, modelLabel, type ModelChoice, type ModelOptions } from "@/lib/hermes-chat";
import { MEETING_ROOMS } from "@/lib/meeting";
import { hqStore } from "@/lib/store";
import { sseFrames } from "@/lib/sse";
import { ModelSelect } from "./HermesPanel";
import { authHeader, readToken, saveToken } from "@/lib/token";
import { Button, CARD, OFF, PILL, cn } from "./ui";

const FIELD = "w-full box-border [font-family:inherit] text-[13px] px-2 py-[6px] border-[2.5px] border-ink rounded-[10px] bg-paper disabled:opacity-50";
type Candidate = DiscussionParticipant & { busy?: boolean };
type ResponseBody = { ok?: boolean; error?: string; participants?: Candidate[]; participant?: Candidate };
interface Draft { goal: string; selected: Candidate[]; rounds: number; creating: boolean; name: string; role: string; model: ModelChoice | null }
const draft = (): Draft => ({ goal: "", selected: [], rounds: 3, creating: false, name: "", role: "", model: null });

export default function MeetingPanel({ room, onRoom, onClose, liveUrl }: { room: number; onRoom: (room: number) => void; onClose: () => void; liveUrl: () => string | null }) {
  const conn = useStore(hqStore, (s) => s.conn);
  const occupancy = useStore(hqStore, (s) => s.meetings);
  const url = typeof window === "undefined" ? null : siblingApiUrl(liveUrl(), window.location.href, "meetings");
  const [rooms, setRooms] = useState<DiscussionView[]>([]);
  const [drafts, setDrafts] = useState<Record<number, Draft>>({ 0: draft(), 1: draft(), 2: draft() });
  const d = drafts[room];
  const edit = (change: Partial<Draft>) => setDrafts((all) => ({ ...all, [room]: { ...all[room], ...change } }));
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [models, setModels] = useState<ModelOptions | null>(null);
  const [modelError, setModelError] = useState("");
  const [forming, setForming] = useState<Record<number, boolean>>({});
  const [ready, setReady] = useState(false);
  const [auth, setAuth] = useState(false);
  const [token, setToken] = useState("");
  const [tokenRev, setTokenRev] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const [instruction, setInstruction] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [latest, setLatest] = useState(true);
  const view = rooms.find((v) => v.room === room);
  const active = !!view && discussionActive(view.phase);
  const setup = !active && (!view || forming[room]);
  const automatic = !!occupancy[room] && !occupancy[room]?.key.startsWith("d:");

  const request = useCallback(async (body: unknown, endpoint = url, signal?: AbortSignal) => {
    if (!endpoint) throw new Error("Sambungkan ke Agent HQ dengan Chat Hermes aktif untuk memulai diskusi.");
    const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", ...authHeader(readToken()) }, body: JSON.stringify(body), signal });
    const result = await response.json() as ResponseBody;
    if (response.status === 401) setAuth(true);
    if (!response.ok || !result.ok) throw new Error(result.error || `Permintaan gagal (HTTP ${response.status})`);
    return result;
  }, [url]);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const result = await request({ action: "participants" }, url, signal);
    setCandidates(result.participants ?? []);
  }, [request, url]);

  useEffect(() => {
    const ac = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = async () => {
      if (!url || conn.mode === "demo") return;
      try {
        const response = await fetch(url + "/stream", { headers: authHeader(readToken()), signal: ac.signal });
        if (!response.ok) {
          const body = await response.json();
          if (response.status === 401) setAuth(true);
          throw new Error(body.error || "Koneksi meeting terputus");
        }
        setReady(true); setAuth(false); setError("");
        void refresh(ac.signal).catch((e) => { if (!ac.signal.aborted) setError(e.message); });
        void request({ action: "models" }, url.replace(/\/meetings$/, "/hermes"), ac.signal).then((value) => {
          const result = value as unknown as ModelOptions & { error?: string };
          setModels(result);
          setModelError(result.error || "");
        }).catch((e) => { if (!ac.signal.aborted) setModelError(e.message); });
        for await (const frame of sseFrames(response.body!)) {
          if (ac.signal.aborted) break;
          const event = JSON.parse(frame.data) as { type: string; rooms?: DiscussionView[]; view?: DiscussionView };
          if (event.type === "discussion_snapshot") setRooms(event.rooms ?? []);
          else if (event.type === "discussion_update" && event.view) {
            const next = event.view;
            setRooms((rows) => [...rows.filter((r) => r.room !== next.room), next]);
          }
        }
      } catch (e) { if (!ac.signal.aborted) setError((e as Error).message); }
      if (!ac.signal.aborted) { setReady(false); retry = setTimeout(connect, 2000); }
    };
    void connect();
    return () => { ac.abort(); if (retry) clearTimeout(retry); };
  }, [url, conn.mode, tokenRev, refresh, request]);

  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);
  useEffect(() => { if (list.current && stick.current) list.current.scrollTop = list.current.scrollHeight; }, [view?.messages]);

  async function act(body: unknown, done?: (result: ResponseBody) => void) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError("");
    try { const result = await request(body); done?.(result); }
    catch (e) { setError((e as Error).message); }
    finally { locked.current = false; setBusy(false); }
  }
  const target = { room, id: view?.id };
  const speaker = view?.participants.find((p) => p.agentId === view.speaker);
  const chosen = new Set(d.selected.map((p) => p.sessionId));
  const unavailable = d.selected.some((p) => candidates.find((c) => c.sessionId === p.sessionId)?.busy);

  return (
    <section data-hq-ui="meeting" role="dialog" aria-label={`Diskusi ${MEETING_ROOMS[room]}`} className={cn(CARD,
      "fixed top-[84px] right-[14px] bottom-[14px] w-[min(500px,calc(100vw-28px))] flex flex-col z-[7]",
      "max-[820px]:top-[100px] max-[820px]:left-[14px] max-[820px]:w-auto")}>
      <header className="flex items-center gap-2 px-3 py-2 border-b-[3px] border-ink">
        <h2 className="m-0 font-display text-[15px]">{MEETING_ROOMS[room]}</h2>
        <span className={cn(PILL, "bg-thinking")} role="status">{ready ? setup || !view ? "Siap" : DISCUSSION_LABEL[view.phase] : auth ? "Butuh token" : "Menyambung"}</span>
        <span className="flex-1" /><Button size="log" onClick={onClose}>Tutup</Button>
      </header>
      <nav aria-label="Ruangan meeting" className="flex gap-2 p-2 border-b-2 border-ink">
        {MEETING_ROOMS.map((name, index) => <Button key={name} size="log" tone={room === index ? "primary" : "paper"} aria-pressed={room === index} onClick={() => { onRoom(index); setError(""); setInstruction(""); }}>{name}</Button>)}
      </nav>
      {!url || conn.mode === "demo" ? <p className="m-3 text-[13px]">Sambungkan ke Agent HQ dengan Chat Hermes aktif untuk membuat agen dan memulai diskusi.</p> : null}
      {error && <p role="alert" className="m-0 p-3 text-[13px] bg-[#ffd0d4] border-b-2 border-ink">{error}</p>}
      {auth && <form className="flex gap-2 p-3" onSubmit={(e) => { e.preventDefault(); saveToken(token); setToken(""); setTokenRev((v) => v + 1); }}>
        <label className="min-w-0 flex-1 text-[12px]">HQ_TOKEN<input className={FIELD} type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" /></label>
        <Button type="submit" className={OFF} disabled={!token.trim()}>Sambungkan</Button>
      </form>}
      {setup ? <div className="flex-1 min-h-0 overflow-auto p-3 flex flex-col gap-3 [&>*]:shrink-0">
        <label className="font-bold text-[13px]" htmlFor="meeting-goal">Goal rapat</label>
        <textarea id="meeting-goal" rows={3} maxLength={MAX_GOAL} className={FIELD} placeholder="Apa yang perlu diputuskan bersama?" value={d.goal} onChange={(e) => edit({ goal: e.target.value })} />
        <div className="flex items-center gap-2"><h3 className="m-0 text-[14px]">Peserta ({d.selected.length}/5)</h3><span className="flex-1" /><Button size="log" className={OFF} disabled={!ready || busy} onClick={() => { void refresh().catch((e) => setError(e.message)); }}>Muat ulang</Button></div>
        {d.selected.map((p, i) => <div key={p.sessionId} className="flex items-center gap-2 text-[13px]">
          <span className="font-bold">{i + 1}.</span><div className="flex-1 min-w-0"><b className="break-words">{p.name}</b>{i === 0 && <span className="text-[11px]"> · fasilitator</span>}<div className="text-[11px] break-words">{p.role} · {p.model ? modelLabel(p.model) : "Model default Hermes"}</div></div>
          <Button size="log" className={OFF} disabled={busy} aria-label={`Keluarkan ${p.name} dari peserta`} onClick={() => edit({ selected: d.selected.filter((s) => s.sessionId !== p.sessionId) })}>Keluarkan</Button>
        </div>)}
        <label className="text-[13px] font-bold" htmlFor="meeting-existing">Pilih agen yang sudah ada</label>
        <select id="meeting-existing" className={FIELD} value="" disabled={!ready || busy || chosen.size >= 5} onChange={(e) => {
          const p = candidates.find((p) => p.sessionId === e.target.value);
          if (p && !chosen.has(p.sessionId)) edit({ selected: [...d.selected, p] });
        }}><option value="">{candidates.length ? "Pilih peserta..." : "Belum ada agen. Buat agen baru di bawah."}</option>
          {candidates.filter((p) => !chosen.has(p.sessionId)).map((p) => <option key={p.sessionId} value={p.sessionId} disabled={p.busy}>{p.name} · {p.role}{p.busy ? " (sedang bekerja/rapat)" : ""}</option>)}
        </select>
        <Button className={OFF} disabled={!ready || busy || chosen.size >= 5} aria-expanded={d.creating} onClick={() => edit({ creating: !d.creating })}>{d.creating ? "Tutup form agen" : "+ Buat agen baru"}</Button>
        {d.creating && <form className="flex flex-col gap-2 pt-2" onSubmit={(e) => {
          e.preventDefault();
          void act({ action: "create_agent", agent: { name: d.name, role: d.role, team: "office" }, model: d.model }, (result) => {
            if (!result.participant) return;
            const p = result.participant;
            setCandidates((rows) => [...rows.filter((row) => row.sessionId !== p.sessionId), p]);
            setDrafts((all) => ({ ...all, [room]: { ...all[room], selected: [...all[room].selected, p], name: "", role: "", creating: false } }));
          });
        }}>
          <label className="text-[13px]">Nama<input required maxLength={60} className={FIELD} value={d.name} onChange={(e) => edit({ name: e.target.value })} placeholder="Contoh: Raka" disabled={busy} /></label>
          <label className="text-[13px]">Peran<input required maxLength={60} className={FIELD} value={d.role} onChange={(e) => edit({ role: e.target.value })} placeholder="Contoh: Reviewer arsitektur" disabled={busy} /></label>
          <label className="text-[13px]" htmlFor="meeting-new-model">Model</label>
          <ModelSelect id="meeting-new-model" value={d.model} options={models} onChange={(model) => edit({ model })} disabled={busy} />
          {modelError && <p className="m-0 text-[11px]">Daftar model belum tersedia. Model default Hermes tetap bisa digunakan.</p>}
          <p className="m-0 text-[11px]">Agen baru tetap tersedia di kantor dan Riwayat setelah rapat.</p>
          <Button type="submit" tone="primary" className={OFF} disabled={!ready || busy || chosen.size >= 5 || !d.name.trim() || !d.role.trim()}>{busy ? "Membuat agen..." : "Buat dan tambahkan"}</Button>
        </form>}
        <label className="flex items-center gap-3 text-[13px]" htmlFor="meeting-rounds"><span className="shrink-0">Putaran diskusi</span><select id="meeting-rounds" className="w-[68px] [font-family:inherit] text-[13px] px-2 py-[6px] border-[2.5px] border-ink rounded-[10px] bg-paper" value={d.rounds} onChange={(e) => edit({ rounds: Number(e.target.value) })}>{[1, 2, 3, 4, 5].map((n) => <option key={n}>{n}</option>)}</select></label>
        <p className="m-0 text-[12px]">Agen dapat memakai tool Hermes untuk riset dan membaca sumber. Setiap peserta berbicara sekali per putaran, lalu fasilitator membuat kesimpulan. Rencana tidak dieksekusi otomatis.</p>
        {automatic && <p className="m-0 text-[13px] bg-[#ffe6a6] p-2">Ruangan sedang dipakai {occupancy[room]?.name}. Pilih ruangan kosong atau tunggu rapat selesai.</p>}
        {unavailable && <p className="m-0 text-[13px]">Ada peserta yang sedang bekerja. Muat ulang atau pilih peserta lain.</p>}
        <Button tone="primary" className={OFF} disabled={!ready || busy || !d.goal.trim() || chosen.size < 2 || chosen.size > 5 || automatic || unavailable} onClick={() => {
          stick.current = true; setLatest(true);
          void act({ action: "start", room, goal: d.goal, sessions: d.selected.map((p) => p.sessionId), rounds: d.rounds }, () => setForming((all) => ({ ...all, [room]: false })));
        }}>{busy ? "Menyiapkan..." : "Mulai diskusi"}</Button>
        {view && <Button size="log" onClick={() => setForming((all) => ({ ...all, [room]: false }))}>Kembali ke percakapan</Button>}
      </div> : view && <>
        <div className="p-3 border-b-2 border-ink flex flex-col gap-1 text-[13px]">
          <b className="whitespace-pre-wrap break-words max-h-[120px] overflow-auto">{view.goal}</b>
          <span className="text-[11px]">{view.participants.map((p) => p.name).join(" · ")}</span>
          <span>Putaran {view.round}/{view.rounds}{speaker ? ` · ${speaker.name} sedang ${view.phase === "approval" ? "menunggu izin" : "menjawab"}` : ""}</span>
          {view.error && <p role="alert" className="m-0 text-error">{view.error}</p>}
          {!active && <Button size="log" onClick={() => { setForming((all) => ({ ...all, [room]: true })); void refresh().catch((e) => setError(e.message)); }}>Rapat baru</Button>}
        </div>
        <div ref={list} role="log" aria-label="Percakapan rapat" aria-live="off" className="flex-1 min-h-0 overflow-auto px-3 py-2 flex flex-col gap-4" onScroll={() => {
          const el = list.current; if (!el) return;
          stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 20; setLatest(stick.current);
        }}>
          {!view.messages.length && <p className="text-[13px]">Menunggu pendapat pertama...</p>}
          {view.messages.map((m) => <article key={m.id} className={cn("text-[13px] leading-[1.5]", m.kind === "user" && "bg-[#ffe6a6] p-2 rounded-[10px]", m.kind === "summary" && "bg-[#e2f1bf] p-2 rounded-[10px]")}>
            <div className="flex items-baseline justify-between gap-2"><b>{m.kind === "summary" ? `Kesimpulan · ${m.name}` : m.kind === "tool" ? `Tool Hermes · ${m.name}` : m.name}</b><time className="text-[10px] shrink-0">{new Date(m.at).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" })}</time></div>
            <p className={cn("m-0 whitespace-pre-wrap break-words", ["tool", "note"].includes(m.kind) && "text-[11px] opacity-80")}>{m.text}{m.streaming ? " ▍" : ""}</p>
            {m.approval?.status === "pending" && <div className="flex flex-wrap gap-2 pt-2">{m.approval.choices.map((choice) => <Button key={choice} size="log" className={OFF} disabled={!ready || busy} onClick={() => void act({ action: "approve", ...target, sessionId: m.approval!.sessionId, itemId: m.approval!.itemId, choice })}>{APPROVAL_LABEL[choice]}</Button>)}</div>}
          </article>)}
        </div>
        {!latest && <Button size="log" onClick={() => { stick.current = true; setLatest(true); if (list.current) list.current.scrollTop = list.current.scrollHeight; }}>Ke pesan terbaru ↓</Button>}
        {active && <form className="p-3 border-t-2 border-ink flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); void act({ action: "message", ...target, text: instruction }, () => setInstruction("")); }}>
          <label className="text-[12px]" htmlFor="meeting-instruction">Tambahkan arahan (dibaca pada giliran berikutnya)</label>
          <textarea id="meeting-instruction" rows={2} maxLength={1000} className={FIELD} value={instruction} onChange={(e) => setInstruction(e.target.value)} />
          <div className="flex gap-2"><Button type="submit" className={OFF} disabled={!ready || busy || !instruction.trim() || view.phase === "stopping"}>Kirim arahan</Button><span className="flex-1" /><Button tone="alert" className={OFF} disabled={!ready || busy || view.phase === "stopping"} onClick={() => void act({ action: "stop", ...target })}>{view.phase === "stopping" ? "Menghentikan..." : "Hentikan"}</Button></div>
        </form>}
      </>}
    </section>
  );
}
