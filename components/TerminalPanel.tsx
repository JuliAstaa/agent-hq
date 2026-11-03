"use client";

// Terminal panel (docs/terminal.md): the server's ttyd page in a frame next to the office. ttyd runs on its own with
// its own password; Agent HQ only learns its address from GET /api/terminal (HQ_TERMINAL_URL). Closing the panel
// drops the connection. With examples/terminal/ttyd.sh the shell runs in tmux, so it keeps going and comes back.

import { useEffect, useState } from "react";
import { useStore } from "zustand";
import { hqStore } from "@/lib/store";
import { terminalApiUrlFor, terminalUrl } from "@/lib/terminal";
import { Button, CARD, cn } from "./ui";

const here = () => (typeof location === "undefined" ? "http://localhost/" : location.href);

/** The terminal address while the page is live on an Agent HQ server that has HQ_TERMINAL_URL, else null. */
export function useTerminalUrl(liveUrl: () => string | null): string | null {
  const live = useStore(hqStore, (s) => s.conn.mode === "live");
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const api = live ? terminalApiUrlFor(liveUrl(), here()) : null;
    if (!api) return;
    const ac = new AbortController();
    fetch(api, { signal: ac.signal, cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { url?: unknown } | null) => setUrl(terminalUrl(b?.url)))
      .catch(() => {});
    return () => ac.abort();
  }, [live, liveUrl]);
  return live ? url : null;
}

/** Hint under the frame: a loopback address goes through the SSH tunnel, anything else through a proxy. */
function hintFor(url: string): string {
  const u = new URL(url);
  return /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/.test(u.hostname)
    ? `Tidak muncul? Pastikan tunnel SSH juga meneruskan port terminal (${u.host}).`
    : `Tidak muncul? Cek ttyd di server dan proxy untuk ${u.host}${u.pathname}.`;
}

export default function TerminalPanel({ url, onClose }: { url: string; onClose: () => void }) {
  const [attempt, setAttempt] = useState(0); // a new key remounts the frame, so ttyd connects again
  return (
    <section
      data-hq-ui="terminal"
      role="dialog"
      aria-label="Terminal"
      className={cn(
        CARD,
        "fixed top-[84px] right-[14px] bottom-[14px] w-[min(760px,calc(100vw-28px))] flex flex-col z-[6]",
        "max-[820px]:top-auto max-[820px]:h-[60vh] max-[820px]:w-auto max-[820px]:left-[14px]",
      )}
    >
      <header className="flex items-center gap-2 px-3 pt-[10px] pb-2 border-b-[3px] border-ink">
        <h2 className="m-0 font-display text-[15px]">TERMINAL</h2>
        <span className="flex-1" />
        <Button size="log" title="Sambungkan ulang ke terminal" onClick={() => setAttempt((n) => n + 1)}>
          Muat ulang
        </Button>
        <Button size="log" title="Buka terminal di tab baru" onClick={() => window.open(url, "_blank", "noopener,noreferrer")}>
          Tab baru
        </Button>
        <Button size="log" onClick={onClose}>
          Tutup
        </Button>
      </header>
      <iframe
        key={attempt}
        src={url}
        title="Terminal"
        referrerPolicy="no-referrer"
        allow="clipboard-read; clipboard-write"
        className="flex-1 min-h-0 w-full border-0 bg-ink"
      />
      <p className="m-0 px-3 py-[5px] border-t-[3px] border-ink text-[12px] font-semibold rounded-b-[11px]">
        {hintFor(url)}
      </p>
    </section>
  );
}
