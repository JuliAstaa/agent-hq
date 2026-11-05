"use client";

import { useStore } from "zustand";
import { hqStore, type FloorMode } from "@/lib/store";
import { ZONE_LABEL, ZONES } from "@/lib/zones";
import { Button, CARD, cn } from "./ui";

// Area views of the single-floor office (deviation 29), front tier to back tier. Were floor buttons (Lt.1 - Lt.4).
const FLOORS: [FloorMode, string][] = [["all", "Semua"], ...ZONES.map((z): [FloorMode, string] => [z, ZONE_LABEL[z]])];

export default function FloorSwitcher() {
  const floorMode = useStore(hqStore, (s) => s.floorMode);
  return (
    <div className={cn(CARD, "pointer-events-auto shrink-0 flex gap-[6px] p-[6px] max-[420px]:box-border max-[420px]:max-w-full max-[420px]:flex-wrap max-[420px]:gap-[5px] max-[420px]:p-[5px]")}>
      {FLOORS.map(([f, label]) => (
        <Button
          key={f}
          size="floor"
          tone={floorMode === f ? "primary" : "paper"}
          data-f={f}
          className="whitespace-nowrap max-[420px]:px-[7px] max-[420px]:text-[12px]"
          onClick={() => hqStore.getState().setFloor(f)}
        >
          {label}
        </Button>
      ))}
    </div>
  );
}
