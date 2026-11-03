"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { fmtTime } from "@/lib/format";
import { hqStore } from "@/lib/store";
import { Button, CARD_FRAME, cn } from "./ui";

const LEVEL_CLASS: Record<string, string> = {
  warn: "text-thinking",
  error: "text-[#ff8a94]",
  move: "text-[#b9a8ff]",
  alert: "text-[#ff8a94] font-semibold",
  find: "text-[#ffb86b]",
};

/** Activity log (bottom left). Filtered lines stay in the DOM with display:none, like the prototype. */
export default function LogPanel() {
  const logs = useStore(hqStore, (s) => s.logs);
  const [showMoves, setShowMoves] = useState(true);
  const [errOnly, setErrOnly] = useState(false);
  const [min, setMin] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const visible = (level: string) => (errOnly ? level === "error" || level === "alert" : showMoves || level !== "move");

  // Keep following new lines only while the list is scrolled to the bottom.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [logs]);

  return (
    <section
      data-hq-ui="log"
      className={cn(
        CARD_FRAME,
        "fixed left-[14px] bottom-[14px] w-[min(470px,calc(100vw-372px))] flex flex-col z-[4] bg-violet text-paper",
        "max-[820px]:w-[calc(100vw-28px)]",
        min ? "h-auto" : "h-[200px] max-[820px]:h-[130px]",
      )}
    >
      <header className="flex items-center gap-2 px-[10px] py-[7px] border-b-[3px] border-ink bg-paper text-ink rounded-t-[11px]">
        <h2 className="m-0 font-display text-[13px] flex-1">LOG AKTIVITAS</h2>
        <Button size="log" tone={showMoves ? "alert" : "paper"} title="Tampilkan perpindahan agen" onClick={() => setShowMoves((v) => !v)}>
          Jalan
        </Button>
        <Button size="log" tone={errOnly ? "alert" : "paper"} onClick={() => setErrOnly((v) => !v)}>
          Error saja
        </Button>
        <Button size="log" onClick={() => setMin((v) => !v)}>
          _
        </Button>
      </header>
      <div
        ref={listRef}
        className={cn("flex-1 overflow-auto px-[10px] py-[7px] font-mono text-[12px] leading-[1.55]", min && "hidden")}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
        }}
      >
        {logs.map((l) => (
          <div
            key={l.key}
            data-level={l.level}
            className={cn(l.level, LEVEL_CLASS[l.level], "whitespace-nowrap overflow-hidden text-ellipsis")}
            style={visible(l.level) ? undefined : { display: "none" }}
          >
            <time className="opacity-50 mr-[7px]">{fmtTime(l.t)}</time>
            <b className="mr-[6px]" style={{ color: l.color }}>
              {l.name}
            </b>
            {l.message}
          </div>
        ))}
      </div>
    </section>
  );
}
