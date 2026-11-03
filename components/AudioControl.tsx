"use client";

// Sound controls (deviation 13): a speaker button that mutes/unmutes everything, and a settings button that opens a
// small "Pengaturan" panel with separate music and sound-effect volumes (plus a test button for the effects).
// State lives in lib/audio.ts and is remembered per browser.

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import { audioStore, BGM_URL, initAudio, previewSfx, setMusicVolume, setSfxVolume, toggleMuted } from "@/lib/audio";
import { Button, CARD, cn } from "./ui";

function SpeakerIcon({ on }: { on: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor" />
      {on ? (
        <>
          <path d="M16.5 9.5a3.5 3.5 0 0 1 0 5" />
          <path d="M19 7a7 7 0 0 1 0 10" />
        </>
      ) : (
        <path d="M17 9.5l5 5M22 9.5l-5 5" />
      )}
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <g fill="currentColor">
        <rect x="10.1" y="1.6" width="3.8" height="4.4" rx="0.9" transform="rotate(0 12 12)" /><rect x="10.1" y="1.6" width="3.8" height="4.4" rx="0.9" transform="rotate(45 12 12)" /><rect x="10.1" y="1.6" width="3.8" height="4.4" rx="0.9" transform="rotate(90 12 12)" /><rect x="10.1" y="1.6" width="3.8" height="4.4" rx="0.9" transform="rotate(135 12 12)" /><rect x="10.1" y="1.6" width="3.8" height="4.4" rx="0.9" transform="rotate(180 12 12)" /><rect x="10.1" y="1.6" width="3.8" height="4.4" rx="0.9" transform="rotate(225 12 12)" /><rect x="10.1" y="1.6" width="3.8" height="4.4" rx="0.9" transform="rotate(270 12 12)" /><rect x="10.1" y="1.6" width="3.8" height="4.4" rx="0.9" transform="rotate(315 12 12)" />
        <circle cx="12" cy="12" r="7.2" />
      </g>
      <circle cx="12" cy="12" r="2.9" fill="var(--paper)" />
    </svg>
  );
}

function VolumeRow({ label, value, muted, onChange, extra }: { label: string; value: number; muted: boolean; onChange: (v: number) => void; extra?: ReactNode }) {
  const pct = Math.round(value * 100);
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <span className="flex items-center justify-between gap-2 text-[13px] font-semibold">
        <label htmlFor={id}>{label}</label>
        <span className="flex items-center gap-2">
          {extra}
          <span className="tabular-nums w-[34px] text-right">{pct}%</span>
        </span>
      </span>
      <input
        id={id}
        type="range"
        min={0}
        max={100}
        step={1}
        value={pct}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
        className={cn("w-full cursor-pointer accent-[var(--ink)]", muted && "opacity-45")}
      />
    </div>
  );
}

export default function AudioControl() {
  const { muted, music, sfx, bgm } = useStore(audioStore);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const panelId = useId();
  useEffect(() => initAudio(), []);
  // Close the panel on Escape or a click anywhere outside it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const on = !muted && (music > 0 || sfx > 0);
  const action = on ? "Matikan suara" : "Nyalakan suara";
  const note =
    bgm === "missing" ? `Musik tidak ditemukan (${BGM_URL.startsWith("/") ? "public" + BGM_URL : BGM_URL}), efek suara tetap jalan.` :
    bgm === "blocked" ? "Klik di mana saja untuk memulai musik." : "";

  return (
    <span ref={wrap} className="relative flex items-center gap-2" data-hq-ui="audio">
      <Button className="px-2 leading-none" title={note ? `${action}. ${note}` : action} aria-label={action} aria-pressed={on} onClick={toggleMuted}>
        <SpeakerIcon on={on} />
      </Button>
      <Button
        className="px-2 leading-none"
        tone={open ? "primary" : "paper"}
        title="Pengaturan"
        aria-label="Pengaturan"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
      >
        <GearIcon />
      </Button>
      {open && (
        <div id={panelId} role="dialog" aria-label="Pengaturan" className={cn(CARD, "absolute right-0 top-[calc(100%+12px)] z-10 w-[240px] flex flex-col gap-3 px-[14px] py-3")}>
          <h2 className="m-0 font-display text-[14px]">PENGATURAN</h2>
          <VolumeRow label="Musik" value={music} muted={muted} onChange={setMusicVolume} />
          <VolumeRow
            label="Efek suara"
            value={sfx}
            muted={muted}
            onChange={setSfxVolume}
            extra={
              <Button size="log" disabled={muted || sfx === 0} title={muted ? "Nyalakan suara dulu" : "Putar contoh efek suara"} onClick={previewSfx} className="disabled:opacity-45 disabled:cursor-not-allowed">
                Tes
              </Button>
            }
          />
          {muted && <span className="text-[12px] leading-snug opacity-75">Suara sedang mati. Geser salah satu slider atau klik tombol speaker untuk menyalakan.</span>}
          {note && <span className="text-[12px] leading-snug opacity-75">{note}</span>}
        </div>
      )}
    </span>
  );
}
