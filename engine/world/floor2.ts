// Floor 2 "Kantor": slab, stairs from floor 1, walls, server room, window hall, mission board, clock,
// meeting room, reading corner. Ported 1:1 from references/agent-hq.html. Desks are built per agent.

import * as THREE from "three";
import { F2, INK } from "../constants";
import { boxAt, canvasTex, cyl, mesh, noLine, pick, rbox, shade, thin, V, type CanvasTex } from "../scene/kit";
import type { WhiteboardEgg } from "../displays/office";
import { BOARD_SLOTS_Z } from "../nav/places";
import { SERVER_SCREEN_H, SERVER_SCREEN_W } from "../displays/server";
import { alienPlant } from "./props/alienPlant";
import { floorPlane, makeWall, partition, plankTexture, rail, roomLabel, type Build } from "./structure";

export function buildFloor2Shell(b: Build, g1: THREE.Group, g2: THREE.Group) {
  const { M } = b;
  // slab + plank floor
  boxAt(g2, 22.6, 0.4, 16.4, -1.7, 5.2, 0.2, M.slab, 0.08, false);
  boxAt(g2, 3.4, 0.4, 7.5, 11.3, 5.2, -4.25, M.slab, 0.08, false);
  const tex = plankTexture();
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  b.looseTextures.push(tex);
  const ta = tex.clone(); ta.repeat.set(4, 3); ta.needsUpdate = true;
  floorPlane(b, g2, -12.6, 9.6, -7.6, 8.4, F2 - 0.0, ta);
  const tb = tex.clone(); tb.repeat.set(0.7, 1.4); tb.needsUpdate = true;
  floorPlane(b, g2, 9.6, 13.0, -7.6, -0.5, F2 - 0.0, tb);

  // stairs floor 1 -> floor 2
  const stairsG = new THREE.Group(); g1.add(stairsG);
  for (let i = 0; i < 14; i++) {
    const top = (i + 1) * 0.4, z1 = 6.5 - i * 0.5, z0 = z1 - 0.5;
    boxAt(stairsG, 2.6, top, 0.5, 11.25, 0, (z0 + z1) / 2, i % 2 ? M.wood : M.woodD, 0.03);
  }
  const stairY = (z: number) => Math.max(0, Math.min(5.6, 0.8 * (6.5 - z) + 0.4));
  for (let z = 6.2; z > -0.4; z -= 1.1) rail(b, stairsG, V(10.1, stairY(z), z), V(10.1, stairY(z) + 1.15, z), 0.05);
  rail(b, stairsG, V(10.1, stairY(6.6) + 1.15, 6.6), V(10.1, 5.6 + 1.15, -0.3), 0.07, M.red);
  for (let z = -0.4; z < 8.4; z += 1.2) rail(b, g2, V(9.5, F2, z), V(9.5, F2 + 1.1, z), 0.05);
  rail(b, g2, V(9.5, F2 + 1.1, -0.4), V(9.5, F2 + 1.1, 8.0), 0.07, M.red);

  // walls
  makeWall(b, g2, "x", -7.8, -13, 13, F2, 5.2, [
    { a0: -8, a1: -3, y0: F2 + 1.3, y1: F2 + 3.5 },
    { a0: 10.0, a1: 12.6, y0: F2 + 0.8, y1: F2 + 3.6 },
  ], M.wall2);
  makeWall(b, g2, "z", -12.8, -8, 8.4, F2, 5.2, [], M.wall2);
  boxAt(g2, 26, 0.25, 0.48, 0, F2, -7.8, M.dark, 0.04);
  boxAt(g2, 0.48, 0.25, 16, -12.8, F2, 0.2, M.dark, 0.04);
  partition(b, g2, "z", 5, -7.6, -2.6, F2);
  partition(b, g2, "z", 9.4, -7.6, -2.6, F2);
  partition(b, g2, "x", -2.6, 5, 6.3, F2);
  partition(b, g2, "x", -2.6, 7.9, 9.4, F2);
  partition(b, g2, "x", 4.4, -12.6, -10.8, F2);
  partition(b, g2, "z", -5.4, 5.2, 8.4, F2);
}

export interface Blinker {
  m: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  rate: number;
  ph: number;
  color: string;
  /** Server room rack (0 = left, CPU; 1 = right, RAM) and LED row from the bottom (0..5), for the server monitor. */
  rack: number;
  row: number;
}

/** Server monitor (prd.md §7.8): the racks' LEDs are `blinkers`; these are the extra parts. Not in the prototype. */
export interface ServerRoom {
  /** Tank liquid: its height shows disk usage. */
  liquid: THREE.Mesh<THREE.BufferGeometry, THREE.MeshToonMaterial>;
  /** Wall screen above the racks, hidden until the bridge sends a sample. */
  screen: { group: THREE.Group; face: CanvasTex };
  /** Racks, tank and screen: a click on one of them opens the Server panel. */
  hit: THREE.Object3D[];
}

/** Back wall of the server room, above both racks. [x, y above F2, z] of the screen's center. */
export const SERVER_SCREEN_AT: [number, number, number] = [6.6, 4.05, -7.6];
export const SERVER_SCREEN_SIZE: [number, number] = [2.5, 1.4];
/** Liquid height at 100% disk (decor: 2.0). Bottom at 0.62 above the floor, like the decor liquid. */
export const LIQUID_FULL = 2.4;
export const LIQUID_BASE = 0.62;

export interface Floor2Props {
  blinkers: Blinker[];
  tankBubbles: THREE.Mesh[];
  board: CanvasTex;
  clockHands: { h: THREE.Group; m: THREE.Group; s: THREE.Group };
  wb: CanvasTex & { strokes: number; cx: number; cy: number; wasOn?: boolean; forceEgg?: boolean; egg?: WhiteboardEgg | null; keepOut?: [number, number, number, number] | null };
  taskBoard: TaskBoard;
  scheduleBoard: ScheduleBoard;
  server: ServerRoom;
}

/** Schedule board (Hermes cron, docs/hermes.md "Jadwal"): hidden until a schedule source reports. Not in the prototype. */
export interface ScheduleBoard {
  group: THREE.Group;
  face: CanvasTex;
  /** Swings while a job runs. */
  bell: THREE.Group;
}

/** Back wall, right of the clock (up to the server room). [x, y above F2, z] of the board's center. */
export const SCHEDULE_BOARD_AT: [number, number, number] = [3.3, 2.3, -7.6];
export const SCHEDULE_BOARD_SIZE: [number, number] = [2.75, 1.72];

/** Cork task board (deviation 14): a header and one card spot per standing spot (BOARD_SLOTS_Z). */
export interface TaskBoard {
  group: THREE.Group;
  /** Cork face with the "PAPAN TUGAS" header, drawn once fonts are ready. */
  face: CanvasTex;
  /** Card pinned for agent `occ` while it is on its way; hidden once picked up. */
  cards: { g: THREE.Group; paper: THREE.Mesh<THREE.BufferGeometry, THREE.MeshToonMaterial>; pop: number }[];
}

export function buildFloor2Props(b: Build, g2: THREE.Group, tentacles: THREE.Group[]): Floor2Props {
  const { M } = b;
  const { toon, flat } = b.kit;
  const blinkers: Blinker[] = [];
  const tankBubbles: THREE.Mesh[] = [];
  let liquid: ServerRoom["liquid"];
  const screenFace = canvasTex(SERVER_SCREEN_W, SERVER_SCREEN_H);
  const screenGroup = new THREE.Group();
  const serverHit: THREE.Object3D[] = [screenGroup];

  // server room
  {
    for (const [rack, x] of [5.9, 7.3].entries()) {
      const g = new THREE.Group(); g.position.set(x, F2, -6.9); g2.add(g); serverHit.push(g);
      boxAt(g, 1.2, 3.2, 1.2, 0, 0, 0, M.dark, 0.1);
      for (let r = 0; r < 6; r++) {
        boxAt(g, 1.0, 0.3, 0.06, 0, 0.35 + r * 0.46, 0.61, toon("#2a2350"), 0.03);
        for (let k = 0; k < 3; k++) {
          const led = mesh(new THREE.SphereGeometry(0.045, 8, 6), noLine(flat("#a6e22e")), false, false) as Blinker["m"];
          led.position.set(-0.3 + k * 0.18, 0.5 + r * 0.46, 0.66); g.add(led);
          blinkers.push({ m: led, rate: 2 + Math.random() * 6, ph: Math.random() * 10, color: ["#a6e22e", "#59c3ff", "#ff6fd8"][k], rack, row: r });
        }
      }
    }
    const g = new THREE.Group(); g.position.set(8.3, F2, -4.6); g2.add(g); serverHit.push(g);
    cyl(g, 0.85, 1.0, 0.6, 0, 0, 0, M.dark, 24);
    const glass = mesh(new THREE.CylinderGeometry(0.7, 0.7, 2.6, 24, 1, true), thin(toon("#ffd1f3", { transparent: true, opacity: 0.32, side: THREE.DoubleSide }), 0.8), false, false);
    glass.position.y = 1.9; g.add(glass);
    liquid = mesh(new THREE.CylinderGeometry(0.62, 0.62, 2.0, 24), noLine(toon("#ff6fd8", { transparent: true, opacity: 0.75 })), false, false) as ServerRoom["liquid"];
    liquid.position.y = 1.62; g.add(liquid);
    cyl(g, 0.82, 0.82, 0.32, 0, 3.15, 0, M.dark, 24);
    for (let i = 0; i < 14; i++) {
      const bb = mesh(new THREE.SphereGeometry(0.05 + Math.random() * 0.07, 10, 8), noLine(flat("#ffe6fa")), false, false);
      bb.userData = { sp: 0.4 + Math.random() * 0.7, ph: Math.random() * 6, x: (Math.random() - 0.5) * 0.8, z: (Math.random() - 0.5) * 0.8 };
      bb.position.set(bb.userData.x, 0.7 + Math.random() * 1.9, bb.userData.z); g.add(bb);
      tankBubbles.push(bb);
    }
    roomLabel(b, g2, "SERVER", 7.1, F2 + 0.2, -2.2, 2);
    // server monitor screen (not in the prototype): dark wall screen above the racks
    const [sx, sy, sz] = SERVER_SCREEN_AT, [sw, sh] = SERVER_SCREEN_SIZE;
    const sg = screenGroup; sg.position.set(sx, F2 + sy, sz); sg.visible = false; g2.add(sg);
    sg.add(mesh(rbox(sw, sh, 0.14, 0.08), M.dark));
    const sf = mesh(new THREE.PlaneGeometry(sw - 0.2, sh - 0.2), noLine(flat("#ffffff", { map: screenFace.tex })), false, false);
    sf.position.z = 0.075; sg.add(sf);
  }
  // hall jendela
  alienPlant(b, tentacles, g2, 12.4, F2, -2.4, 0.7);
  roomLabel(b, g2, "JENDELA", 11.3, F2 + 0.2, -4.0, 2);

  // mission board + clock
  const board = canvasTex(640, 380);
  {
    const g = new THREE.Group(); g.position.set(-12.55, F2 + 2.4, -3.0); g.rotation.y = Math.PI / 2; g2.add(g);
    g.add(mesh(rbox(4.6, 2.8, 0.15, 0.08), M.wood));
    const s = mesh(new THREE.PlaneGeometry(4.3, 2.55), noLine(flat("#ffffff", { map: board.tex })), false, false);
    s.position.z = 0.085; g.add(s);
  }
  let clockHands: Floor2Props["clockHands"];
  {
    const g = new THREE.Group(); g.position.set(0.8, F2 + 3.2, -7.55); g2.add(g);
    const face = mesh(new THREE.CylinderGeometry(0.85, 0.85, 0.12, 32), M.trim); face.rotation.x = Math.PI / 2; g.add(face);
    for (let i = 0; i < 12; i++) {
      const tk = mesh(new THREE.BoxGeometry(0.06, 0.16, 0.02), noLine(flat(INK)));
      const a = (i / 12) * Math.PI * 2;
      tk.position.set(Math.sin(a) * 0.68, Math.cos(a) * 0.68, 0.07); tk.rotation.z = -a; g.add(tk);
    }
    const mk = (len: number, w: number, col: string) => {
      const p = new THREE.Group();
      const bar = mesh(new THREE.BoxGeometry(w, len, 0.03), noLine(flat(col)));
      bar.position.y = len / 2; p.add(bar); p.position.z = 0.09; g.add(p);
      return p;
    };
    clockHands = { h: mk(0.42, 0.08, INK), m: mk(0.6, 0.05, INK), s: mk(0.65, 0.025, "#ff4f5e") };
  }
  // ruang rapat: whiteboard + card table
  let wb: Floor2Props["wb"];
  {
    const w = canvasTex(512, 320);
    boxAt(g2, 0.1, 1.9, 3.0, -12.55, F2 + 0.9, 6.3, M.dark, 0.04);
    const s = mesh(new THREE.PlaneGeometry(2.85, 1.75), noLine(flat("#ffffff", { map: w.tex })), false, false);
    s.position.set(-12.49, F2 + 1.85, 6.3); s.rotation.y = Math.PI / 2; g2.add(s);
    w.ctx.fillStyle = "#ffffff"; w.ctx.fillRect(0, 0, 512, 320); w.tex.needsUpdate = true;
    wb = { ...w, strokes: 0, cx: 120, cy: 120 };
    cyl(g2, 0.12, 0.3, 0.9, -8.2, F2, 6.4, M.dark, 14);
    cyl(g2, 0.75, 0.75, 0.08, -8.2, F2 + 0.9, 6.4, toon("#2e8b6a"), 28);
    for (const x of [-9.4, -7.0]) {
      cyl(g2, 0.06, 0.15, 0.7, x, F2, 6.4, M.dark, 10);
      cyl(g2, 0.32, 0.32, 0.1, x, F2 + 0.7, 6.4, M.red, 18);
    }
    for (let i = 0; i < 5; i++) {
      const c = mesh(rbox(0.16, 0.012, 0.22, 0.005), noLine(toon("#fff6e3")), false, false);
      c.position.set(-8.3 + (i - 2) * 0.08, F2 + 0.99 + i * 0.004, 6.4 + (i % 2) * 0.05); c.rotation.y = i * 0.3; g2.add(c);
    }
    roomLabel(b, g2, "RUANG RAPAT", -9.0, F2 + 0.2, 7.8, 2);
  }
  // pojok baca
  {
    const bs = new THREE.Group(); bs.position.set(-1.0, F2, 4.85); g2.add(bs);
    boxAt(bs, 5.0, 2.4, 0.5, 0, 0, 0, M.woodD, 0.05);
    for (let r = 0; r < 3; r++) {
      boxAt(bs, 4.8, 0.06, 0.5, 0, 0.5 + r * 0.7, 0.02, M.wood, 0.02);
      let x = -2.25;
      while (x < 2.2) {
        const w = 0.12 + Math.random() * 0.12, h = 0.4 + Math.random() * 0.2;
        boxAt(bs, w, h, 0.36, x + w / 2, 0.56 + r * 0.7, 0.05, toon(pick(["#ff6fd8", "#59c3ff", "#ffd23f", "#a6e22e", "#ff9f68", "#c3a6ff"])), 0.02);
        x += w + 0.03;
        if (Math.random() < 0.08) x += 0.3;
      }
    }
    for (const [x, c] of [[-2.2, "#59c3ff"], [0.6, "#ff9f68"]] as const) {
      const ch = new THREE.Group(); ch.position.set(x, F2, 6.6); g2.add(ch);
      boxAt(ch, 1.35, 0.45, 1.1, 0, 0.1, 0, toon(c), 0.14);
      boxAt(ch, 1.35, 1.05, 0.3, 0, 0.5, -0.45, toon(c), 0.14);
      for (const s of [-1, 1]) boxAt(ch, 0.28, 0.7, 1.1, s * 0.6, 0.1, 0, toon(shade(c, -0.08)), 0.12);
      boxAt(ch, 0.98, 0.14, 0.85, 0, 0.55, 0.06, toon(shade(c, 0.12)), 0.06);
    }
    cyl(g2, 0.2, 0.25, 0.08, -0.8, F2, 7.5, M.dark);
    cyl(g2, 0.03, 0.03, 1.6, -0.8, F2 + 0.08, 7.5, M.dark, 8);
    cyl(g2, 0.22, 0.38, 0.4, -0.8, F2 + 1.6, 7.5, M.yellow, 16);
    roomLabel(b, g2, "POJOK BACA", -0.8, F2 + 0.2, 8.0, 2);
  }
  roomLabel(b, g2, "KANTOR", -4.2, F2 + 0.2, -7.2, 2);
  // task board (deviation 14): left wall between the mission board and the meeting room
  const BOARD_Z = 1.7;
  const face = canvasTex(512, 320);
  const cards: TaskBoard["cards"] = [];
  const tbGroup = new THREE.Group();
  {
    const g = tbGroup; g.position.set(-12.55, F2 + 2.15, BOARD_Z); g.rotation.y = Math.PI / 2; g2.add(g);
    g.add(mesh(rbox(3.2, 2.0, 0.14, 0.08), M.woodD));
    const cork = mesh(new THREE.PlaneGeometry(2.95, 1.78), noLine(flat("#ffffff", { map: face.tex })), false, false);
    cork.position.z = 0.075; g.add(cork);
    for (const z of BOARD_SLOTS_Z) {
      const c = new THREE.Group(); c.position.set(-(z - BOARD_Z), -0.18, 0.1); c.visible = false; g.add(c);
      const paper = mesh(rbox(0.6, 0.66, 0.025, 0.02), toon("#fff6e3"), false, false) as TaskBoard["cards"][number]["paper"];
      paper.rotation.z = (Math.random() - 0.5) * 0.18; c.add(paper);
      for (const ly of [0.12, 0.0, -0.12]) { const line = mesh(new THREE.PlaneGeometry(0.4, 0.035), noLine(flat(INK, { transparent: true, opacity: 0.35 })), false, false); line.position.set(0, ly, 0.016); paper.add(line); }
      const pin = mesh(new THREE.SphereGeometry(0.06, 10, 8), toon("#ff4f5e"), false, false); pin.position.set(0, 0.28, 0.04); c.add(pin);
      cards.push({ g: c, paper, pop: 0 });
    }
  }

  // schedule board (Hermes cron): dark departure board with a bell on top
  const sFace = canvasTex(640, 400);
  const sGroup = new THREE.Group();
  const bell = new THREE.Group();
  {
    const [x, y, z] = SCHEDULE_BOARD_AT, [w, h] = SCHEDULE_BOARD_SIZE;
    const g = sGroup; g.position.set(x, F2 + y, z); g.visible = false; g2.add(g);
    g.add(mesh(rbox(w, h, 0.14, 0.08), M.dark));
    const face = mesh(new THREE.PlaneGeometry(w - 0.22, h - 0.2), noLine(flat("#ffffff", { map: sFace.tex })), false, false);
    face.position.z = 0.075; g.add(face);
    cyl(g, 0.025, 0.025, 0.36, 0, h / 2, 0.12, M.dark, 8); // hook from the board top to the bell's pivot
    bell.position.set(0, h / 2 + 0.36, 0.12); g.add(bell);
    const cup = mesh(new THREE.CylinderGeometry(0.08, 0.2, 0.26, 16), toon("#ffd23f"), false, false);
    cup.position.y = -0.2; bell.add(cup); // hangs below the pivot
    const clapper = mesh(new THREE.SphereGeometry(0.05, 10, 8), toon("#c98a4b"), false, false);
    clapper.position.y = -0.36; bell.add(clapper);
  }

  return {
    blinkers, tankBubbles, board, clockHands: clockHands!, wb: wb!, taskBoard: { group: tbGroup, face, cards },
    scheduleBoard: { group: sGroup, face: sFace, bell },
    server: { liquid: liquid!, screen: { group: screenGroup, face: screenFace }, hit: serverHit },
  };
}
