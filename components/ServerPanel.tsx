"use client";

// Server panel (prd.md §7.8): the machine Agent HQ runs on, opened by a click on the server room of floor 2.
// Reads the store only: the latest sample, the 30 minute history (from the bridge, then live) and the `Server`
// warning lines. Nothing is sent from here.

import { useEffect, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useStore } from "zustand";
import { ago, fmtTime } from "@/lib/format";
import {
  chartLines, chartRange, chartXY, diskPct, fmtBytes, fmtPair, fmtUptime, LEVEL_COLOR, levelOf, memPct, OFFLINE_COLOR,
  pctText, SERVER_HISTORY_MS, SERVER_LOG_ID, serverStale, serverState, type ChartKey, type ServerPoint, type ServerStats,
} from "@/lib/server";
import { hqStore } from "@/lib/store";
import { Button, CARD, PILL, cn } from "./ui";

/** Chart box in SVG units; the SVG stretches to the card width (strokes keep their width). */
const CW = 340, CH = 56;
const INK = "#1b1530";
const PLATFORM: Record<string, string> = { linux: "Linux", win32: "Windows", darwin: "macOS", freebsd: "FreeBSD" };

interface Metric {
  key: ChartKey;
  label: string;
  value: number | null;
  detail: string;
}

function metricsOf(s: ServerStats): Metric[] {
  const join = (...parts: (string | null)[]) => parts.filter(Boolean).join(" · ");
  return [
    {
      key: "cpu",
      label: "CPU",
      value: s.cpu,
      detail: join(s.cores ? `${s.cores} core` : null, s.load ? `load 1/5/15 mnt ${s.load.map((x) => x.toFixed(2)).join(" ")}` : null),
    },
    {
      key: "mem",
      label: "RAM",
      value: memPct(s),
      detail: join(
        s.memTotal ? `${fmtPair(s.memUsed ?? 0, s.memTotal)} terpakai` : null,
        s.memTotal && s.memUsed != null ? `sisa ${fmtBytes(s.memTotal - s.memUsed)}` : null,
      ),
    },
    {
      key: "disk",
      label: "DISK",
      value: diskPct(s),
      detail: join(s.diskSize ? `${fmtPair(s.diskUsed ?? 0, s.diskSize)} terpakai` : null, s.diskAvail != null ? `sisa ${fmtBytes(s.diskAvail)}` : null),
    },
  ];
}

const pos = ([x, y]: [number, number]) => ({ left: `${(x / CW) * 100}%`, top: `${(y / CH) * 100}%` });

/** Line chart of one metric over the last 30 minutes, with a crosshair readout on hover and arrow keys. */
function Chart({ m, points, now, color, gapMs, axis }: { m: Metric; points: ServerPoint[]; now: number; color: string; gapMs: number; axis: boolean }) {
  const [pick, setPick] = useState<number | null>(null);
  const known = points.filter((p) => p[m.key] != null && p.at >= now - SERVER_HISTORY_MS && p.at <= now);
  const lines = chartLines(points, m.key, now, CW, CH, gapMs);
  const range = chartRange(known, m.key);
  const sel = pick != null ? known[Math.min(pick, known.length - 1)] : undefined;
  const last = known[known.length - 1];
  const xy = (p: ServerPoint) => chartXY(p.at, p[m.key]!, now, CW, CH);

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    if (!known.length) return;
    const r = e.currentTarget.getBoundingClientRect();
    const t = now - SERVER_HISTORY_MS + ((e.clientX - r.left) / r.width) * SERVER_HISTORY_MS;
    let best = 0;
    for (let i = 1; i < known.length; i++) if (Math.abs(known[i].at - t) < Math.abs(known[best].at - t)) best = i;
    setPick(best);
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (!known.length) return;
    const step = { ArrowLeft: -1, ArrowRight: 1, PageUp: -12, PageDown: 12 }[e.key];
    const i = pick ?? known.length - 1;
    if (step) setPick(Math.max(0, Math.min(known.length - 1, i + step)));
    else if (e.key === "Home") setPick(0);
    else if (e.key === "End") setPick(known.length - 1);
    else return;
    e.preventDefault();
  };

  const summary = range ? `30 menit terakhir · min ${pctText(range.min)} · maks ${pctText(range.max)}` : "Riwayat belum ada";
  return (
    <div className="mt-2">
      <div className="text-[11.5px] h-[16px] whitespace-nowrap overflow-hidden text-ellipsis" aria-live="polite">
        {sel ? (
          <>
            <b className="text-[12.5px]">{pctText(sel[m.key]!)}</b> <span className="opacity-70">{fmtTime(sel.at)}</span>
          </>
        ) : (
          <span className="opacity-70">{summary}</span>
        )}
      </div>
      <div className="relative h-[56px] mt-[2px]">
        <svg
          viewBox={`0 0 ${CW} ${CH}`}
          preserveAspectRatio="none"
          className="absolute inset-0 w-full h-full overflow-visible outline-none cursor-crosshair focus-visible:[outline:2px_solid_var(--ink)] focus-visible:[outline-offset:3px] rounded-[2px]"
          tabIndex={0}
          role="img"
          aria-label={`${m.label}: ${summary}. Panah kiri dan kanan untuk membaca nilai.`}
          onPointerMove={onMove}
          onPointerLeave={() => setPick(null)}
          onFocus={() => setPick(known.length ? known.length - 1 : null)}
          onBlur={() => setPick(null)}
          onKeyDown={onKey}
        >
          <line x1={0} x2={CW} y1={CH} y2={CH} stroke={INK} strokeOpacity={0.3} strokeWidth={1} vectorEffect="non-scaling-stroke" />
          <line x1={0} x2={CW} y1={CH / 2} y2={CH / 2} stroke={INK} strokeOpacity={0.1} strokeWidth={1} vectorEffect="non-scaling-stroke" />
          <line x1={0} x2={CW} y1={CH * 0.1} y2={CH * 0.1} stroke={LEVEL_COLOR.hot} strokeWidth={1} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
          {lines.map((run, i) => (
            <g key={i}>
              {run.length > 1 && (
                <polygon points={`${run[0][0]},${CH} ${run.map((p) => p.join(",")).join(" ")} ${run[run.length - 1][0]},${CH}`} fill={INK} fillOpacity={0.08} />
              )}
              <polyline
                points={run.map((p) => p.join(",")).join(" ")}
                fill="none"
                stroke={INK}
                strokeOpacity={0.8}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            </g>
          ))}
          {sel && <line x1={xy(sel)[0]} x2={xy(sel)[0]} y1={0} y2={CH} stroke={INK} strokeOpacity={0.5} strokeWidth={1} vectorEffect="non-scaling-stroke" />}
        </svg>
        <span className="absolute left-[2px] text-[10px] font-bold leading-none text-error pointer-events-none" style={{ top: "calc(10% - 12px)" }}>
          90%
        </span>
        {last && (
          <i
            className="absolute w-[10px] h-[10px] rounded-full border-2 border-ink -translate-x-1/2 -translate-y-1/2 pointer-events-none"
            style={{ ...pos(xy(last)), background: color }}
          />
        )}
        {sel && sel !== last && (
          <i className="absolute w-[10px] h-[10px] rounded-full border-2 border-ink bg-paper -translate-x-1/2 -translate-y-1/2 pointer-events-none" style={pos(xy(sel))} />
        )}
      </div>
      {axis && (
        <div className="flex justify-between text-[10.5px] opacity-60 mt-[3px]">
          <span>30 mnt lalu</span>
          <span>sekarang</span>
        </div>
      )}
    </div>
  );
}

export default function ServerPanel({ onClose }: { onClose: () => void }) {
  const server = useStore(hqStore, (s) => s.server);
  const history = useStore(hqStore, (s) => s.serverHistory);
  const logs = useStore(hqStore, (s) => s.logs);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      clearInterval(timer);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const t = Math.max(now, server?.receivedAt ?? 0);
  const stale = !!server && serverStale(server, t);
  const state = server ? serverState(server, t) : null;
  const warnings = logs.filter((l) => l.id === SERVER_LOG_ID).slice(-5);

  return (
    <section
      data-hq-ui="server"
      role="dialog"
      aria-label="Server"
      className={cn(
        CARD,
        // same spot as the terminal panel: covers the roster from the top bar down
        "fixed top-[84px] right-[14px] bottom-[14px] w-[min(400px,calc(100vw-28px))] flex flex-col z-[6]",
        "max-[820px]:top-auto max-[820px]:h-[60vh] max-[820px]:w-auto max-[820px]:left-[14px]",
      )}
    >
      <header className="flex items-center gap-2 px-3 pt-[10px] pb-2 border-b-[3px] border-ink">
        <h2 className="m-0 font-display text-[15px]">SERVER</h2>
        {state && (
          <span className={PILL} style={{ background: state.color }}>
            {state.label}
          </span>
        )}
        <span className="flex-1" />
        <Button size="log" onClick={onClose}>
          Tutup
        </Button>
      </header>
      <div className="flex-1 min-h-0 overflow-auto px-3 py-[10px]">
        {!server ? (
          <p className="text-[13.5px] my-2">Belum ada data server. Pemantau server hanya jalan saat halaman tersambung ke Agent HQ.</p>
        ) : (
          <>
            <p className="text-[13px] m-0 opacity-85">
              Mesin tempat Agent HQ jalan. Diperbarui {ago(server.receivedAt, t)}.
            </p>
            {stale && (
              <p className="text-[13px] mt-2 mb-0 bg-[#ffd0d4] border-2 border-ink rounded-[10px] px-[10px] py-2 font-semibold">
                Data server terputus. Sampel terakhir {ago(server.receivedAt, t)}.
              </p>
            )}
            <div className="flex flex-col gap-[10px] mt-[10px]">
              {metricsOf(server).map((m, i, all) => {
                const color = m.value == null || stale ? OFFLINE_COLOR : LEVEL_COLOR[levelOf(m.value)];
                return (
                  <div key={m.key} className="border-[2.5px] border-ink rounded-[12px] bg-white px-3 py-[9px]">
                    <div className="flex items-baseline gap-2">
                      <b className="font-display text-[14px] font-normal">{m.label}</b>
                      <span className="flex-1" />
                      <span className="text-[22px] font-bold leading-none">{m.value == null ? "-" : pctText(m.value)}</span>
                    </div>
                    <div className="h-[12px] mt-[6px] rounded-full border-2 border-ink bg-paper2 overflow-hidden">
                      {m.value != null && <div className="h-full rounded-full" style={{ width: `${Math.max(4, m.value * 100)}%`, background: color }} />}
                    </div>
                    {m.detail && <div className="text-[12.5px] mt-[5px] opacity-85">{m.detail}</div>}
                    <Chart m={m} points={history} now={t} color={color} gapMs={3 * server.intervalMs} axis={i === all.length - 1} />
                  </div>
                );
              })}
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-[3px] text-[13px] mt-3 mb-0">
              <dt className="opacity-70">Uptime</dt>
              <dd className="m-0 font-semibold">{server.uptimeS == null ? "-" : fmtUptime(server.uptimeS)}</dd>
              <dt className="opacity-70">Memori Agent HQ</dt>
              <dd className="m-0 font-semibold">{server.appRss == null ? "-" : fmtBytes(server.appRss)}</dd>
              <dt className="opacity-70">Sistem</dt>
              <dd className="m-0 font-semibold">{PLATFORM[server.platform] ?? (server.platform || "-")}</dd>
              <dt className="opacity-70">Sampel</dt>
              <dd className="m-0 font-semibold">tiap {Math.round(server.intervalMs / 1000)} dtk</dd>
            </dl>
          </>
        )}
        <h3 className="m-0 mt-3 font-display text-[12px] font-normal">PERINGATAN SERVER</h3>
        {warnings.length ? (
          <div className="mt-1 font-mono text-[12px] leading-[1.55]">
            {warnings.map((l) => (
              <div key={l.key} className={cn(l.level === "warn" && "font-semibold")}>
                <time className="opacity-50 mr-[7px]">{fmtTime(l.t)}</time>
                {l.message}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[12.5px] mt-1 mb-0 opacity-70">Belum ada peringatan sejak halaman dibuka.</p>
        )}
      </div>
    </section>
  );
}
