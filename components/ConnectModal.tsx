"use client";

import { useEffect, useRef } from "react";
import { URL_STORAGE_KEY } from "@/lib/transport";
import { Button, CARD, cn } from "./ui";

export const DEFAULT_STREAM_URL = "http://localhost:8787/api/stream";

const FORMAT = `{ "type": "agent_update",
  "id": "coder-1", "name": "Glimbo", "role": "Coder",
  "status": "working",   // working | thinking | waiting | idle | error | offline
  "task": "Refactor handler auth",
  "progress": 0.4, "tokens": 18230 }

{ "type": "log", "id": "coder-1", "level": "error", "message": "Test gagal: 3/42" }
{ "type": "task_done", "id": "coder-1", "task": "Refactor handler auth" }
{ "type": "snapshot", "agents": [ ...agent_update tanpa type... ] }
{ "type": "remove", "id": "coder-1" }

// Lt.3 Security (opsional "team": "red" | "report" | "blue")
{ "type": "finding", "id": "rexx", "severity": "high",
  "title": "SQL injection di /login" }
{ "type": "alert", "id": "sentra", "severity": "high",
  "message": "Bruteforce SSH 412x/2 mnt", "source_ip": "103.94.12.7" }
{ "type": "metric", "name": "failed_logins", "value": 37 }

Agen berstatus idle akan jalan sendiri ke area santai
(Lt.1 / Lt.2) dan balik ke meja saat status berubah.`;

export default function ConnectModal({
  open,
  liveUrl,
  onClose,
  onConnect,
  onDemo,
}: {
  open: boolean;
  liveUrl: () => string | null;
  onClose: () => void;
  onConnect: (url: string) => void;
  onDemo: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  // Fill the field when the modal opens: current live URL, else the last used one, else the app's own stream.
  useEffect(() => {
    if (!open) return;
    let saved = "";
    try {
      saved = localStorage.getItem(URL_STORAGE_KEY) || "";
    } catch {}
    const el = inputRef.current;
    if (el) {
      el.value = liveUrl() || saved || DEFAULT_STREAM_URL;
      el.focus();
    }
  }, [open, liveUrl]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const go = () => {
    const v = (inputRef.current?.value ?? "").trim();
    if (!v) return;
    onClose();
    onConnect(v);
  };

  return (
    <div
      data-hq-ui="modal"
      className={cn("fixed inset-0 bg-[rgba(20,10,40,.55)] place-items-center z-20", open ? "grid" : "hidden")}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={cn(CARD, "w-[min(560px,calc(100vw-28px))] max-h-[calc(100vh-40px)] overflow-auto px-5 py-[18px]")} role="dialog" aria-modal="true">
        <h3 className="m-0 mb-1 font-display text-[18px]">SAMBUNGKAN AGEN</h3>
        <p className="text-[14px] leading-[1.45] my-2">
          Masukkan URL stream. <b>http(s)://</b> dibaca sebagai Server-Sent Events (cocok dengan bridge <code>server.js</code>), <b>ws(s)://</b> sebagai WebSocket.
        </p>
        <label htmlFor="inUrl" className="font-bold text-[13px] block mt-[10px]">
          URL stream
        </label>
        <input
          id="inUrl"
          ref={inputRef}
          placeholder={DEFAULT_STREAM_URL}
          spellCheck={false}
          className="w-full font-mono text-[13px] px-[10px] py-2 border-[2.5px] border-ink rounded-[10px] mt-1 bg-white"
          onKeyDown={(e) => {
            if (e.key === "Enter") go();
          }}
        />
        <p className="text-[13px] leading-[1.45] my-2 bg-[#ffe6a6] border-2 border-ink rounded-[10px] px-[10px] py-2">
          Kalau halaman ini dibuka dari link artifact Claude, browser memblokir koneksi ke server luar, jadi hanya mode demo yang jalan. Untuk data asli, jalankan <code>npm start</code> lalu buka{" "}
          <code>http://localhost:8787</code>.
        </p>
        <label className="font-bold text-[13px] block mt-[10px]">Format event (JSON)</label>
        {/* <code> above keeps the browser default monospace (as in the prototype); <pre> sets JetBrains Mono. */}
        <pre className="bg-violet text-paper border-[2.5px] border-ink rounded-[10px] p-[10px] text-[11.5px] overflow-auto font-mono leading-[1.5]">{FORMAT}</pre>
        <div className="flex gap-2 justify-end mt-[14px] flex-wrap">
          <Button
            onClick={() => {
              onClose();
              onDemo();
            }}
          >
            Kembali ke demo
          </Button>
          <Button onClick={onClose}>Tutup</Button>
          <Button tone="primary" onClick={go}>
            Sambungkan
          </Button>
        </div>
      </div>
    </div>
  );
}
