// Small formatting helpers shared by the UI and the engine (ported 1:1 from the prototype).

export function fmtNum(n: unknown): string {
  const v = Number(n) || 0;
  return v >= 1e6 ? (v / 1e6).toFixed(1) + "M" : v >= 1e3 ? (v / 1e3).toFixed(1) + "k" : String(v);
}

export function fmtTime(t: number): string {
  return new Date(t).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function ago(t: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - t) / 1000));
  return s < 5 ? "baru saja" : s < 60 ? `${s} dtk lalu` : s < 3600 ? `${Math.floor(s / 60)} mnt lalu` : `${Math.floor(s / 3600)} jam lalu`;
}

export const truncate = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + "…" : s);
