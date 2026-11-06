"use client";

// Schedule panel (Hermes cron, docs/hermes.md "Jadwal"): every job with its next and last run, plus controls.
// Opened from the 3D schedule board or the "Jadwal" button. Commands go to POST /api/cron next to the live stream;
// the schedule source runs them and the result comes back over the stream (store.cronCmds).

import { useEffect, useState } from "react";
import { useStore } from "zustand";
import {
  ago, countdown, cronStale, cronUrlFor, CRON_ACTION_LABEL, jobPhase, PHASE, sortJobs,
  type CronAction, type CronCmd, type CronJob,
} from "@/lib/cron";
import { hqStore } from "@/lib/store";
import { authHeader, readToken, saveToken as storeToken } from "@/lib/token";
import { Button, CARD, OFF, PILL, cn } from "./ui";

const CONFIRM_MS = 4000;

const when = (t: number | null) =>
  t == null ? "-" : new Date(t).toLocaleString("id-ID", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

const CMD_TEXT: Record<CronCmd["status"], string> = {
  queued: "Menunggu reporter...",
  sent: "Sedang dijalankan reporter...",
  ok: "Berhasil",
  error: "Gagal",
};

export default function CronPanel({ open, onClose, liveUrl }: { open: boolean; onClose: () => void; liveUrl: () => string | null }) {
  const cron = useStore(hqStore, (s) => s.cron);
  const cmds = useStore(hqStore, (s) => s.cronCmds);
  const live = useStore(hqStore, (s) => s.conn.mode === "live");
  const [now, setNow] = useState(() => Date.now());
  const [err, setErr] = useState("");
  const [needToken, setNeedToken] = useState(false);
  const [tokenDraft, setTokenDraft] = useState("");
  const [confirm, setConfirm] = useState<{ job: string; until: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      clearInterval(timer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  const stale = !cron || cronStale(cron, now);
  const url = live ? cronUrlFor(liveUrl(), typeof location === "undefined" ? "http://localhost/" : location.href) : null;
  const lastCmd = (job: string) => [...cmds].reverse().find((c) => c.job === job);
  const pending = (job: string) => {
    const c = lastCmd(job);
    return !!c && (c.status === "queued" || c.status === "sent");
  };

  async function send(job: CronJob, action: CronAction) {
    if (!url) {
      setErr("Kontrol hanya jalan saat halaman tersambung ke Agent HQ lewat /api/stream.");
      return;
    }
    if (action === "run" && (!confirm || confirm.job !== job.id || confirm.until < now)) {
      setConfirm({ job: job.id, until: now + CONFIRM_MS });
      return;
    }
    setConfirm(null);
    setBusy(job.id + action);
    const token = readToken();
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeader(token) },
        body: JSON.stringify({ action, job: job.id }),
      });
      if (res.status === 401) {
        setNeedToken(true);
        setErr(token ? "Token salah. Masukkan lagi." : "Agent HQ memakai HQ_TOKEN. Masukkan tokennya dulu.");
      } else if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setErr(body?.error || `Gagal (HTTP ${res.status})`);
      } else setErr("");
    } catch (e) {
      setErr(`Agent HQ tidak bisa dihubungi: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  const saveToken = () => {
    storeToken(tokenDraft);
    setTokenDraft("");
    setNeedToken(false);
    setErr("Token disimpan untuk tab ini. Coba lagi.");
  };

  const status = !cron ? null : stale ? { t: "Reporter terputus", c: "#ff4f5e" } : cron.schedulerAlive ? { t: "Scheduler aktif", c: "#a6e22e" } : { t: "Scheduler mati", c: "#ff9f1c" };

  return (
    <div
      data-hq-ui="modal"
      className={cn("fixed inset-0 bg-[rgba(20,10,40,.55)] place-items-center z-20", open ? "grid" : "hidden")}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={cn(CARD, "w-[min(640px,calc(100vw-28px))] max-h-[calc(100vh-40px)] overflow-auto px-5 py-[18px]")} role="dialog" aria-modal="true" aria-label="Papan jadwal">
        <div className="flex items-center gap-2 flex-wrap">
          <h3 className="m-0 font-display text-[18px]">PAPAN JADWAL</h3>
          {status && (
            <span className={PILL} style={{ background: status.c }}>
              {status.t}
            </span>
          )}
          <span className="flex-1" />
          <Button onClick={onClose}>Tutup</Button>
        </div>
        <p className="text-[13px] leading-[1.45] my-2">
          Jadwal dari <b>{cron?.source || "reporter"}</b>. Perintah dijalankan oleh reporter di mesin Hermes. <b>Jalankan sekarang</b> mulai di tick
          berikutnya (paling lama 1 menit) dan memakai token model seperti jadwal biasa.
        </p>
        {!url && <p className="text-[13px] my-2 bg-[#ffe6a6] border-2 border-ink rounded-[10px] px-[10px] py-2">Mode lihat saja: halaman belum tersambung ke Agent HQ lewat /api/stream.</p>}
        {err && <p className="text-[13px] my-2 bg-[#ffd0d4] border-2 border-ink rounded-[10px] px-[10px] py-2">{err}</p>}
        {needToken && (
          <div className="flex gap-2 items-center my-2">
            <input
              type="password"
              value={tokenDraft}
              onChange={(e) => setTokenDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && tokenDraft.trim()) saveToken();
              }}
              placeholder="HQ_TOKEN"
              className="flex-1 font-mono text-[13px] px-[10px] py-2 border-[2.5px] border-ink rounded-[10px] bg-white"
            />
            <Button tone="primary" className={OFF} disabled={!tokenDraft.trim()} onClick={saveToken}>
              Simpan token
            </Button>
          </div>
        )}
        {cron && !cron.jobs.length && <p className="text-[14px] my-4 text-center">Belum ada jadwal. Buat lewat /cron di Hermes atau <code>hermes cron create</code>.</p>}
        <div className="flex flex-col gap-[10px] mt-2">
          {cron &&
            sortJobs(cron.jobs).map((j) => {
              const ph = jobPhase(j, now);
              const cmd = lastCmd(j.id);
              const locked = stale || !url || pending(j.id) || busy !== null;
              const can = (a: CronAction) => cron.controls.includes(a);
              const paused = ph === "paused";
              const asking = confirm?.job === j.id && confirm.until > now;
              return (
                <div key={j.id} className="border-[2.5px] border-ink rounded-[12px] bg-white px-3 py-[10px]">
                  <div className="flex items-center gap-2">
                    <i className="inline-block w-[12px] h-[12px] rounded-full border-2 border-ink shrink-0" style={{ background: PHASE[ph].color }} />
                    <b className="text-[15px] break-all">{j.name}</b>
                    <span className="flex-1" />
                    <span className={PILL} style={{ background: PHASE[ph].color }}>
                      {PHASE[ph].label}
                    </span>
                  </div>
                  <div className="text-[12.5px] mt-1 leading-[1.5] opacity-85">
                    <code>{j.schedule || "-"}</code>
                    {j.deliver && <> · kirim ke {j.deliver}</>}
                    <br />
                    Berikutnya: {j.nextRunAt == null ? "-" : `${when(j.nextRunAt)} (${countdown(j.nextRunAt, now)})`}
                    <br />
                    Terakhir: {j.lastRunAt == null ? "belum pernah" : `${when(j.lastRunAt)} (${ago(j.lastRunAt, now)})`}
                    {j.lastStatus === "error" && <span className="text-error font-bold"> · gagal{j.failureStreak > 1 ? ` ${j.failureStreak}x berturut-turut` : ""}</span>}
                  </div>
                  {j.lastError && j.lastStatus === "error" && <div className="text-[12px] mt-1 font-mono bg-[#fff0f1] border-2 border-ink rounded-[8px] px-2 py-1 break-words">{j.lastError}</div>}
                  <div className="flex gap-2 items-center mt-2 flex-wrap">
                    {can("run") && (
                      <Button size="log" className={OFF} tone={asking ? "alert" : "primary"} disabled={locked || ph === "running"} onClick={() => send(j, "run")}>
                        {asking ? "Yakin? Klik lagi" : CRON_ACTION_LABEL.run}
                      </Button>
                    )}
                    {can(paused ? "resume" : "pause") && ph !== "done" && (
                      <Button size="log" className={OFF} disabled={locked} onClick={() => send(j, paused ? "resume" : "pause")}>
                        {CRON_ACTION_LABEL[paused ? "resume" : "pause"]}
                      </Button>
                    )}
                    {cmd && (
                      <span className={cn("text-[12px] font-semibold", cmd.status === "error" && "text-error")}>
                        {CRON_ACTION_LABEL[cmd.action]}: {CMD_TEXT[cmd.status]}
                        {cmd.message ? ` · ${cmd.message}` : ""}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
        </div>
      </div>
    </div>
  );
}
