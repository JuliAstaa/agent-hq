// Agent HQ 3D engine: framework-free Three.js, ported from references/agent-hq.html (prd.md §14).
// createEngine() builds one office in `stage`, reads the zustand store, and cleans up fully on dispose().

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import { OutlineEffect } from "three/addons/effects/OutlineEffect.js";
import { STATUS } from "@/lib/events";
import type { Agent, FloorMode, HQState, HQStore, Signal } from "@/lib/store";
import { DEPTS } from "@/lib/teams";
import type { ZoneId } from "@/lib/zones";
import { truncate } from "@/lib/format";
import { ACT_LABEL, INK } from "./constants";
import { T2, VIEWS } from "./layout";
import { animateAgent, type AgentRuntime, type AnimCtx } from "./agents/animate";
import { buildAvatar } from "./agents/avatar";
import { createEjector } from "./agents/eject";
import { allowedQuirks, CHAT_REPLIES, chatLine, newFun, say, startQuirk, tickFun, type ChatSlots, type FunInfo, type Quirk } from "./agents/fun";
import { locText, newMovement, pickSpot, placeAt, releasePlaces, workTarget, zoneOf, type NavCtx } from "./agents/movement";
import { drawArcade, drawBoard, drawEmptyDesk, drawPlate, drawScreen, drawTaskBoard, drawTV, drawWhiteboard, newWhiteboardEgg } from "./displays/office";
import { drawRedWall, drawReportBoard, drawSOC, drawStation, newSocAnim } from "./displays/security";
import { drawScheduleBoard } from "./displays/schedule";
import { drawServerScreen, litRows } from "./displays/server";
import { diskPct, LEVEL_COLOR, levelOf, memPct, OFFLINE_COLOR, SERVER_ROOM_EVENT, serverStale } from "@/lib/server";
import { CRON_BOARD_EVENT } from "@/lib/cron";
import { createFx } from "./fx";
import { createSkyEvents, type SkyEventKind } from "./skyEvents";
import { planMeteors, planPortal, type NdcRect, type PlaceCtx, type SkyZone } from "./skyPlacement";
import { SFX_EVENT } from "@/lib/audio";
import { createAirlockSpots, createBoardSlots, createDeskSlots, createSeats, createSpots, STATION_LAYOUT, type Place, type SeatPlace } from "./nav/places";
import { loadFonts, resolveFonts } from "./scene/fonts";
import { createKit, createMaterials, V } from "./scene/kit";
import { buildSky, makeSkyTexture } from "./scene/sky";
import { buildDesk, type Desk } from "./world/props/desk";
import { buildIsland } from "./world/island";
import { buildSantai } from "./world/santai";
import { buildKantor } from "./world/kantor";
import { buildSecurity, buildStation } from "./world/security";
import { buildMeeting, flyCard, MEETING_IDLE, stepCards, stepDoors } from "./world/meeting";
import { buildServerRoom, LIQUID_BASE, LIQUID_FULL, stepServerDoor } from "./world/server";
import { buildAirlock } from "./world/airlock";
import { drawMeetingScreen, type MeetingScreenInfo } from "./displays/meeting";
import { MEETING_ROOMS, SEATS_PER_ROOM } from "@/lib/meeting";
import { DISCUSSION_LABEL, discussionActive, MEETING_OPEN_EVENT } from "@/lib/discussions";
import { avatarColor } from "@/lib/palette";
import type { Build } from "./world/structure";

export interface Engine {
  setFloor: (floor: FloorMode) => void;
  select: (id: string | null, focus?: boolean) => void;
  /** Debug/test: teleport agent `id` to a place ("desk", a spot id like "coffee", or "station:N"). */
  placeAt: (id: string, placeId: string) => boolean;
  placeIds: () => string[];
  /** Start a sky event now (portal or meteor, random when omitted); false while one is running. */
  skyEvent: (kind?: SkyEventKind, zone?: SkyZone) => boolean;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  /** Idempotent. */
  dispose: () => void;
  /** Tests only. */
  debug: {
    /** Hide desks that have no agent (visual parity: the prototype has no desks without agents, deviation 7). */
    hideEmptyDesks: (hidden: boolean) => void;
    /** Where sky events would land from the current camera: zone counts over `n` placements (no event started). */
    skyZones: (kind: SkyEventKind, n?: number) => Record<string, number>;
    /** Hide the task board (visual parity: the prototype has none, deviation 14). */
    hideTaskBoard: (hidden: boolean) => void;
    /** Hide the schedule board even when a schedule source reports (it is hidden without one). */
    hideScheduleBoard: (hidden: boolean) => void;
    /** Keep the server room decor (as in the prototype) even while the bridge sends server samples. */
    hideServerMonitor: (hidden: boolean) => void;
    /** Whiteboard easter egg: write it now if someone is at the board, else at the next whiteboard session. */
    whiteboardEgg: () => void;
    /** Kicked agents on their way out (prd.md §7.10): phase, seconds in it, area, and the Airlock doors (0..1). */
    ejects: () => { id: string; phase: string; t: number; zone: ZoneId; door: number; hatch: number }[];
    /** Open a chat balloon on agent `id` (random line for its context when `text` is omitted). */
    say: (id: string, text?: string) => boolean;
    /** Start a random action on agent `id` (any allowed one when `kind` is omitted). */
    quirk: (id: string, kind?: Quirk) => boolean;
  };
}

const LOC_INTERVAL = 0.25;

export function createEngine(stage: HTMLElement, labelsEl: HTMLElement, store: HQStore): Engine {
  let disposed = false;
  const S = () => store.getState();
  const fonts = resolveFonts();
  let fontsReady = false;
  const kit = createKit();
  const M = createMaterials(kit);
  const sharedMats = new Set<THREE.Material>(Object.values(M));

  /* ---------------- renderer / scene ---------------- */
  const vw = () => window.innerWidth, vh = () => window.innerHeight;
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(vw(), vh());
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  stage.appendChild(renderer.domElement);
  const effect = new OutlineEffect(renderer, { defaultThickness: 0.0038, defaultColor: new THREE.Color(INK).toArray(), defaultAlpha: 1 });
  const labelRenderer = new CSS2DRenderer({ element: labelsEl });
  labelRenderer.setSize(vw(), vh());

  const scene = new THREE.Scene();
  const skyTex = makeSkyTexture();
  scene.background = skyTex;
  const camera = new THREE.PerspectiveCamera(36, vw() / vh(), 0.1, 400);
  const startView = VIEWS[S().floorMode];
  camera.position.set(...startView.pos);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(...startView.target);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = 1.42;
  controls.minDistance = 4;
  controls.maxDistance = 85;
  controls.update();

  scene.add(new THREE.AmbientLight("#cbb8ff", 1.15));
  const sun = new THREE.DirectionalLight("#fff1d6", 2.1);
  sun.position.set(16, 36, 22);
  sun.castShadow = true;
  // One floor (deviation 29): the shadow box covers the whole island, at a higher resolution for the larger area.
  sun.shadow.mapSize.set(4096, 4096);
  Object.assign(sun.shadow.camera, { left: -40, right: 40, top: 40, bottom: -40, near: 1, far: 140 });
  sun.shadow.bias = -0.0008;
  sun.shadow.normalBias = 0.04; // toon materials cast from front faces (shadowSide), avoid self-shadow acne
  scene.add(sun);
  const rim = new THREE.DirectionalLight("#ff8fd8", 0.7);
  rim.position.set(-14, 8, -10);
  scene.add(rim);

  /* ---------------- world ---------------- */
  // Single-floor terraced island (deviation 29, engine/layout.ts). One group per area, all always visible.
  const world = new THREE.Group(); scene.add(world);
  const gSantai = new THREE.Group(), gKantor = new THREE.Group(), gSecurity = new THREE.Group(), gMeeting = new THREE.Group(), gServer = new THREE.Group();
  world.add(gSantai, gKantor, gSecurity, gMeeting, gServer);
  const b: Build = { kit, M, roomLabels: [], looseTextures: [] };
  buildIsland(b, world);
  const skyAnim = buildSky(kit, scene);
  const tentacles: THREE.Group[] = [];
  const props = buildSantai(b, gSantai, tentacles, fonts);
  const p2 = buildKantor(b, gKantor, tentacles);
  const SEC = buildSecurity(b, gSecurity, tentacles, fonts);
  const SR = buildServerRoom(b, gServer);
  const seats = createSeats();
  const F4P = buildMeeting(b, gMeeting, fonts, seats);
  const airlock = buildAirlock(b, gSantai, fonts); // kicked agents leave through it (prd.md §7.10)
  const seatProps = F4P.rooms.flatMap((r) => r.seats); // index = SeatPlace.index
  // Team stations in STATION_LAYOUT order: Security's eleven, then the three DevOps stations in the server room.
  const stations = STATION_LAYOUT.map((r, i) => buildStation(b, r[0] === "ops" ? gServer : gSecurity, i));
  const spots = createSpots();
  const boards = createBoardSlots(); // task board standing spots (deviation 14)
  drawTaskBoard(null, p2.taskBoard.face);
  // Schedule board (Hermes cron): shown only while a schedule source reports.
  const SB = p2.scheduleBoard;
  let scheduleHidden = false; // tests only, see Engine.debug
  let bellOn = false;
  const refreshSchedule = () => {
    const c = S().cron;
    SB.group.visible = !!c && !scheduleHidden;
    if (c) bellOn = drawScheduleBoard(fontsReady ? fonts : null, SB.face, c, Date.now());
    else bellOn = false;
  };
  refreshSchedule();
  // Server monitor (prd.md §7.8): racks, tank and wall screen show the bridge's samples; decor without them.
  let serverHidden = false; // tests only, see Engine.debug
  const serverOn = () => (serverHidden ? null : S().server);
  const refreshServer = () => {
    const sv = serverOn();
    SR.screen.group.visible = !!sv;
    if (sv) drawServerScreen(fontsReady ? fonts : null, SR.screen.face, sv, Date.now());
  };
  refreshServer();
  let liquidKey = "";
  const slots = createDeskSlots();
  // All 9 home desks exist from the start (deviation 7): an agent takes the desk of its slot and leaves it
  // empty again on removal. The prototype built a desk per agent, so an office without agents had no desks.
  const DESK_EMPTY = "#3a3360";
  const desks: Desk[] = slots.map((slot) => buildDesk(b, gKantor, slot));
  let emptyDesksHidden = false; // tests only, see Engine.debug
  const resetDesk = (d: Desk) => {
    d.group.visible = !emptyDesksHidden;
    d.strip.material.color.set(DESK_EMPTY);
    d.ring.material.color.set(DESK_EMPTY);
    d.glow.material.opacity = 0;
    d.chair.position.y = 0;
    d.group.traverse((o) => { delete o.userData.agentId; });
    drawEmptyDesk(fontsReady ? fonts : null, d);
  };
  desks.forEach(resetDesk);
  const soc = newSocAnim();
  const fx = createFx(kit, world);
  // Random sky events (deviation 13). Sounds go out as a bubbling DOM event that lib/audio.ts plays.
  // Placement inputs, read when an event starts (skyPlacement.ts): sky bodies to avoid, the building's silhouette
  // (the whole island), and the screen areas covered by UI panels.
  const placeCtx = (): PlaceCtx => {
    const obstacles: THREE.Sphere[] = [], occluders: THREE.Sphere[] = [];
    for (const o of scene.children) {
      const r = o.userData.obstacleRadius as number | undefined;
      if (!r) continue;
      const s = new THREE.Sphere(o.getWorldPosition(new THREE.Vector3()), r);
      obstacles.push(s);
      if (!o.userData.smallRock) occluders.push(s);
    }
    const top = T2 + 4.7; // back wall top
    const dy = world.position.y;
    const building: THREE.Vector3[] = [];
    for (const x of [-30, 30]) for (const z of [-21, 16.4]) for (const y of [-0.8, top]) building.push(V(x, y + dy, z));
    building.push(V(0, -15.8 + dy, -2.2), V(7, -21.5 + dy, -1)); // the rock under the island
    const cr = renderer.domElement.getBoundingClientRect();
    const uiRects: NdcRect[] = [];
    for (const el of document.querySelectorAll<HTMLElement>("[data-hq-ui]")) {
      const kind = el.dataset.hqUi;
      if (kind === "toast" || kind === "modal" || kind === "audio") continue;
      for (const part of kind === "top" ? [...el.children] : [el]) {
        const r = part.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        uiRects.push({
          x0: ((r.left - cr.left) / cr.width) * 2 - 1, x1: ((r.right - cr.left) / cr.width) * 2 - 1,
          y0: 1 - ((r.bottom - cr.top) / cr.height) * 2, y1: 1 - ((r.top - cr.top) / cr.height) * 2,
        });
      }
    }
    return { camera, obstacles, occluders, building, uiRects };
  };
  const sky = createSkyEvents({
    scene, camera, kit,
    place: placeCtx,
    emit: (detail) => stage.dispatchEvent(new CustomEvent(SFX_EVENT, { bubbles: true, detail })),
  });
  const agents = new Map<string, AgentRuntime>();
  // Kicked agents (prd.md §7.10): their runtimes leave `agents` and walk to the Airlock, then out into space.
  const ejector = createEjector({
    world, kit, M, camera, airlock, spots: createAirlockSpots(),
    smoke: fx.smoke,
    sfx: (detail) => stage.dispatchEvent(new CustomEvent(SFX_EVENT, { bubbles: true, detail })),
    dispose: (obj, rt) => {
      world.remove(obj);
      if (rt) {
        rt.av.el.remove();
        rt.av.chatLabel.element.remove();
      }
      disposeSubtree(obj);
    },
  });
  let simTime = 0;

  /* ---------------- agents ---------------- */
  const dirty = new Set<string>();
  const nav: NavCtx = {
    spots,
    stations: stations.map((s) => s.place),
    boards,
    now: () => simTime,
    log: (id, message) => S().pushLog({ id, level: "move", message }),
    changed: (m) => dirty.add(m.id),
  };

  const disposeSubtree = (root: THREE.Object3D) => {
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mats = m.material ? (Array.isArray(m.material) ? m.material : [m.material]) : [];
      for (const mat of mats) {
        if (sharedMats.has(mat)) continue;
        (mat as THREE.MeshBasicMaterial).map?.dispose();
        mat.dispose();
      }
    });
  };

  /** The store's meeting seat (Agent.meeting) as a place. */
  const seatOf = (m: { room: number; seat: number } | null | undefined): SeatPlace | null =>
    m ? (seats[m.room * SEATS_PER_ROOM + m.seat] ?? null) : null;
  const claimDesk = (id: string, slot: number) => {
    const desk = desks[slot];
    desk.group.visible = true;
    desk.group.traverse((o) => {
      o.userData.agentId = id;
    });
    return desk;
  };

  function addRuntime(id: string) {
    if (agents.has(id)) return;
    const a = S().agents.get(id);
    const seat = a ? seatOf(a.meeting) : null;
    if (!a || (a.slot == null && !seat)) return;
    const desk = a.slot != null ? claimDesk(id, a.slot) : null;
    const av = buildAvatar(kit, M, id, () => toggleFocus(id));
    // A subagent without a desk pops in at its meeting seat (prd.md §7.9); its seat is its home.
    const home = a.slot != null ? slots[a.slot].place : seat!;
    av.root.position.copy(home.final);
    av.root.rotation.y = home.face; // spawned seated: already facing the monitor (desks face PI, deviation 8)
    const rt: AgentRuntime = { id, root: av.root, av, desk, home, mv: newMovement(home), squash: 0, fun: newFun(simTime) };
    if (home.kind === "seat") home.occ = id;
    world.add(av.root);
    av.root.scale.setScalar(0.01);
    av.spawn = 0;
    agents.set(id, rt);
    dirty.add(id);
  }

  /* Runtimes follow the store (prd.md §7.9): an agent shows while it has a desk or a meeting seat, a desk-less
     subagent that gets a desk later takes it, and its home follows its seat. A new member at a table where the
     leader already sits gets a card thrown over. */
  const seatKeys = new Map<string, number>();
  let meetingDirty = true;
  function reconcile(s: HQState) {
    for (const a of s.agents.values()) {
      let rt = agents.get(a.id);
      const seat = seatOf(a.meeting);
      if (!rt) {
        if (a.slot != null || seat) addRuntime(a.id);
        rt = agents.get(a.id);
      } else if (a.slot == null && !seat) {
        removeRuntime(a.id);
        rt = undefined;
      } else if (!rt.desk && a.slot != null) {
        rt.desk = claimDesk(a.id, a.slot);
        rt.home = slots[a.slot].place;
      } else if (!rt.desk && seat && rt.home !== seat) rt.home = seat;
      const prev = seatKeys.get(a.id);
      if (seat && prev !== seat.index) {
        seatKeys.set(a.id, seat.index);
        const room = s.meetings[seat.roomIndex];
        const leader = room?.leaderId && room.leaderId !== a.id ? agents.get(room.leaderId) : undefined;
        if (rt && leader && leader.mv.mode === "desk" && leader.mv.dest.kind === "seat" && leader.mv.dest.roomIndex === seat.roomIndex) {
          flyCard(F4P.cards, leader.mv.dest.final, seat.final, leader.av.color);
        }
      } else if (!seat) seatKeys.delete(a.id);
    }
    meetingDirty = true;
  }

  function removeRuntime(id: string) {
    const rt = agents.get(id);
    if (!rt) return;
    releasePlaces(rt);
    world.remove(rt.root);
    rt.av.el.remove();
    rt.av.chatLabel.element.remove();
    if (rt.fun?.chat) chatSlots.open = Math.max(0, chatSlots.open - 1);
    disposeSubtree(rt.root);
    if (rt.desk) resetDesk(rt.desk);
    seatKeys.delete(id);
    agents.delete(id);
  }

  /** Kicked: free the desk and places like removeRuntime, then hand the avatar to the ejector (no dispose yet). */
  function kickRuntime(id: string) {
    const rt = agents.get(id);
    if (!rt) return;
    releasePlaces(rt);
    if (rt.home.kind === "seat" && rt.home.occ === id) rt.home.occ = null;
    if (rt.fun?.chat) chatSlots.open = Math.max(0, chatSlots.open - 1);
    rt.fun = undefined;
    if (rt.desk) resetDesk(rt.desk);
    rt.desk = null;
    seatKeys.delete(id);
    agents.delete(id);
    ejector.start(rt);
  }

  function updateBubble(rt: AgentRuntime, a: Agent, selectedId: string | null) {
    const st = STATUS[a.status], el = rt.av.el, mv = rt.mv;
    const ic = el.querySelector(".ic") as HTMLElement;
    ic.textContent = st.icon;
    ic.style.background = st.color;
    (el.querySelector(".nm") as HTMLElement).textContent = a.name;
    let txt = "";
    if (mv.mode === "act") txt = (mv.activity && ACT_LABEL[mv.activity]) || "";
    else if (mv.mode === "fetch" || (mv.mode === "walk" && mv.dest.kind === "board")) txt = "ambil tugas";
    else if (mv.mode === "walk" && mv.carrying) txt = mv.dest.kind === "station" ? `bawa tugas ke ${DEPTS[mv.dest.dept].label}!` : mv.dest.kind === "seat" ? `bawa tugas ke ${mv.dest.room}!` : "bawa tugas ke meja!";
    else if (mv.mode === "walk" && mv.urgent) txt = mv.dest.kind === "station" ? `ke ${DEPTS[mv.dest.dept].label}!` : mv.dest.kind === "seat" ? `ke ${mv.dest.room}!` : "buru-buru balik!";
    else if (mv.mode === "walk") txt = "jalan-jalan";
    else if (a.task && (a.id === selectedId || a.status === "waiting" || a.status === "error")) txt = truncate(a.task, 30);
    (el.querySelector(".tt") as HTMLElement).textContent = txt ? "· " + txt : "";
    el.classList.toggle("sel", a.id === selectedId);
    el.classList.toggle("chill", mv.mode === "act");
  }

  /* ---------------- random actions + chat balloons (agents/fun.ts) ---------------- */
  const chatSlots: ChatSlots = { open: 0 };
  /** Meeting rooms where someone waits or errors (no balloons there); refreshed every frame in the meeting block. */
  const roomHush = new Set<number>();
  const funInfo = (rt: AgentRuntime, a: Agent): FunInfo => {
    const mv = rt.mv;
    const pose = mv.mode === "desk" ? "desk" : mv.mode === "act" && mv.dest.kind === "spot" ? mv.dest.pose : mv.mode;
    const atSeat = mv.mode === "desk" && mv.dest.kind === "seat";
    return {
      status: a.status, mode: mv.mode, pose, activity: mv.activity, dept: a.dept, visible: rt.av.label.visible, carrying: mv.carrying,
      meeting: atSeat, hush: atSeat && roomHush.has((mv.dest as SeatPlace).roomIndex),
    };
  };
  function stepFun(rt: AgentRuntime, a: Agent, now: number, dt: number) {
    const f = rt.fun;
    if (!f) return;
    const res = tickFun(f, funInfo(rt, a), now, dt, chatSlots);
    // Sometimes a neighbour on the same tier answers.
    if (res.said && !res.isReply && Math.random() < 0.5) {
      const here = rt.root.position;
      for (const other of agents.values()) {
        if (other === rt || !other.fun || other.fun.chat || other.fun.reply) continue;
        if (Math.abs(other.root.position.y - here.y) > 1.5 || other.root.position.distanceTo(here) > 4) continue;
        other.fun.reply = { text: CHAT_REPLIES[Math.floor(Math.random() * CHAT_REPLIES.length)], at: now + 1.2 + Math.random() };
        break;
      }
    }
    // balloon DOM
    const av = rt.av, chat = f.chat;
    if (chat && av.chatText !== chat.text) {
      av.chatEl.textContent = chat.text;
      av.chatText = chat.text;
    }
    const on = !!chat && av.label.visible;
    if (on !== !!av.chatOn) {
      av.chatEl.classList.toggle("on", on);
      av.chatOn = on;
      if (!on) av.chatOffAt = now + 0.3; // let the fade-out play
    }
    av.chatLabel.visible = av.label.visible && (on || now < (av.chatOffAt ?? 0));
  }

  /* ---------------- area views + camera ---------------- */
  let fly: { p0: THREE.Vector3; t0: THREE.Vector3; p1: THREE.Vector3; t1: THREE.Vector3; k: number } | null = null;
  const flyTo = (pos: THREE.Vector3, target: THREE.Vector3) => {
    fly = { p0: camera.position.clone(), t0: controls.target.clone(), p1: pos.clone(), t1: target.clone(), k: 0 };
    controls.enabled = false;
  };
  /** Area view (deviation 29): every area stays on show; a view only moves the camera and picks the room labels
   *  (all of them in Semua, the area's own otherwise). */
  function applyFloor(f: FloorMode, moveCam: boolean) {
    for (const r of b.roomLabels) r.o.visible = f === "all" || r.zone === f;
    const view = VIEWS[f];
    if (moveCam) flyTo(V(...view.pos), V(...view.target));
  }
  /* Focus mode (deviation 12): clicking an agent (body or bubble) flies the camera to it; clicking the focused agent
     again, or clearing the selection anywhere else, flies back to the camera pose and area view from before the focus. */
  let preFocus: { pos: THREE.Vector3; target: THREE.Vector3; floor: FloorMode } | null = null;
  const toggleFocus = (id: string) => S().select(S().selectedId === id ? null : id, true);
  /* Follow cam (deviation 15): while an agent is in focus, the camera rides along with it (orbit and zoom still
     work around it). In an area view the area switcher follows the agent from area to area (Semua stays Semua). */
  let follow: { id: string; last: THREE.Vector3; zone: ZoneId } | null = null;
  const followZone = (z: ZoneId) => {
    const fm = S().floorMode;
    if (fm !== "all" && fm !== z) S().setFloor(z, false);
  };
  function updateFollow() {
    if (!follow) return;
    const rt = agents.get(follow.id);
    if (!rt || S().selectedId !== follow.id) {
      follow = null;
      return;
    }
    const d = rt.root.position.clone().sub(follow.last);
    follow.last.copy(rt.root.position);
    if (rt.mv.mode !== "walk") d.y = 0; // ignore the hover-chair bob at a desk
    if (d.lengthSq() > 1e-10) {
      if (fly) {
        fly.p1.add(d);
        fly.t1.add(d);
      } else {
        camera.position.add(d);
        controls.target.add(d);
      }
    }
    const z = zoneOf(rt);
    if (z !== follow.zone) {
      follow.zone = z;
      followZone(z);
    }
  }
  function unfocus() {
    follow = null;
    if (!preFocus) return;
    const { pos, target, floor } = preFocus;
    preFocus = null;
    if (S().floorMode !== floor) S().setFloor(floor, false);
    flyTo(pos, target);
  }
  function focus(id: string) {
    const rt = agents.get(id);
    if (!rt) return;
    const z = zoneOf(rt);
    const fm = S().floorMode;
    // Remember where the user was only when entering focus; hopping from agent to agent keeps the first pose.
    if (!preFocus) preFocus = { pos: fly ? fly.p1.clone() : camera.position.clone(), target: fly ? fly.t1.clone() : controls.target.clone(), floor: fm };
    followZone(z);
    const tp = rt.root.position.clone().add(V(window.innerWidth > 820 ? 0.9 : 0, 1.2, 0.4));
    flyTo(tp.clone().add(V(4.6, 4.4, 7.6)), tp);
    follow = { id, last: rt.root.position.clone(), zone: z };
  }

  /* ---------------- store signals ---------------- */
  const onSignal = (s: Signal) => {
    switch (s.type) {
      case "add":
        ejector.cancel(s.id); // back before its launch (prd.md §7.10)
        addRuntime(s.id);
        break;
      case "remove":
        removeRuntime(s.id);
        break;
      case "kick":
        kickRuntime(s.id);
        break;
      case "squash": {
        const rt = agents.get(s.id);
        if (rt) rt.squash = 1;
        break;
      }
      case "confetti": {
        const rt = agents.get(s.id);
        if (rt) fx.confetti(rt.root.position.clone().add(V(0, rt.av.top + 0.3, 0)));
        break;
      }
      case "place": {
        const rt = agents.get(s.id), a = S().agents.get(s.id);
        if (!rt || !a) break;
        const seat = seatOf(a.meeting);
        if (seat) placeAt(nav, rt, seat); // snapshot: meeting members straight to their seats (prd.md §7.9)
        else if (a.status === "idle") {
          const sp = pickSpot(nav, rt);
          if (sp) placeAt(nav, rt, sp);
        } else {
          const w = workTarget(nav, rt, a);
          if (w.kind === "station") placeAt(nav, rt, w);
        }
        break;
      }
      case "alert":
        soc.alertUntil = simTime + 8;
        soc.text = s.text;
        soc.ip = s.ip;
        soc.sev = s.sev;
        soc.spike = 1;
        break;
      case "metric":
        soc.metric = s.value;
        soc.metricAt = simTime;
        break;
      case "finding":
        if (fontsReady) drawReportBoard(fonts, SEC, S());
        break;
      case "reset":
        soc.alertUntil = 0;
        soc.spike = 0;
        soc.series.fill(4);
        if (fontsReady) drawReportBoard(fonts, SEC, S());
        break;
      case "floor":
        // An explicit view/camera choice (area buttons, home) replaces the remembered pre-focus pose, otherwise
        // the unfocus() that follows a select(null) would fly back over it on the next frame.
        if (s.moveCam) {
          preFocus = null;
          follow = null; // an explicit view/camera choice ends the follow cam
        }
        applyFloor(s.floor, s.moveCam);
        break;
      case "focus":
        focus(s.id);
        break;
      case "cron":
        refreshSchedule();
        break;
      case "server":
        refreshServer();
        break;
    }
  };
  const offSignal = S().onSignal(onSignal);
  // Agents that already exist in the store (remount / HMR) get their desk and avatar now.
  for (const id of S().agents.keys()) addRuntime(id);
  applyFloor(S().floorMode, false);

  /* ---------------- picking ---------------- */
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  let downAt: { x: number; y: number } | null = null;
  let hoverT = 0;
  function pickAgent(e: PointerEvent): string | null {
    ndc.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const roots: THREE.Object3D[] = [];
    for (const rt of agents.values()) {
      if (rt.root.visible) roots.push(rt.root);
      if (rt.desk) roots.push(rt.desk.group);
    }
    const hit = ray.intersectObjects(roots, true).find((h) => (h.object as THREE.Mesh).isMesh);
    return (hit?.object.userData.agentId as string) || null;
  }
  /** Schedule board under the pointer (only while a schedule source reports). */
  function pickScheduleBoard(e: PointerEvent): boolean {
    if (!SB.group.visible) return false;
    ndc.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    return ray.intersectObject(SB.group, true).length > 0;
  }
  /** Server room rack, tank or screen under the pointer, only while it shows samples (not decor). */
  function pickServerRoom(e: PointerEvent): boolean {
    if (!serverOn()) return false;
    ndc.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    return ray.intersectObjects(SR.hit, true).some((h) => (h.object as THREE.Mesh).isMesh);
  }
  function pickMeetingScreen(e: PointerEvent): number | null {
    ndc.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(F4P.rooms.map((r) => r.screenMesh), false)[0];
    return hit ? F4P.rooms.findIndex((r) => r.screenMesh === hit.object) : null;
  }
  const onDown = (e: PointerEvent) => {
    downAt = { x: e.clientX, y: e.clientY };
  };
  const onUp = (e: PointerEvent) => {
    if (!downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5) return;
    const meetingRoom = pickMeetingScreen(e);
    if (meetingRoom !== null) { stage.dispatchEvent(new CustomEvent(MEETING_OPEN_EVENT, { detail: meetingRoom, bubbles: true })); return; }
    const id = pickAgent(e);
    if (id) toggleFocus(id);
    else if (pickScheduleBoard(e)) stage.dispatchEvent(new CustomEvent(CRON_BOARD_EVENT, { bubbles: true }));
    else if (pickServerRoom(e)) stage.dispatchEvent(new CustomEvent(SERVER_ROOM_EVENT, { bubbles: true }));
  };
  const onMove = (e: PointerEvent) => {
    if (performance.now() - hoverT < 60) return;
    hoverT = performance.now();
    renderer.domElement.style.cursor = pickMeetingScreen(e) !== null || pickAgent(e) || pickScheduleBoard(e) || pickServerRoom(e) ? "pointer" : "";
  };
  const onResize = () => {
    camera.aspect = vw() / vh();
    camera.updateProjectionMatrix();
    renderer.setSize(vw(), vh());
    labelRenderer.setSize(vw(), vh());
  };
  /* Trackpad pinch zoom (deviation 10). Chromium and Firefox deliver a pinch as wheel events with ctrlKey and a
     small deltaY; three r160 OrbitControls scales zoom by |deltaY| / 100, so pinching barely moves, and while a
     camera fly runs the controls are disabled, so the browser zooms the whole page instead. Safari sends
     gesture* events. Pinch is handled here, proportional to the gesture, and never page-zooms; plain mouse
     wheel and two-finger scroll still go to OrbitControls. */
  const cancelFly = () => {
    if (!fly) return;
    fly = null;
    controls.enabled = true;
  };
  const dollyBy = (factor: number) => {
    const off = camera.position.clone().sub(controls.target);
    const len = THREE.MathUtils.clamp(off.length() * factor, controls.minDistance, controls.maxDistance);
    camera.position.copy(controls.target).add(off.setLength(len));
    controls.update();
  };
  const onWheelCapture = (e: WheelEvent) => {
    cancelFly(); // any wheel gesture takes over from a running camera fly
    if (!e.ctrlKey) return; // mouse wheel / two-finger scroll: OrbitControls
    e.preventDefault();
    e.stopPropagation(); // keep OrbitControls' own (slow) wheel zoom out of it
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY; // lines -> pixels
    dollyBy(Math.exp(THREE.MathUtils.clamp(dy, -50, 50) * 0.01));
  };
  let gestureScale = 1;
  const onGestureStart = (e: Event) => {
    e.preventDefault();
    cancelFly();
    gestureScale = 1;
  };
  const onGestureChange = (e: Event) => {
    e.preventDefault();
    const s = (e as Event & { scale?: number }).scale ?? 1;
    if (s > 0) dollyBy(gestureScale / s);
    gestureScale = s;
  };
  renderer.domElement.addEventListener("pointerdown", onDown);
  renderer.domElement.addEventListener("pointerup", onUp);
  renderer.domElement.addEventListener("pointermove", onMove);
  window.addEventListener("resize", onResize);
  stage.addEventListener("wheel", onWheelCapture, { capture: true, passive: false });
  stage.addEventListener("gesturestart", onGestureStart);
  stage.addEventListener("gesturechange", onGestureChange);

  /* ---------------- fonts ---------------- */
  const drawStatic = () => {
    const s = S();
    drawBoard(fonts, p2.board, s, 0);
    drawReportBoard(fonts, SEC, s);
    SEC.sign.draw();
    props.neon.draw();
    props.sign.draw();
    props.emblem.draw();
    for (const rt of agents.values()) if (rt.desk) rt.desk.plateName = undefined; // redrawn by animateAgent
    const taken = new Set([...agents.values()].map((rt) => rt.desk));
    for (const d of desks) if (!taken.has(d)) drawEmptyDesk(fonts, d);
    drawTaskBoard(fonts, p2.taskBoard.face);
    refreshSchedule();
    refreshServer();
    F4P.sign.draw();
    airlock.sign.draw();
    refreshMeetings();
  };
  loadFonts(fonts).then(() => {
    if (disposed) return;
    fontsReady = true;
    drawStatic();
  });

  /* ---------------- meeting rooms: room screens and talking turns (prd.md §7.9) ---------------- */
  function meetingInfo(ri: number, s: HQState): MeetingScreenInfo | null {
    const r = s.meetings[ri];
    const d = s.discussions.find((d) => d.room === ri);
    if (d && (!r || r.key === "d:" + d.id)) return {
      team: `${DISCUSSION_LABEL[d.phase]} ${d.round}/${d.rounds}`, color: "#ff6fd8", goal: d.goal, since: d.since,
      members: d.participants.map((p) => ({ name: p.name, color: avatarColor(p.agentId), status: s.agents.get(p.agentId)?.status ?? "idle",
        task: d.speaker === p.agentId ? "Giliran bicara" : discussionActive(d.phase) ? "Menunggu giliran" : DISCUSSION_LABEL[d.phase] })),
    };
    if (!r) return null;
    const members = [...s.agents.values()].filter((a) => a.meeting?.room === ri).sort((p, q) => p.meeting!.seat - q.meeting!.seat);
    const leader = r.leaderId ? s.agents.get(r.leaderId) : undefined;
    return {
      team: r.name, color: r.dept ? DEPTS[r.dept].color : "#ff6fd8", goal: (leader ?? members[0])?.task ?? "", since: r.since,
      members: members.map((a) => ({ name: a.name, color: avatarColor(a.id), status: a.status, task: a.task })),
    };
  }
  function refreshMeetings() {
    meetingDirty = false;
    const s = S(), now = Date.now();
    F4P.rooms.forEach((room, ri) => drawMeetingScreen(fontsReady ? fonts : null, room.screen, MEETING_ROOMS[ri], meetingInfo(ri, s), now));
  }
  refreshMeetings();
  /** Per room: every 4-7 s one calm member (working or thinking) talks for 2-3 s; the others look at it. */
  const talk = MEETING_ROOMS.map(() => ({ speaker: null as string | null, until: 0, next: 0 }));
  function stepTalk(ri: number, here: AgentRuntime[], s: HQState, t: number) {
    const tk = talk[ri];
    const manual = s.discussions.find((d) => d.room === ri && discussionActive(d.phase));
    const calm = here.filter((rt) => {
      const st = s.agents.get(rt.id)?.status;
      return st === "working" || st === "thinking";
    });
    if (manual) { tk.speaker = manual.speaker; tk.until = t + 0.2; }
    else if (tk.speaker && (t >= tk.until || !calm.some((rt) => rt.id === tk.speaker))) tk.speaker = null;
    if (!manual && !tk.speaker && t >= tk.next) {
      if (here.length >= 2 && calm.length) {
        tk.speaker = calm[Math.floor(Math.random() * calm.length)].id;
        tk.until = t + 2 + Math.random();
        tk.next = tk.until + 4 + Math.random() * 3;
      } else tk.next = t + 1;
    }
    const spk = tk.speaker ? agents.get(tk.speaker) : undefined;
    for (const rt of here) {
      const mt = (rt.meet ??= { speakUntil: 0, lookAt: null });
      mt.speakUntil = rt === spk ? tk.until : 0;
      mt.lookAt = spk && spk !== rt ? (mt.lookAt ?? new THREE.Vector3()).copy(spk.root.position).setY(spk.root.position.y + spk.av.cy + 0.2) : null;
    }
  }

  /* ---------------- loop ---------------- */
  const clock = new THREE.Clock();
  let screenAcc = 0, slowAcc = 0, wbAcc = 0, secAcc = 0, locAcc = LOC_INTERVAL;
  let raf = 0;
  let lastSel: string | null = null;
  let lastAgents: HQState["agents"] | null = null;
  const lastData = new Map<string, Agent>();
  const anim: AnimCtx = {
    camera,
    selectedId: null,
    nav,
    stations,
    seatChairs: seatProps.map((sp) => sp.chair),
    seatOf: (a) => seatOf(a.meeting),
    coffeeNozzle: props.coffee.nozzle,
    spawnSmoke: fx.smoke,
    drawPlate: (rt, a) => {
      if (fontsReady) drawPlate(fonts, rt, a);
    },
  };

  function loop() {
    raf = requestAnimationFrame(loop);
    const dt = Math.min(clock.getDelta(), 0.05);
    simTime += dt;
    const t = simTime;
    const s = S();
    anim.selectedId = s.selectedId;
    if (s.agents !== lastAgents) {
      lastAgents = s.agents;
      reconcile(s);
    }
    updateFollow();
    if (fly) {
      fly.k = Math.min(1, fly.k + dt / 0.9);
      const e = fly.k < 0.5 ? 4 * fly.k ** 3 : 1 - Math.pow(-2 * fly.k + 2, 3) / 2;
      camera.position.lerpVectors(fly.p0, fly.p1, e);
      controls.target.lerpVectors(fly.t0, fly.t1, e);
      if (fly.k >= 1) {
        fly = null;
        controls.enabled = true;
      }
    }
    controls.update();
    const activeActs = new Set<string>();
    for (const rt of agents.values()) {
      const a = s.agents.get(rt.id);
      if (!a) continue;
      animateAgent(anim, rt, a, t, dt);
      if (rt.mv.mode === "act" && rt.mv.activity) activeActs.add(rt.mv.activity);
      stepFun(rt, a, t, dt);
    }
    // bubbles: on store change, selection change, or movement change
    const selChanged = s.selectedId !== lastSel;
    lastSel = s.selectedId;
    if (selChanged && s.selectedId === null) unfocus();
    for (const rt of agents.values()) {
      const a = s.agents.get(rt.id);
      if (!a) continue;
      if (selChanged || dirty.has(rt.id) || lastData.get(rt.id) !== a) {
        updateBubble(rt, a, s.selectedId);
        lastData.set(rt.id, a);
      }
    }
    dirty.clear();
    for (const id of lastData.keys()) if (!agents.has(id)) lastData.delete(id);

    // furniture reacting
    props.coffee.btn.material.color.set(activeActs.has("coffee") && Math.sin(t * 8) > 0 ? "#ff4f5e" : "#a6e22e");
    props.coffee.cup.visible = activeActs.has("coffee");
    const fOpen = activeActs.has("fridge") ? -1.15 : 0;
    props.fridge.door.rotation.y += (fOpen - props.fridge.door.rotation.y) * Math.min(1, dt * 5);
    props.fridge.light.visible = activeActs.has("fridge");
    const ball = props.ping.ball;
    const player = activeActs.has("pingpong") ? [...agents.values()].find((rt) => rt.mv.activity === "pingpong" && rt.mv.mode === "act") : undefined;
    if (player) {
      const p = (t * 0.8 + player.av.lookPh) % 1, sw = p < 0.5 ? p / 0.5 : (1 - p) / 0.5;
      ball.position.set(8.35 + sw * 1.95, 1.0 + 0.42 * Math.abs(Math.sin(sw * Math.PI * 2)), -5.45);
    } else ball.position.set(9.7, 0.99, -4.6);
    screenAcc += dt;
    if (screenAcc > 0.12) {
      screenAcc = 0;
      if (fontsReady) {
        for (const rt of agents.values()) {
          const a = s.agents.get(rt.id);
          if (a) drawScreen(fonts, rt, a, t);
        }
        drawTV(fonts, props.tv, t, activeActs.has("tv"));
        drawArcade(fonts, props.arcade, t, activeActs.has("arcade"));
      }
    }
    wbAcc += dt;
    if (wbAcc > 0.09) {
      wbAcc = 0;
      drawWhiteboard(p2.wb, activeActs.has("whiteboard"), fontsReady ? fonts : null);
    }
    // ---- team stations (Security, DevOps) ----
    const occ = new Map<number, Agent>();
    let redOn = false, repOn = false, blueOn = false;
    for (const rt of agents.values()) {
      const mv = rt.mv;
      const a = s.agents.get(rt.id);
      if (a && mv.mode === "desk" && mv.dest.kind === "station") {
        occ.set(mv.dest.index, a);
        if (a.status === "working" || a.status === "thinking") {
          if (mv.dest.dept === "red") redOn = true;
          if (mv.dest.dept === "report") repOn = true;
          if (mv.dest.dept === "blue") blueOn = true;
        }
      }
    }
    stations.forEach((st, i) => {
      const a = occ.get(i);
      const c = a ? STATUS[a.status].color : "#3a3360";
      st.ring.material.color.set(c);
      st.strip.material.color.set(c);
      st.glow.material.opacity = a ? 0.25 + 0.15 * Math.sin(t * 3) : 0;
      if (!a) st.chair.position.y = 0;
    });
    secAcc += dt;
    if (secAcc > 0.15) {
      secAcc = 0;
      if (fontsReady) {
        drawRedWall(fonts, SEC, s, t, redOn);
        drawSOC(fonts, SEC, s, soc, simTime, t, blueOn);
        stations.forEach((st, i) => drawStation(fonts, st, occ.get(i), s, soc, simTime, t));
      }
    }
    // ---- meeting rooms (prd.md §7.9): seat colors, room strips, talking turns, flying cards ----
    const seated = new Map<number, Agent>();
    const byRoom: AgentRuntime[][] = MEETING_ROOMS.map(() => []);
    for (const rt of agents.values()) {
      const a = s.agents.get(rt.id), d = rt.mv.dest;
      if (a && rt.mv.mode === "desk" && d.kind === "seat") {
        seated.set(d.index, a);
        byRoom[d.roomIndex].push(rt);
      } else rt.meet = undefined;
    }
    roomHush.clear();
    F4P.rooms.forEach((room, ri) => {
      const info = s.meetings[ri];
      room.strip.material.color.set(info ? (info.dept ? DEPTS[info.dept].color : "#ff6fd8") : MEETING_IDLE);
      for (const sp of room.seats) {
        const a = seated.get(sp.place.index);
        const c = a ? STATUS[a.status].color : MEETING_IDLE;
        sp.ring.material.color.set(a?.status === "offline" ? "#4a4560" : c);
        sp.glow.material.color.set(c);
        sp.glow.material.opacity = a && a.status !== "offline" ? 0.25 + 0.15 * Math.sin(t * 3) : 0;
        sp.screen.material.color.set(!a || a.status === "offline" ? "#150e2c" : c).multiplyScalar(0.75);
        if (!a) sp.chair.position.y = T2;
      }
      const here = byRoom[ri];
      if (s.discussions.some((d) => d.room === ri && discussionActive(d.phase))) roomHush.add(ri); // manual chat is real; suppress random dialogue
      if (here.some((rt) => ["waiting", "error"].includes(s.agents.get(rt.id)?.status ?? ""))) roomHush.add(ri);
      stepTalk(ri, here, s, t);
    });
    stepCards(F4P.cards, dt);
    ejector.update(dt, t);
    stepDoors(F4P.rooms, [...agents.values()].map((rt) => rt.root.position), dt);
    if (meetingDirty) refreshMeetings();
    const H = SEC.holo;
    H.model.rotation.y += dt * (redOn ? 0.9 : 0.25);
    H.scan.visible = redOn;
    if (redOn) H.scan.position.y = 1.1 + 0.55 * (1 + Math.sin(t * 2.2));
    H.disc.material.color.set(redOn ? (Math.sin(t * 6) > 0 ? "#ff4f5e" : "#59c3ff") : "#59c3ff");
    const P3 = SEC.printer;
    if (repOn) {
      P3.n = (P3.n + dt * 0.45) % 1;
      const k = P3.n;
      P3.paper.visible = true;
      P3.paper.position.set(0, 0.95 - Math.max(0, k - 0.7) * 0.4, 0.05 + Math.min(k, 0.7) * 0.8);
      if (k > 0.97) P3.stack.scale.y = Math.min(3, P3.stack.scale.y + 0.05);
    } else P3.paper.visible = false;
    const alertOn = simTime < soc.alertUntil;
    SEC.siren.beams.visible = alertOn;
    SEC.siren.beams.rotation.y += dt * 6;
    SEC.siren.dome.material.color.set(alertOn ? (Math.sin(t * 12) > 0 ? "#ff2a3a" : "#ffb3bb") : "#7a2030");
    SEC.siren.light.intensity = alertOn ? 1.3 + Math.sin(t * 12) * 0.9 : 0;
    slowAcc += dt;
    if (slowAcc > 1) {
      slowAcc = 0;
      const base = 2 + Math.random() * 6;
      soc.spike *= 0.82;
      soc.series.push(simTime - soc.metricAt < 6 ? (soc.metric ?? 0) : base + soc.spike * (60 + Math.random() * 50));
      soc.series.shift();
      if (fontsReady) {
        let chilling = 0;
        for (const rt of agents.values()) if (rt.mv.mode === "act") chilling++;
        drawBoard(fonts, p2.board, s, chilling);
      }
      for (const rt of agents.values()) {
        const a = s.agents.get(rt.id);
        if (a) updateBubble(rt, a, s.selectedId);
      }
      if (SB.group.visible) refreshSchedule(); // countdowns, like the mission board every 1 s
      refreshMeetings(); // tasks and "rapat N mnt"
      if (SR.screen.group.visible) refreshServer(); // "TERPUTUS" once samples stop
    }
    // schedule bell: short rings while a job runs, then settles
    SB.bell.rotation.z = bellOn && t % 2.4 < 0.9 ? Math.sin(t * 24) * 0.42 : SB.bell.rotation.z * 0.85;
    locAcc += dt;
    if (locAcc >= LOC_INTERVAL) {
      locAcc = 0;
      const locs = new Map<string, { where: string; what: string }>();
      for (const rt of agents.values()) locs.set(rt.id, locText(rt, s.agents.get(rt.id)?.meeting?.team));
      if (locs.size) S().setLocs(locs);
    }
    // task board cards: pinned while their agent is on the way, gone once picked up (deviation 14)
    for (const [i, slot] of boards.entries()) {
      const card = p2.taskBoard.cards[i];
      const rt = slot.occ ? agents.get(slot.occ) : undefined;
      const show = !!rt && rt.mv.fetching && !rt.mv.carrying;
      if (show && !card.g.visible) {
        card.paper.material.color.set(rt!.av.color);
        card.pop = 0;
      }
      card.g.visible = show;
      if (show && card.pop < 1) {
        card.pop = Math.min(1, card.pop + dt * 4);
        card.g.scale.setScalar(Math.max(0.01, 1 + 2.4 * Math.pow(card.pop - 1, 3) + 1.4 * Math.pow(card.pop - 1, 2)));
      }
    }
    // server room: live racks and tank while the bridge sends samples (front row: CPU rack, RAM rack; tank: disk);
    // the other racks always blink as decor. The beacon over the door shows the worst level, the fans spin with CPU.
    const sv = serverOn();
    let liquidH = 2.0, liquidColor = "#ff6fd8"; // decor liquid
    const decor = (bl: (typeof SR.blinkers)[number]) => bl.m.material.color.set(Math.sin(t * bl.rate + bl.ph) > 0.2 ? bl.color : "#2a2350");
    let beacon = "#3a4a6b", fanSpeed = 5;
    if (sv) {
      const stale = serverStale(sv, Date.now());
      const vals = [sv.cpu, memPct(sv)];
      for (const bl of SR.blinkers) {
        if (bl.rack < 0) { decor(bl); continue; }
        const p = vals[bl.rack];
        let c = "#2a2350";
        if (p != null && bl.row < litRows(p)) {
          const speed = bl.rack === 0 ? 0.5 + 2.5 * p : 0.5; // the CPU rack blinks faster the busier it is
          c = stale ? OFFLINE_COLOR : Math.sin(t * bl.rate * speed + bl.ph) > -0.6 ? LEVEL_COLOR[levelOf(p)] : "#2a2350";
        }
        bl.m.material.color.set(c);
      }
      const dp = diskPct(sv);
      if (dp != null) {
        liquidH = LIQUID_FULL * Math.max(0.03, dp);
        liquidColor = stale ? OFFLINE_COLOR : dp >= 0.9 ? LEVEL_COLOR.hot : "#ff6fd8";
      }
      const worst = Math.max(0, ...[sv.cpu, memPct(sv), dp].filter((x): x is number => x != null));
      beacon = stale ? OFFLINE_COLOR : LEVEL_COLOR[levelOf(worst)];
      fanSpeed = stale ? 2 : 5 + 14 * (sv.cpu ?? 0);
    } else for (const bl of SR.blinkers) decor(bl);
    SR.beacon.material.color.set(beacon).multiplyScalar(sv && Math.sin(t * 3) < -0.3 ? 0.7 : 1);
    for (const f of SR.fans) f.rotation.z -= dt * fanSpeed;
    stepServerDoor(SR.door, [...agents.values()].map((rt) => rt.root.position), dt);
    const lk = `${liquidH.toFixed(3)}|${liquidColor}`;
    if (lk !== liquidKey) {
      liquidKey = lk;
      SR.liquid.scale.y = liquidH / 2.0;
      SR.liquid.position.y = LIQUID_BASE + liquidH / 2;
      SR.liquid.material.color.set(liquidColor);
    }
    const bubbleTop = sv ? LIQUID_BASE + liquidH - 0.08 : 2.55; // bubbles stay inside the liquid
    for (const bb of SR.tankBubbles) {
      bb.visible = bubbleTop > 0.85;
      bb.position.y += bb.userData.sp * dt;
      bb.position.x = bb.userData.x + Math.sin(t * 3 + bb.userData.ph) * 0.05;
      if (bb.position.y > bubbleTop) bb.position.y = 0.75;
    }
    for (const p of tentacles) {
      p.rotation.z = Math.sin(t * 1.3 + p.userData.ph) * 0.18;
      p.rotation.x = Math.cos(t * 1.1 + p.userData.ph) * 0.12;
    }
    for (const r of skyAnim) {
      r.position.y = r.userData.base + Math.sin(t * 0.5 + r.userData.ph) * 0.6;
      r.rotation.y += dt * 0.1;
      r.rotation.x += dt * 0.05;
    }
    const now = new Date();
    const sec = now.getSeconds() + now.getMilliseconds() / 1000, mm = now.getMinutes() + sec / 60, hh = (now.getHours() % 12) + mm / 60;
    p2.clockHands.s.rotation.z = (-sec / 60) * Math.PI * 2;
    p2.clockHands.m.rotation.z = (-mm / 60) * Math.PI * 2;
    p2.clockHands.h.rotation.z = (-hh / 12) * Math.PI * 2;
    world.position.y = Math.sin(t * 0.6) * 0.08;
    fx.update(dt);
    sky.update(dt);
    // One floor, one pass (deviation 29): the per-floor shadow passes of deviation 6 are not needed without slabs.
    effect.render(scene, camera);
    labelRenderer.render(scene, camera);
  }
  raf = requestAnimationFrame(loop);

  /* ---------------- API ---------------- */
  const placeById = (rtId: string, placeId: string): Place | null => {
    const rt = agents.get(rtId);
    if (!rt) return null;
    if (placeId === "desk") return rt.home;
    const bm = /^board:(\d+)$/.exec(placeId);
    if (bm) return boards[Number(bm[1])] ?? null;
    const m = /^station:(\d+)$/.exec(placeId);
    if (m) return stations[Number(m[1])]?.place ?? null;
    const sm = /^seat:(\d+)$/.exec(placeId);
    if (sm) return seats[Number(sm[1])] ?? null;
    return spots.find((sp) => sp.id === placeId) ?? null;
  };

  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(raf);
    offSignal();
    renderer.domElement.removeEventListener("pointerdown", onDown);
    renderer.domElement.removeEventListener("pointerup", onUp);
    renderer.domElement.removeEventListener("pointermove", onMove);
    window.removeEventListener("resize", onResize);
    stage.removeEventListener("wheel", onWheelCapture, { capture: true });
    stage.removeEventListener("gesturestart", onGestureStart);
    stage.removeEventListener("gesturechange", onGestureChange);
    controls.dispose();
    sky.dispose();
    const geos = new Set<THREE.BufferGeometry>(), mats = new Set<THREE.Material>(), texs = new Set<THREE.Texture>();
    scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) geos.add(m.geometry);
      const ms = m.material ? (Array.isArray(m.material) ? m.material : [m.material]) : [];
      for (const mat of ms) mats.add(mat);
    });
    for (const mat of [...mats, ...sharedMats]) {
      const mm = mat as THREE.MeshToonMaterial;
      if (mm.map) texs.add(mm.map);
      mats.add(mat);
    }
    for (const g of geos) g.dispose();
    for (const mat of mats) mat.dispose();
    for (const tx of [...texs, ...b.looseTextures, skyTex, kit.gradientMap]) tx.dispose();
    for (const rt of agents.values()) {
      rt.av.el.remove();
      rt.av.chatLabel.element.remove();
    }
    for (const r of b.roomLabels) r.o.element.remove();
    agents.clear();
    labelsEl.replaceChildren();
    scene.clear();
    renderer.dispose();
    renderer.forceContextLoss();
    renderer.domElement.remove();
  }

  return {
    setFloor: (floor) => S().setFloor(floor),
    select: (id, focusCam = false) => S().select(id, focusCam),
    placeAt: (id, placeId) => {
      const rt = agents.get(id), pl = placeById(id, placeId);
      if (!rt || !pl) return false;
      placeAt(nav, rt, pl);
      return true;
    },
    placeIds: () => ["desk", ...spots.map((sp) => sp.id), ...stations.map((_, i) => `station:${i}`), ...boards.map((_, i) => `board:${i}`), ...seats.map((_, i) => `seat:${i}`)],
    skyEvent: (kind, zone) => sky.trigger(kind, zone),
    camera,
    controls,
    dispose,
    debug: {
      hideEmptyDesks: (hidden) => {
        emptyDesksHidden = hidden;
        const taken = new Set([...agents.values()].map((rt) => rt.desk));
        for (const d of desks) if (!taken.has(d)) d.group.visible = !hidden;
      },
      hideTaskBoard: (hidden) => {
        p2.taskBoard.group.visible = !hidden;
      },
      hideScheduleBoard: (hidden) => {
        scheduleHidden = hidden;
        refreshSchedule();
      },
      hideServerMonitor: (hidden) => {
        serverHidden = hidden;
        refreshServer();
      },
      ejects: () => ejector.state(),
      whiteboardEgg: () => {
        if (p2.wb.wasOn) p2.wb.egg = newWhiteboardEgg(0);
        else p2.wb.forceEgg = true;
      },
      say: (id, text) => {
        const rt = agents.get(id), a = S().agents.get(id);
        if (!rt?.fun || !a) return false;
        say(rt.fun, text ?? chatLine(funInfo(rt, a)), simTime, chatSlots);
        return true;
      },
      quirk: (id, kind) => {
        const rt = agents.get(id), a = S().agents.get(id);
        if (!rt?.fun || !a) return false;
        const allowed = allowedQuirks(funInfo(rt, a));
        const k = kind ?? allowed[Math.floor(Math.random() * allowed.length)];
        if (!k) return false;
        startQuirk(rt.fun, k);
        return true;
      },
      skyZones: (kind, n = 30) => {
        const out: Record<string, number> = {};
        for (let i = 0; i < n; i++) {
          const z = (kind === "portal" ? planPortal(placeCtx()) : planMeteors(placeCtx()))?.zone ?? "none";
          out[z] = (out[z] ?? 0) + 1;
        }
        return out;
      },
    },
  };
}

