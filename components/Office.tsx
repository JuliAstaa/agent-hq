"use client";

// Mounts the Three.js engine, wires store, transport and demo, and renders the React 2D UI on top.
import { useCallback, useEffect, useRef, useState } from "react";
import { createEngine, type Engine } from "@/engine";
import { createDemo } from "@/lib/demo";
import { setLiveUrlSource } from "@/lib/rename";
import { hqStore, type HQStore } from "@/lib/store";
import { createTransport, type Transport } from "@/lib/transport";
import { CRON_BOARD_EVENT } from "@/lib/cron";
import ConnectModal from "./ConnectModal";
import CronPanel from "./CronPanel";
import HermesPanel, { useHermesAvailable } from "./HermesPanel";
import LogPanel from "./LogPanel";
import Roster from "./Roster";
import Toast from "./Toast";
import TopBar from "./TopBar";

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
  const transportRef = useRef<Transport | null>(null);
  const [rosterOpen, setRosterOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const closeModal = useCallback(() => setModalOpen(false), []);
  const [cronOpen, setCronOpen] = useState(false);
  const closeCron = useCallback(() => setCronOpen(false), []);
  const liveUrl = useCallback(() => transportRef.current?.liveUrl ?? null, []);
  const [hermesOpen, setHermesOpen] = useState(false);
  const closeHermes = useCallback(() => setHermesOpen(false), []);
  const hermesOn = useHermesAvailable(liveUrl);

  useEffect(() => {
    const engine = createEngine(stageRef.current!, labelsRef.current!, hqStore);
    const demo = createDemo(hqStore);
    const transport = createTransport(hqStore, demo);
    transportRef.current = transport;
    setLiveUrlSource(() => transport.liveUrl); // roster rename posts next to the live stream (deviation 16)
    const streamParam = new URLSearchParams(window.location.search).get("stream");
    if (process.env.NEXT_PUBLIC_HQ_STATIC === "1") demo.start();
    else if (streamParam) transport.connect(streamParam);
    else transport.connect("/api/stream", { fallbackToDemo: true });

    const openCron = () => setCronOpen(true); // the 3D schedule board was clicked
    window.addEventListener(CRON_BOARD_EVENT, openCron);

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
      window.removeEventListener(CRON_BOARD_EVENT, openCron);
      transport.close();
      demo.stop();
      engine.dispose();
      transportRef.current = null;
      setLiveUrlSource(() => null);
      delete window.agentHQ;
    };
  }, []);

  return (
    <>
      <div ref={stageRef} className="hq-stage" />
      <div ref={labelsRef} className="hq-labels" />
      <TopBar
        onConnect={() => setModalOpen(true)}
        onToggleRoster={() => setRosterOpen((v) => !v)}
        onCron={() => setCronOpen(true)}
        onHermes={hermesOn ? () => setHermesOpen((v) => !v) : undefined}
      />
      <Roster open={rosterOpen} />
      <LogPanel />
      <Toast />
      <ConnectModal
        open={modalOpen}
        liveUrl={liveUrl}
        onClose={closeModal}
        onConnect={(url) => transportRef.current?.connect(url)}
        onDemo={() => transportRef.current?.backToDemo()}
      />
      {cronOpen && <CronPanel open onClose={closeCron} liveUrl={liveUrl} />}
      {hermesOpen && hermesOn && <HermesPanel onClose={closeHermes} liveUrl={liveUrl} />}
    </>
  );
}
