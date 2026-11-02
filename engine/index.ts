// Agent HQ 3D engine: framework-free Three.js, ported from references/agent-hq.html (prd.md §14).
// createEngine() builds one office in `stage`, reads the zustand store, and cleans up fully on dispose().

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import { OutlineEffect } from "three/addons/effects/OutlineEffect.js";
import { STATUS } from "@/lib/events";
import type { Agent, FloorMode, HQStore, Signal } from "@/lib/store";
import { DEPTS } from "@/lib/teams";
import { truncate } from "@/lib/format";
import { ACT_LABEL, INK, VIEWS } from "./constants";
import { animateAgent, type AgentRuntime, type AnimCtx } from "./agents/animate";
import { buildAvatar } from "./agents/avatar";
import { floorOf, locText, newMovement, pickSpot, placeAt, releasePlaces, workTarget, type NavCtx } from "./agents/movement";
import { drawArcade, drawBoard, drawPlate, drawScreen, drawTV, drawWhiteboard } from "./displays/office";
import { drawRedWall, drawReportBoard, drawSOC, drawStation, newSocAnim } from "./displays/security";
import { createFx } from "./fx";
import { createDeskSlots, createSpots, type Place } from "./nav/places";
import { loadFonts, resolveFonts } from "./scene/fonts";
import { createKit, createMaterials, V } from "./scene/kit";
import { buildSky, makeSkyTexture } from "./scene/sky";
import { buildDesk } from "./world/props/desk";
import { buildIslandAndFloor1Shell, buildFloor1Props } from "./world/floor1";
import { buildFloor2Props, buildFloor2Shell } from "./world/floor2";
import { buildFloor3 } from "./world/floor3";
import type { Build } from "./world/structure";

export interface Engine {
  setFloor: (floor: FloorMode) => void;
  select: (id: string | null, focus?: boolean) => void;
  /** Debug/test: teleport agent `id` to a place ("desk", a spot id like "coffee", or "station:N"). */
  placeAt: (id: string, placeId: string) => boolean;
  placeIds: () => string[];
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  /** Idempotent. */
  dispose: () => void;
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
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -22, right: 22, top: 22, bottom: -22, near: 1, far: 120 });
  sun.shadow.bias = -0.0008;
  scene.add(sun);
  const rim = new THREE.DirectionalLight("#ff8fd8", 0.7);
  rim.position.set(-14, 8, -10);
  scene.add(rim);

  /* ---------------- world ---------------- */
  const world = new THREE.Group(); scene.add(world);
  const g1 = new THREE.Group(); world.add(g1); // floor 1
  const g2 = new THREE.Group(); world.add(g2); // floor 2 (hideable)
  const g3 = new THREE.Group(); world.add(g3); // floor 3 security
  const b: Build = { kit, M, roomLabels: [], looseTextures: [] };
  buildIslandAndFloor1Shell(b, world, g1);
  buildFloor2Shell(b, g1, g2);
  const skyAnim = buildSky(kit, scene);
  const tentacles: THREE.Group[] = [];
  const props = buildFloor1Props(b, g1, tentacles, fonts);
  const p2 = buildFloor2Props(b, g2, tentacles);
  const SEC = buildFloor3(b, g2, g3, tentacles, fonts);
  const stations = SEC.stations;
  const spots = createSpots();
  const slots = createDeskSlots();
  const soc = newSocAnim();
  const fx = createFx(kit, world);
  const agents = new Map<string, AgentRuntime>();
  let simTime = 0;

  /* ---------------- agents ---------------- */
  const dirty = new Set<string>();
  const nav: NavCtx = {
    spots,
    stations: stations.map((s) => s.place),
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

  function addRuntime(id: string) {
    if (agents.has(id)) return;
    const a = S().agents.get(id);
    if (!a || a.slot == null) return;
    const slot = slots[a.slot];
    const desk = buildDesk(b, g2, slot);
    const av = buildAvatar(kit, M, id, () => S().select(id, true));
    const home = slot.place;
    av.root.position.copy(home.final);
    const rt: AgentRuntime = { id, root: av.root, av, desk, home, mv: newMovement(home), squash: 0 };
    world.add(av.root);
    av.root.scale.setScalar(0.01);
    av.spawn = 0;
    desk.group.traverse((o) => {
      o.userData.agentId = id;
    });
    agents.set(id, rt);
    dirty.add(id);
  }

  function removeRuntime(id: string) {
    const rt = agents.get(id);
    if (!rt) return;
    releasePlaces(rt);
    world.remove(rt.root);
    rt.av.el.remove();
    g2.remove(rt.desk.group);
    disposeSubtree(rt.root);
    disposeSubtree(rt.desk.group);
    agents.delete(id);
  }

  function updateBubble(rt: AgentRuntime, a: Agent, selectedId: string | null) {
    const st = STATUS[a.status], el = rt.av.el, mv = rt.mv;
    const ic = el.querySelector(".ic") as HTMLElement;
    ic.textContent = st.icon;
    ic.style.background = st.color;
    (el.querySelector(".nm") as HTMLElement).textContent = a.name;
    let txt = "";
    if (mv.mode === "act") txt = (mv.activity && ACT_LABEL[mv.activity]) || "";
    else if (mv.mode === "walk" && mv.urgent) txt = mv.dest.kind === "station" ? `ke ${DEPTS[mv.dest.dept].label}!` : "buru-buru balik!";
    else if (mv.mode === "walk") txt = "jalan-jalan";
    else if (a.task && (a.id === selectedId || a.status === "waiting" || a.status === "error")) txt = truncate(a.task, 30);
    (el.querySelector(".tt") as HTMLElement).textContent = txt ? "· " + txt : "";
    el.classList.toggle("sel", a.id === selectedId);
    el.classList.toggle("chill", mv.mode === "act");
  }

  /* ---------------- floors + camera ---------------- */
  let fly: { p0: THREE.Vector3; t0: THREE.Vector3; p1: THREE.Vector3; t1: THREE.Vector3; k: number } | null = null;
  const flyTo = (pos: THREE.Vector3, target: THREE.Vector3) => {
    fly = { p0: camera.position.clone(), t0: controls.target.clone(), p1: pos.clone(), t1: target.clone(), k: 0 };
    controls.enabled = false;
  };
  function applyFloor(f: FloorMode, moveCam: boolean) {
    g2.visible = f !== "1";
    g3.visible = f === "all" || f === "3";
    const lf = f === "all" ? 3 : Number(f);
    for (const r of b.roomLabels) r.o.visible = r.floor === lf;
    if (moveCam) flyTo(V(...VIEWS[f].pos), V(...VIEWS[f].target));
  }
  function focus(id: string) {
    const rt = agents.get(id);
    if (!rt) return;
    const fl = floorOf(rt);
    const fm = S().floorMode;
    const want: FloorMode = fl === 3 ? (fm === "all" ? "all" : "3") : (String(fl) as FloorMode);
    if (want !== fm) S().setFloor(want, false);
    const tp = rt.root.position.clone().add(V(window.innerWidth > 820 ? 0.9 : 0, 1.2, 0.4));
    flyTo(tp.clone().add(V(4.6, 4.4, 7.6)), tp);
  }

  /* ---------------- store signals ---------------- */
  const onSignal = (s: Signal) => {
    switch (s.type) {
      case "add":
        addRuntime(s.id);
        break;
      case "remove":
        removeRuntime(s.id);
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
        if (a.status === "idle") {
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
        applyFloor(s.floor, s.moveCam);
        break;
      case "focus":
        focus(s.id);
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
      if (g2.visible && !g3.visible) roots.push(rt.desk.group);
    }
    const hit = ray.intersectObjects(roots, true).find((h) => (h.object as THREE.Mesh).isMesh);
    return (hit?.object.userData.agentId as string) || null;
  }
  const onDown = (e: PointerEvent) => {
    downAt = { x: e.clientX, y: e.clientY };
  };
  const onUp = (e: PointerEvent) => {
    if (!downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5) return;
    const id = pickAgent(e);
    if (id) S().select(id, true);
  };
  const onMove = (e: PointerEvent) => {
    if (performance.now() - hoverT < 60) return;
    hoverT = performance.now();
    renderer.domElement.style.cursor = pickAgent(e) ? "pointer" : "";
  };
  const onResize = () => {
    camera.aspect = vw() / vh();
    camera.updateProjectionMatrix();
    renderer.setSize(vw(), vh());
    labelRenderer.setSize(vw(), vh());
  };
  renderer.domElement.addEventListener("pointerdown", onDown);
  renderer.domElement.addEventListener("pointerup", onUp);
  renderer.domElement.addEventListener("pointermove", onMove);
  window.addEventListener("resize", onResize);

  /* ---------------- fonts ---------------- */
  const drawStatic = () => {
    const s = S();
    drawBoard(fonts, p2.board, s, 0);
    drawReportBoard(fonts, SEC, s);
    SEC.sign.draw();
    props.neon.draw();
    props.sign.draw();
    for (const rt of agents.values()) rt.desk.plateName = undefined; // redrawn by animateAgent
  };
  loadFonts(fonts).then(() => {
    if (disposed) return;
    fontsReady = true;
    drawStatic();
  });

  /* ---------------- loop ---------------- */
  const clock = new THREE.Clock();
  let screenAcc = 0, slowAcc = 0, wbAcc = 0, secAcc = 0, locAcc = LOC_INTERVAL;
  let raf = 0;
  let lastSel: string | null = null;
  const lastData = new Map<string, Agent>();
  const anim: AnimCtx = {
    camera,
    selectedId: null,
    floorMode: S().floorMode,
    nav,
    stations,
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
    anim.floorMode = s.floorMode;
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
    }
    // bubbles: on store change, selection change, or movement change
    const selChanged = s.selectedId !== lastSel;
    lastSel = s.selectedId;
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
      drawWhiteboard(p2.wb, activeActs.has("whiteboard"));
    }
    // ---- floor 3 ----
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
      if (g3.visible && fontsReady) {
        drawRedWall(fonts, SEC, s, t, redOn);
        drawSOC(fonts, SEC, s, soc, simTime, t, blueOn);
        stations.forEach((st, i) => drawStation(fonts, st, occ.get(i), s, soc, simTime, t));
      }
    }
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
    SEC.pad.material.color.set(Math.sin(t * 2) > 0 ? "#ff6fd8" : "#c3a6ff");
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
    }
    locAcc += dt;
    if (locAcc >= LOC_INTERVAL) {
      locAcc = 0;
      const locs = new Map<string, { where: string; what: string }>();
      for (const rt of agents.values()) locs.set(rt.id, locText(rt));
      if (locs.size) S().setLocs(locs);
    }
    for (const bl of p2.blinkers) bl.m.material.color.set(Math.sin(t * bl.rate + bl.ph) > 0.2 ? bl.color : "#2a2350");
    for (const bb of p2.tankBubbles) {
      bb.position.y += bb.userData.sp * dt;
      bb.position.x = bb.userData.x + Math.sin(t * 3 + bb.userData.ph) * 0.05;
      if (bb.position.y > 2.55) bb.position.y = 0.75;
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
    effect.render(scene, camera);
    labelRenderer.render(scene, camera);
  }
  raf = requestAnimationFrame(loop);

  /* ---------------- API ---------------- */
  const placeById = (rtId: string, placeId: string): Place | null => {
    const rt = agents.get(rtId);
    if (!rt) return null;
    if (placeId === "desk") return rt.home;
    const m = /^station:(\d+)$/.exec(placeId);
    if (m) return stations[Number(m[1])]?.place ?? null;
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
    controls.dispose();
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
    for (const rt of agents.values()) rt.av.el.remove();
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
    placeIds: () => ["desk", ...spots.map((sp) => sp.id), ...stations.map((_, i) => `station:${i}`)],
    camera,
    controls,
    dispose,
  };
}

