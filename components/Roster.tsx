"use client";

import { useEffect, useState } from "react";
import { useStore } from "zustand";
import { hqStore } from "@/lib/store";
import AgentCard from "./AgentCard";
import { CARD, PILL, cn } from "./ui";

export default function Roster({ open }: { open: boolean }) {
  const agents = useStore(hqStore, (s) => s.agents);
  const selectedId = useStore(hqStore, (s) => s.selectedId);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <aside
      data-hq-ui="roster"
      className={cn(
        CARD,
        "fixed top-[84px] right-[14px] bottom-[14px] w-[330px] flex flex-col z-[4]",
        "max-[820px]:top-auto max-[820px]:h-[52vh] max-[820px]:w-auto max-[820px]:left-[14px] max-[820px]:transition-transform max-[820px]:duration-[250ms]",
        open ? "" : "max-[820px]:translate-y-[calc(100%+20px)]",
      )}
    >
      <header className="flex items-center justify-between px-3 pt-[10px] pb-2 border-b-[3px] border-ink">
        <h2 className="m-0 font-display text-[15px]">DAFTAR AGEN</h2>
        <span className={PILL} style={{ background: "#fff" }}>
          {agents.size}
        </span>
      </header>
      <div className="overflow-auto p-[10px] flex flex-col gap-[9px]">
        {agents.size === 0 ? (
          <div className="text-[13px] opacity-70 px-1 py-[6px]">Belum ada agen. Menunggu data...</div>
        ) : (
          [...agents.values()].map((a) => <AgentCard key={a.id} a={a} selected={a.id === selectedId} now={now} />)
        )}
      </div>
    </aside>
  );
}
