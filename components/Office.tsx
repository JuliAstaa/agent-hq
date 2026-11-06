"use client";

// Mounts the Three.js engine, wires store, transport and demo, and renders the React 2D UI on top.
import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { createEngine, type Engine } from "@/engine";
import { createDemo } from "@/lib/demo";
import { setLiveUrlSource } from "@/lib/rename";
import { hqStore, type HQStore } from "@/lib/store";
import { createTransport, type Transport } from "@/lib/transport";
import { CRON_BOARD_EVENT } from "@/lib/cron";
import { SERVER_ROOM_EVENT } from "@/lib/server";
import { hermesUrlFor } from "@/lib/hermes-chat";
import ConnectModal from "./ConnectModal";
import CronPanel from "./CronPanel";
import HermesPanel, { useHermesAvailable, type HermesPanelHandle } from "./HermesPanel";
import LogPanel from "./LogPanel";
import Roster from "./Roster";
import ServerPanel from "./ServerPanel";
import TerminalPanel, { useTerminalUrl } from "./TerminalPanel";
import Toast from "./Toast";
import TopBar from "./TopBar";
import { authHeader, readToken } from "@/lib/token";
import { MEETING_OPEN_EVENT } from "@/lib/discussions";
import { MEETING_ROOMS } from "@/lib/meeting";
import MeetingPanel from "./MeetingPanel";
import { Button, CARD, cn } from "./ui";

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
  const [infoHidden, setInfoHidden] = useState(false);
  const [rosterOpen, setRosterOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const closeModal = useCallback(() => setModalOpen(false), []);
  const [cronOpen, setCronOpen] = useState(false);
  const closeCron = useCallback(() => setCronOpen(false), []);
  const liveUrl = useCallback(() => transportRef.current?.liveUrl ?? null, []);
  const [hermesOpen, setHermesOpen] = useState(false);
  const closeHermes = useCallback(() => setHermesOpen(false), []);
  const hermesOn = useHermesAvailable(liveUrl);
  const hermesPanelRef = useRef<HermesPanelHandle>(null);
  const chatRequestRef = useRef<AbortController | null>(null);
  const [openingChatId, setOpeningChatId] = useState<string | null>(null);
  // The Hermes, terminal and server panels take the same spot on the right, so opening one closes the others. The open
  // terminal panel keeps its address: ttyd does not depend on the office stream, so a restart of Agent HQ (e.g.
  // ./start.sh typed in that terminal) hides the button for a moment but leaves the panel connected.
  const [termOpenUrl, setTermOpenUrl] = useState<string | null>(null);
  const closeTerm = useCallback(() => setTermOpenUrl(null), []);
  const termUrl = useTerminalUrl(liveUrl);
  const [serverOpen, setServerOpen] = useState(false);
  const closeServer = useCallback(() => setServerOpen(false), []);
  const [meetingRoom, setMeetingRoom] = useState<number | null>(null);
  const closeMeeting = useCallback(() => setMeetingRoom(null), []);
  const floor = useStore(hqStore, (s) => s.floorMode);
  const openMeeting = useCallback((room: number) => {
    setHermesOpen(false); setTermOpenUrl(null); setServerOpen(false); setMeetingRoom(room);
  }, []);

  const openAgentChat = useCallback(async (agentId: string) => {
    const url = hermesOn ? hermesUrlFor(liveUrl(), window.location.href) : null;
    if (!url || chatRequestRef.current) return;
    const ac = new AbortController();
    chatRequestRef.current = ac;
    setOpeningChatId(agentId);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeader(readToken()) },
        body: JSON.stringify({ action: "open", agentId }),
        signal: ac.signal,
      });
      const body = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
      if (res.status === 401) {
        hqStore.getState().showToast("Buka panel Hermes dan masukkan HQ_TOKEN dulu, lalu coba lagi.");
      } else if (!res.ok || !body?.ok) {
        hqStore.getState().showToast(body?.error || `Chat tidak bisa dibuka (HTTP ${res.status}).`);
      } else {
        setMeetingRoom(null);
        setTermOpenUrl(null);
        setServerOpen(false);
        hermesPanelRef.current?.showChat();
        setHermesOpen(true);
      }
    } catch {
      if (!ac.signal.aborted) hqStore.getState().showToast("Chat tidak bisa dibuka. Cek koneksi ke Agent HQ.");
    } finally {
      if (!ac.signal.aborted) setOpeningChatId(null);
      chatRequestRef.current = null;
    }
  }, [hermesOn, liveUrl]);

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
    const openServer = () => {
      // the 3D server room was clicked
      setHermesOpen(false);
      setTermOpenUrl(null);
      setServerOpen(true);
      setMeetingRoom(null);
    };
    window.addEventListener(SERVER_ROOM_EVENT, openServer);
    const meeting = (event: Event) => openMeeting((event as CustomEvent<number>).detail);
    window.addEventListener(MEETING_OPEN_EVENT, meeting);

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
      chatRequestRef.current?.abort();
      window.removeEventListener(CRON_BOARD_EVENT, openCron);
      window.removeEventListener(SERVER_ROOM_EVENT, openServer);
      window.removeEventListener(MEETING_OPEN_EVENT, meeting);
      transport.close();
      demo.stop();
      engine.dispose();
      transportRef.current = null;
      setLiveUrlSource(() => null);
      delete window.agentHQ;
    };
  }, [openMeeting]);

  return (
    <>
      <div ref={stageRef} className="hq-stage" />
      <div ref={labelsRef} className="hq-labels" />
      <TopBar
        infoHidden={infoHidden}
        onToggleInfo={() => setInfoHidden((v) => !v)}
        onConnect={() => setModalOpen(true)}
        onToggleRoster={() => setRosterOpen((v) => !v)}
        onCron={() => setCronOpen(true)}
        onHermes={
          hermesOn
            ? () => {
                setMeetingRoom(null);
                setTermOpenUrl(null);
                setServerOpen(false);
                setHermesOpen((v) => !v);
              }
            : undefined
        }
        onTerminal={
          termUrl
            ? () => {
                setMeetingRoom(null);
                setHermesOpen(false);
                setServerOpen(false);
                setTermOpenUrl((v) => (v ? null : termUrl));
              }
            : undefined
        }
      />
      <div data-hq-ui="panels" style={infoHidden ? { display: "none" } : undefined}>
        {floor === "meeting" && meetingRoom === null && <nav data-hq-ui="meeting-access" aria-label="Buka ruang meeting" className={cn(CARD, "fixed bottom-[14px] right-[14px] z-[5] flex gap-2 p-2")}>
          {MEETING_ROOMS.map((name, room) => <Button key={name} size="log" onClick={() => openMeeting(room)}>{name}</Button>)}
        </nav>}
        <Roster open={rosterOpen} onOpenChat={hermesOn ? openAgentChat : undefined} openingChatId={openingChatId} />
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
        {hermesOpen && hermesOn && <HermesPanel ref={hermesPanelRef} onClose={closeHermes} liveUrl={liveUrl} />}
        {termOpenUrl && <TerminalPanel url={termOpenUrl} onClose={closeTerm} />}
        {serverOpen && <ServerPanel onClose={closeServer} />}
        {meetingRoom !== null && <MeetingPanel room={meetingRoom} onRoom={openMeeting} onClose={closeMeeting} liveUrl={liveUrl} />}
      </div>
    </>
  );
}
