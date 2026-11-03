"use client";

import { useStore } from "zustand";
import { hqStore, type FloorMode } from "@/lib/store";
import { Button, CARD, cn } from "./ui";

const FLOORS: [FloorMode, string][] = [
  ["all", "Semua"],
  ["3", "Lt.3 Security"],
  ["2", "Lt.2 Kantor"],
  ["1", "Lt.1 Santai"],
];

export default function FloorSwitcher() {
  const floorMode = useStore(hqStore, (s) => s.floorMode);
  return (
    <div className={cn(CARD, "pointer-events-auto shrink-0 flex gap-[6px] p-[6px] max-[420px]:gap-[5px] max-[420px]:p-[5px]")}>
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
