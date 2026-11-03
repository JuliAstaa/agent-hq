"use client";

import { useMemo } from "react";
import { useStore } from "zustand";
import { STATUS, STATUS_KEYS } from "@/lib/events";
import { hqStore } from "@/lib/store";
import { CARD, cn } from "./ui";

/** Count per status; zero counts are hidden except working, waiting, error (like the prototype). */
export default function StatusChips() {
  const agents = useStore(hqStore, (s) => s.agents);
  const counts = useMemo(() => {
    const c = Object.fromEntries(STATUS_KEYS.map((k) => [k, 0])) as Record<string, number>;
    for (const a of agents.values()) c[a.status]++;
    return c;
  }, [agents]);
  return (
    // Always one line, next to or under the floor switcher (TopBar). Under it, the line may run past the group into the
    // free space below the controls card (it stays clear of the roster).
    <div className={cn(CARD, "pointer-events-auto shrink-0 flex gap-[6px] px-2 py-[7px] max-[1181px]:hidden")}>
      {STATUS_KEYS.filter((k) => counts[k] || k === "working" || k === "waiting" || k === "error").map((k) => (
        <span key={k} className="flex items-center gap-[6px] whitespace-nowrap font-semibold text-[13px] px-[9px] py-[3px] border-2 border-ink rounded-full bg-white">
          <i className="inline-block w-[11px] h-[11px] rounded-full border-2 border-ink" style={{ background: STATUS[k].color }} />
          {STATUS[k].label}
          <b className="tabular-nums">{counts[k]}</b>
        </span>
      ))}
    </div>
  );
}
