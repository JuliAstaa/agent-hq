"use client";

import { useStore } from "zustand";
import { hqStore } from "@/lib/store";
import AudioControl from "./AudioControl";
import FloorSwitcher from "./FloorSwitcher";
import StatusChips from "./StatusChips";
import { Button, CARD, CARD_FRAME, cn } from "./ui";

export default function TopBar({
  onConnect,
  onToggleRoster,
  onCron,
  onHermes,
}: {
  onConnect: () => void;
  onToggleRoster: () => void;
  onCron: () => void;
  /** Set when the Agent HQ server has the Hermes chat configured. */
  onHermes?: () => void;
}) {
  const conn = useStore(hqStore, (s) => s.conn);
  const hasCron = useStore(hqStore, (s) => s.cron !== null);
  const dot = conn.mode === "live" ? "bg-working animate-[hq-pulse_1.4s_infinite]" : conn.mode === "down" ? "bg-error" : "bg-thinking";
  // Layout (deviation 19): the controls always stay top right so they never cover the roster below them.
  // Wide: one row like the prototype. Floors and status chips share the middle group, and the chips drop under
  // the floors (still one line) when the row is full. At 1180px and below the chips are hidden (prototype) and
  // the floors move to a second row under the logo. Only the cards take clicks; the gaps pass them to the scene.
  return (
    <div data-hq-ui="top" className="fixed top-[14px] left-[14px] right-[14px] flex flex-wrap gap-3 items-start pointer-events-none z-[5]">
      <div className={cn(CARD_FRAME, "pointer-events-auto shrink-0 bg-pink px-[14px] pt-2 pb-[6px] -rotate-2")}>
        <h1 className="m-0 font-display text-[22px] max-[820px]:text-[18px] tracking-[1px] leading-none text-paper [-webkit-text-stroke:1.5px_var(--ink)] [paint-order:stroke_fill] [text-shadow:2px_2px_0_var(--ink)]">
          AGENT HQ
        </h1>
        <small className="block text-[11px] font-semibold mt-[3px]">kantor virtual para agen</small>
      </div>
      <div className="flex-1 min-w-0 flex flex-wrap gap-3 items-start max-[1181px]:order-last max-[1181px]:basis-full">
        <FloorSwitcher />
        <StatusChips />
      </div>
      <div className={cn(CARD, "pointer-events-auto shrink-0 ml-auto flex items-center gap-2 py-[6px] pr-2 pl-3", "max-[820px]:shrink max-[820px]:min-w-0 max-[820px]:flex-wrap")}>
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
        {onHermes && (
          <Button title="Chat dengan Hermes" onClick={onHermes}>
            Hermes
          </Button>
        )}
        <Button tone="primary" onClick={onConnect}>
          Sambungkan
        </Button>
      </div>
    </div>
  );
}
