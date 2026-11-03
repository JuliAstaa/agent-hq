"use client";

import { useEffect, useState } from "react";
import { useStore } from "zustand";
import { hqStore } from "@/lib/store";
import { CARD, cn } from "./ui";

/** Shows the latest store toast for 2.6 s. */
export default function Toast() {
  const toast = useStore(hqStore, (s) => s.toast);
  const [hiddenSeq, setHiddenSeq] = useState(0);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setHiddenSeq(toast.seq), 2600);
    return () => clearTimeout(t);
  }, [toast]);
  const show = !!toast && toast.seq !== hiddenSeq;
  return (
    <div
      data-hq-ui="toast"
      className={cn(
        CARD,
        "fixed left-1/2 top-[84px] -translate-x-1/2 px-[14px] py-2 font-semibold text-[14px] transition-all duration-[250ms] z-30 pointer-events-none",
        show ? "translate-y-0 opacity-100" : "translate-y-[-20px] opacity-0",
      )}
    >
      {toast?.msg}
    </div>
  );
}
