// Live connection: SSE (http/https) or WebSocket (ws/wss) with backoff up to 15 s.
// Port of connect()/closeLive()/scheduleRetry() in references/agent-hq.html.
// Deviation (plan-m1.md #1): with `fallbackToDemo`, a connection that fails before it ever opened
// switches to demo mode instead of retrying forever.

import type { Demo } from "./demo";
import type { HQStore } from "./store";

export const URL_STORAGE_KEY = "agenthq.url";

export interface ConnectOptions {
  /** Called (once) if the first attempt fails before opening. */
  fallbackToDemo?: boolean;
}

export interface Transport {
  connect: (url: string, opts?: ConnectOptions) => void;
  /** Close the live source and return to demo mode (modal "Kembali ke demo"). */
  backToDemo: () => void;
  close: () => void;
  readonly liveUrl: string | null;
}

type Source = EventSource | WebSocket;

export function createTransport(store: HQStore, demo: Demo): Transport {
  let live: Source | null = null;
  let liveUrl: string | null = null;
  let retry = 1500;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const S = () => store.getState();

  const closeLive = () => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    if (live) {
      live.onopen = live.onmessage = live.onerror = null;
      if ("onclose" in live) live.onclose = null;
      try {
        live.close();
      } catch {}
    }
    live = null;
  };

  const scheduleRetry = () => {
    S().setConn("down", "Terputus, coba lagi...");
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => liveUrl && connect(liveUrl), retry);
    retry = Math.min(retry * 1.7, 15000);
  };

  const backToDemo = () => {
    closeLive();
    liveUrl = null;
    demo.start();
  };

  function connect(url: string, opts: ConnectOptions = {}) {
    demo.stop();
    closeLive();
    liveUrl = url;
    try {
      localStorage.setItem(URL_STORAGE_KEY, url);
    } catch {}
    S().setConn("down", "Menyambung...");
    let opened = false;
    const failFirst = () => {
      if (opts.fallbackToDemo && !opened) {
        backToDemo();
        return true;
      }
      return false;
    };
    const onMsg = (data: unknown) => {
      try {
        S().applyEvent(JSON.parse(String(data)));
      } catch {
        console.warn("event bukan JSON", data);
      }
    };
    let src: Source;
    try {
      const u = new URL(url, location.href);
      if (u.protocol === "ws:" || u.protocol === "wss:") {
        const ws = new WebSocket(u.href);
        ws.onmessage = (e) => onMsg(e.data);
        ws.onclose = () => {
          if (!failFirst()) scheduleRetry();
        };
        src = ws;
      } else {
        const es = new EventSource(u.href);
        es.onmessage = (e) => onMsg(e.data);
        es.onerror = () => {
          if (failFirst()) return;
          S().setConn("down", "Menyambung ulang...");
          if (es.readyState === EventSource.CLOSED) scheduleRetry();
        };
        src = es;
      }
    } catch {
      S().setConn("down", "URL tidak valid");
      S().showToast("URL tidak valid atau diblok browser");
      return;
    }
    let first = true;
    src.onopen = () => {
      opened = true;
      retry = 1500;
      S().setConn("live");
      if (first) {
        S().clearAgents();
        first = false;
        S().showToast("Tersambung ke " + url);
      }
    };
    live = src;
  }

  return {
    connect,
    backToDemo,
    close: () => {
      closeLive();
      liveUrl = null;
    },
    get liveUrl() {
      return liveUrl;
    },
  };
}
