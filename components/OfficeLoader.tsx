"use client";

// Client-only loader: Three.js never runs on the server (prd.md §14).
import dynamic from "next/dynamic";

const Office = dynamic(() => import("./Office"), { ssr: false });

export default function OfficeLoader() {
  return <Office />;
}
