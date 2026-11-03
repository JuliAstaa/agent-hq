"use client";

import { useStore } from "zustand";
import { hqStore } from "@/lib/store";
import AudioControl from "./AudioControl";
import FloorSwitcher from "./FloorSwitcher";
import StatusChips from "./StatusChips";
import { Button, CARD, CARD_FRAME, cn } from "./ui";

export default function TopBar({ onConnect, onToggleRoster, onCron }: { onConnect: () => void; onToggleRoster: () => void; onCron: () => void }) {
  const conn = useStore(hqStore, (s) => s.conn);
  const hasCron = useStore(hqStore, (s) => s.cron !== null);
  const dot = conn.mode === "live" ? "bg-working animate-[hq-pulse_1.4s_infinite]" : conn.mode === "down" ? "bg-error" : "bg-thinking";
  return (
    <div data-hq-ui="top" className="fixed top-[14px] left-[14px] right-[14px] flex gap-3 items-start pointer-events-none z-[5] flex-wrap min-[1181px]:flex-nowrap [&>*]:pointer-events-auto">
      <div className={cn(CARD_FRAME, "shrink-0 bg-pink px-[14px] pt-2 pb-[6px] -rotate-2")}>
        <h1 className="m-0 font-display text-[22px] max-[820px]:text-[18px] tracking-[1px] leading-none text-paper [-webkit-text-stroke:1.5px_var(--ink)] [paint-order:stroke_fill] [text-shadow:2px_2px_0_var(--ink)]">
          AGENT HQ
        </h1>
        <small className="block text-[11px] font-semibold mt-[3px]">kantor virtual para agen</small>
      </div>
      <FloorSwitcher />
      <StatusChips />
      <div className="flex-1" />
      <div className={cn(CARD, "shrink-0 flex items-center gap-2 py-[6px] pr-2 pl-3")}>
        <span className="flex items-center gap-[6px] font-semibold text-[13px]" data-mode={conn.mode}>
          <i className={cn("inline-block w-[10px] h-[10px] rounded-full border-2 border-ink", dot)} />
          <span>{conn.text}</span>
        </span>
        <AudioControl />
        <Button
          title="Reset kamera"
          onClick={() => {
            hqStore.getState().select(null);
            hqStore.getState().setFloor("all");
          }}
        >
          ⌂
        </Button>
        <Button className="hidden max-[820px]:inline-block" onClick={onToggleRoster}>
          Agen
        </Button>
        {hasCron && (
          <Button title="Papan jadwal (cron Hermes)" onClick={onCron}>
            Jadwal
          </Button>
        )}
        <Button tone="primary" onClick={onConnect}>
          Sambungkan
        </Button>
      </div>
    </div>
  );
}
