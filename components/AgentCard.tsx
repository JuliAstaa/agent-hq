"use client";

import { memo, useEffect, useRef, useState, type FormEvent } from "react";
import { useStore } from "zustand";
import { STATUS } from "@/lib/events";
import { ago, fmtNum, fmtTime } from "@/lib/format";
import { avatarColor, deskLessColor } from "@/lib/palette";
import { MEETING_ROOMS } from "@/lib/meeting";
import { renameAgent, type RenamePatch } from "@/lib/rename";
import { canKick, kickAgent } from "@/lib/kick";
import { hqStore, type Agent } from "@/lib/store";
import { DEPTS, type Dept } from "@/lib/teams";
import { Button, OFF, PILL, cn } from "./ui";

const FIELD = "w-full font-[inherit] text-[13px] px-2 py-[5px] border-[2.5px] border-ink rounded-[10px] bg-white";
const TEAM_CHOICES: [string, string][] = [
  ["keep", "Tetap"],
  ["office", "Kantor (tanpa tim)"],
  ["red", DEPTS.red.label],
  ["report", DEPTS.report.label],
  ["blue", DEPTS.blue.label],
  ["ops", DEPTS.ops.label],
];

/** Rename form inside a roster card (deviation 16). Live: saved on the bridge; demo: this screen only. */
function RenameForm({ a, onDone }: { a: Agent; onDone: () => void }) {
  const live = useStore(hqStore, (s) => s.conn.mode === "live");
  const [name, setName] = useState(a.name);
  const [role, setRole] = useState(a.role);
  const [team, setTeam] = useState("keep");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async (patch: RenamePatch) => {
    setBusy(true);
    setError(null);
    const res = await renameAgent(hqStore, a.id, patch);
    setBusy(false);
    if (res.ok) onDone();
    else setError(res.error);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const patch: RenamePatch = {};
    if (name.trim() !== a.name) patch.name = name.trim() || null;
    if (role.trim() !== a.role) patch.role = role.trim() || null;
    if (team !== "keep") patch.team = team === "office" ? null : (team as Dept);
    if (Object.keys(patch).length) void send(patch);
    else onDone();
  };
  const current = a.dept ? DEPTS[a.dept].label : "Kantor";
  return (
    <form
      className="mt-2 flex flex-col gap-[6px] [border-top:2px_dashed_var(--ink)] pt-2 cursor-default"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") onDone();
      }}
      onSubmit={submit}
    >
      <label className="text-[12px] font-bold">
        Nama
        <input className={FIELD} value={name} maxLength={60} autoFocus onFocus={(e) => e.target.select()} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="text-[12px] font-bold">
        Peran
        <input className={FIELD} value={role} maxLength={60} onChange={(e) => setRole(e.target.value)} />
      </label>
      <label className="text-[12px] font-bold">
        Tim <span className="font-semibold opacity-60">(sekarang: {current})</span>
        <select className={FIELD} value={team} onChange={(e) => setTeam(e.target.value)}>
          {TEAM_CHOICES.map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </select>
      </label>
      {!live && <span className="text-[11.5px] leading-snug opacity-75">Mode demo: nama hanya berubah di layar ini.</span>}
      {error && <span className="text-[12px] leading-snug font-semibold text-[#c2185b]">{error}</span>}
      <div className="flex gap-[6px] flex-wrap justify-end">
        {live && (
          <Button size="log" disabled={busy} title="Kembalikan nama dan peran yang dilaporkan agen itu sendiri" onClick={() => void send({ name: null, role: null })} className="mr-auto disabled:opacity-45">
            Pakai nama asli
          </Button>
        )}
        <Button size="log" disabled={busy} onClick={onDone} className="disabled:opacity-45">
          Batal
        </Button>
        <Button size="log" tone="primary" type="submit" disabled={busy} className="disabled:opacity-45">
          {busy ? "Menyimpan..." : "Simpan"}
        </Button>
      </div>
    </form>
  );
}

/** One roster card (`.agent` in the prototype). `now` ticks every second for the "ago" text. */
function AgentCard({ a, selected, now, onOpenChat, openingChatId }: {
  a: Agent;
  selected: boolean;
  now: number;
  onOpenChat?: (id: string) => void;
  openingChatId: string | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);
  const [kicking, setKicking] = useState(false);
  const kickable = canKick(a.status);
  const kick = async () => {
    setKicking(true);
    const res = await kickAgent(hqStore, a.id);
    // On success the card leaves the roster; keep the button busy until then.
    if (!res.ok) setKicking(false);
    hqStore.getState().showToast(res.ok ? `${a.name} dikeluarkan lewat Airlock. Kembali saat mulai kerja.` : res.error);
  };
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [selected]);

  const st = STATUS[a.status];
  const loc = a.loc ?? (a.meeting ? { where: MEETING_ROOMS[a.meeting.room], what: `rapat ${a.meeting.team}` } : a.slot == null ? { where: "Tanpa meja", what: "" } : { where: "Meja kerja · Kantor", what: "" });
  const pct = a.progress == null ? null : Math.round(a.progress * 100);
  const events = a.events.slice(-12).reverse();
  return (
    <div
      ref={ref}
      data-id={a.id}
      className={cn(
        "agent border-[2.5px] border-ink rounded-xl px-[10px] py-[9px] cursor-pointer transition-transform duration-100 hover:translate-x-[-3px]",
        selected ? "sel bg-paper2 shadow-[4px_4px_0_var(--ink)]" : "bg-white",
      )}
      onClick={() => {
        const s = hqStore.getState();
        s.select(a.id === s.selectedId ? null : a.id, true);
      }}
    >
      <div className="flex items-center gap-2">
        <span
          className="relative flex-none w-[26px] h-[26px] rounded-full border-[2.5px] border-ink after:content-[''] after:absolute after:w-2 after:h-2 after:rounded-full after:bg-white after:border-2 after:border-ink after:top-[5px] after:left-[6px]"
          style={{ background: a.slot != null || a.meeting ? avatarColor(a.id) : deskLessColor(a.id) }}
        />
        <span className="font-bold text-[15px]">{a.name}</span>
        <span className="text-[12px] opacity-65 flex-1 whitespace-nowrap overflow-hidden text-ellipsis">{a.role}</span>
        <Button
          size="log"
          className="px-[6px] leading-none"
          title="Ganti nama, peran, atau tim"
          aria-label={`Ganti nama ${a.name}`}
          aria-expanded={editing}
          onClick={(e) => {
            e.stopPropagation();
            setEditing((v) => !v);
          }}
        >
          ✎
        </Button>
        <span className={PILL} style={{ background: st.color }}>
          {st.label}
        </span>
      </div>
      {editing && <RenameForm a={a} onDone={() => setEditing(false)} />}
      <div className="text-[13px] mt-[6px] mb-[2px] leading-[1.3]">{a.task || "-"}</div>
      <div className="text-[12px] font-semibold mt-[2px] mb-[3px] flex gap-[5px] items-center">
        <i className="not-italic text-[10px] font-bold border-2 border-ink rounded-md px-[5px] bg-paper2">{loc.where}</i>
        {loc.what}
      </div>
      <div className="text-[11.5px] opacity-60 font-mono">
        {fmtNum(a.tokens)} token{a.cost != null ? " · $" + a.cost.toFixed(3) : ""} · {ago(a.updatedAt, now)}
      </div>
      {/* Kick on the left, chat on the right: the middle stays free, so a click there still selects the card. */}
      <div className="mt-2 flex justify-between gap-[6px]">
        <Button
          size="log"
          className={OFF}
          aria-label={`Keluarkan ${a.name}`}
          disabled={!kickable || kicking}
          title={kickable ? "Antar agen ini ke Airlock dan lempar ke luar angkasa. Ia kembali sendiri saat mulai kerja." : "Hanya agen Santai atau Offline yang bisa dikeluarkan"}
          onClick={(e) => {
            e.stopPropagation();
            void kick();
          }}
        >
          {kicking ? "Mengeluarkan..." : "Keluarkan"}
        </Button>
        <Button
          size="log"
          className={OFF}
          aria-label={`Buka chat ${a.name}`}
          disabled={!onOpenChat || openingChatId !== null}
          title={onOpenChat ? "Buka sesi chat Hermes agen ini" : "Chat tersedia saat terhubung ke server dengan Chat Hermes aktif"}
          onClick={(e) => {
            e.stopPropagation();
            onOpenChat?.(a.id);
          }}
        >
          {openingChatId === a.id ? "Membuka..." : "Buka chat"}
        </Button>
      </div>
      {selected && (
        <div className="mt-2 [border-top:2px_dashed_var(--ink)] pt-2">
          <div className="text-[11.5px] opacity-60 font-mono">{pct == null ? "Progres: tidak dilaporkan" : `Progres: ${pct}%`}</div>
          <div className="h-3 border-[2.5px] border-ink rounded-full bg-white overflow-hidden mt-1 mb-2">
            <span className="block h-full bg-working border-r-[2.5px] border-ink transition-[width] duration-[400ms]" style={{ width: (pct ?? 0) + "%" }} />
          </div>
          <div className="font-mono text-[11px] leading-[1.45] max-h-[150px] overflow-auto">
            {events.length ? (
              events.map((e, i) => (
                <div key={e.t + ":" + i} className={cn(e.level, "whitespace-nowrap overflow-hidden text-ellipsis")}>
                  <time className="opacity-50 mr-[6px]">{fmtTime(e.t)}</time>
                  {e.msg}
                </div>
              ))
            ) : (
              <div className="whitespace-nowrap overflow-hidden text-ellipsis">Belum ada event.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default memo(AgentCard);
