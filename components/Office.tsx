"use client";

// Mounts the Three.js engine and wires store, transport and demo. React 2D UI comes in step 5.
import { useEffect, useRef } from "react";
import { createEngine, type Engine } from "@/engine";
import { createDemo } from "@/lib/demo";
import { hqStore, type HQStore } from "@/lib/store";
import { createTransport } from "@/lib/transport";

export interface AgentHQHandle {
  store: HQStore;
  applyEvent: (ev: unknown) => void;
  startSim: () => void;
  stopSim: () => void;
  /** Close any live connection and run the demo (modal "Kembali ke demo"). */
  demo: () => void;
  connect: (url: string) => void;
  setFloor: Engine["setFloor"];
  select: Engine["select"];
  placeAt: Engine["placeAt"];
  placeIds: Engine["placeIds"];
  camera: Engine["camera"];
  controls: Engine["controls"];
  /** Debug/tests only (dispose check). */
  engine: Engine;
}

declare global {
  interface Window {
    agentHQ?: AgentHQHandle;
  }
}

export default function Office() {
  const stageRef = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const engine = createEngine(stageRef.current!, labelsRef.current!, hqStore);
    const demo = createDemo(hqStore);
    const transport = createTransport(hqStore, demo);
    const streamParam = new URLSearchParams(window.location.search).get("stream");
    if (process.env.NEXT_PUBLIC_HQ_STATIC === "1") demo.start();
    else if (streamParam) transport.connect(streamParam);
    else transport.connect("/api/stream", { fallbackToDemo: true });

    window.agentHQ = {
      store: hqStore,
      applyEvent: (ev) => hqStore.getState().applyEvent(ev),
      startSim: demo.start,
      stopSim: demo.stop,
      demo: transport.backToDemo,
      connect: (url) => transport.connect(url),
      setFloor: engine.setFloor,
      select: engine.select,
      placeAt: engine.placeAt,
      placeIds: engine.placeIds,
      camera: engine.camera,
      controls: engine.controls,
      engine,
    };
    return () => {
      transport.close();
      demo.stop();
      engine.dispose();
      delete window.agentHQ;
    };
  }, []);

  return (
    <>
      <div ref={stageRef} className="hq-stage" />
      <div ref={labelsRef} className="hq-labels" />
    </>
  );
}
