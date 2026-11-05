// Middle tier "Kantor" (deviation 29): the office (desks are built per slot by props/desk.ts), with the mission board,
// task board, clock and schedule board on the left wall; Ruang Kreatif, Pojok Baca and the garden along the street.
// Furniture from the prototype's floor 2 (references/agent-hq.html), placed in world coordinates. The office lost its
// back wall (the back tier rises behind it), so the clock and the schedule board moved to the left wall.

import * as THREE from "three";
import { INK } from "../constants";
import { boxAt, canvasTex, cyl, mesh, noLine, pick, rbox, shade, type CanvasTex } from "../scene/kit";
import type { WhiteboardEgg } from "../displays/office";
import { BOARD_SLOTS_Z, BOARD_Z } from "../nav/places";
import { T1, X_LEFT } from "../layout";
import { alienPlant } from "./props/alienPlant";
import { partition, roomLabel, type Build } from "./structure";

/** Wall-mounted things hang just off the inner face of the left wall, facing +x. */
const WALL_X = X_LEFT + 0.25;

/** Schedule board (Hermes cron, docs/hermes.md "Jadwal"): hidden until a schedule source reports. Not in the prototype. */
export interface ScheduleBoard {
  group: THREE.Group;
  face: CanvasTex;
  /** Swings while a job runs. */
  bell: THREE.Group;
}

/** Left wall, behind the back row of desks. [y above the tier, z] of the board's center. */
export const SCHEDULE_BOARD_AT: [number, number] = [2.3, -6.33];
export const SCHEDULE_BOARD_SIZE: [number, number] = [2.75, 1.72];

/** Cork task board (deviation 14): a header and one card spot per standing spot (BOARD_SLOTS_Z). */
export interface TaskBoard {
  group: THREE.Group;
  /** Cork face with the "PAPAN TUGAS" header, drawn once fonts are ready. */
  face: CanvasTex;
  /** Card pinned for agent `occ` while it is on its way; hidden once picked up. */
  cards: { g: THREE.Group; paper: THREE.Mesh<THREE.BufferGeometry, THREE.MeshToonMaterial>; pop: number }[];
}

export interface KantorProps {
  board: CanvasTex;
  clockHands: { h: THREE.Group; m: THREE.Group; s: THREE.Group };
  wb: CanvasTex & { strokes: number; cx: number; cy: number; wasOn?: boolean; forceEgg?: boolean; egg?: WhiteboardEgg | null; keepOut?: [number, number, number, number] | null };
  taskBoard: TaskBoard;
  scheduleBoard: ScheduleBoard;
}

export function buildKantor(b: Build, g: THREE.Group, tentacles: THREE.Group[]): KantorProps {
  const { M } = b;
  const { toon, flat } = b.kit;
  const Y = T1;

  // mission board (left wall, middle)
  const board = canvasTex(640, 380);
  {
    const bg = new THREE.Group(); bg.position.set(WALL_X, Y + 2.4, -2.45); bg.rotation.y = Math.PI / 2; g.add(bg);
    bg.add(mesh(rbox(4.6, 2.8, 0.15, 0.08), M.wood));
    const s = mesh(new THREE.PlaneGeometry(4.3, 2.55), noLine(flat("#ffffff", { map: board.tex })), false, false);
    s.position.z = 0.085; bg.add(s);
  }
  // clock (left wall, above the task board)
  let clockHands: KantorProps["clockHands"];
  {
    const cg = new THREE.Group(); cg.position.set(WALL_X - 0.05, Y + 4.15, BOARD_Z); cg.rotation.y = Math.PI / 2; g.add(cg);
    const face = mesh(new THREE.CylinderGeometry(0.85, 0.85, 0.12, 32), M.trim); face.rotation.x = Math.PI / 2; cg.add(face);
    for (let i = 0; i < 12; i++) {
      const tk = mesh(new THREE.BoxGeometry(0.06, 0.16, 0.02), noLine(flat(INK)));
      const a = (i / 12) * Math.PI * 2;
      tk.position.set(Math.sin(a) * 0.68, Math.cos(a) * 0.68, 0.07); tk.rotation.z = -a; cg.add(tk);
    }
    const mk = (len: number, w: number, col: string) => {
      const p = new THREE.Group();
      const bar = mesh(new THREE.BoxGeometry(w, len, 0.03), noLine(flat(col)));
      bar.position.y = len / 2; p.add(bar); p.position.z = 0.09; cg.add(p);
      return p;
    };
    clockHands = { h: mk(0.42, 0.08, INK), m: mk(0.6, 0.05, INK), s: mk(0.65, 0.025, "#ff4f5e") };
  }
  roomLabel(b, g, "KANTOR", -20.0, Y + 0.2, -7.4, "kantor");

  // task board (deviation 14): left wall, toward the street
  const face = canvasTex(512, 320);
  const cards: TaskBoard["cards"] = [];
  const tbGroup = new THREE.Group();
  {
    const tg = tbGroup; tg.position.set(WALL_X, Y + 2.15, BOARD_Z); tg.rotation.y = Math.PI / 2; g.add(tg);
    tg.add(mesh(rbox(3.2, 2.0, 0.14, 0.08), M.woodD));
    const cork = mesh(new THREE.PlaneGeometry(2.95, 1.78), noLine(flat("#ffffff", { map: face.tex })), false, false);
    cork.position.z = 0.075; tg.add(cork);
    for (const z of BOARD_SLOTS_Z) {
      const c = new THREE.Group(); c.position.set(-(z - BOARD_Z), -0.18, 0.1); c.visible = false; tg.add(c);
      const paper = mesh(rbox(0.6, 0.66, 0.025, 0.02), toon("#fff6e3"), false, false) as TaskBoard["cards"][number]["paper"];
      paper.rotation.z = (Math.random() - 0.5) * 0.18; c.add(paper);
      for (const ly of [0.12, 0.0, -0.12]) { const line = mesh(new THREE.PlaneGeometry(0.4, 0.035), noLine(flat(INK, { transparent: true, opacity: 0.35 })), false, false); line.position.set(0, ly, 0.016); paper.add(line); }
      const pin = mesh(new THREE.SphereGeometry(0.06, 10, 8), toon("#ff4f5e"), false, false); pin.position.set(0, 0.28, 0.04); c.add(pin);
      cards.push({ g: c, paper, pop: 0 });
    }
  }

  // schedule board (Hermes cron): dark departure board with a bell on top, left wall behind the desks
  const sFace = canvasTex(640, 400);
  const sGroup = new THREE.Group();
  const bell = new THREE.Group();
  {
    const [y, z] = SCHEDULE_BOARD_AT, [w, h] = SCHEDULE_BOARD_SIZE;
    const sg = sGroup; sg.position.set(WALL_X, Y + y, z); sg.rotation.y = Math.PI / 2; sg.visible = false; g.add(sg);
    sg.add(mesh(rbox(w, h, 0.14, 0.08), M.dark));
    const sf = mesh(new THREE.PlaneGeometry(w - 0.22, h - 0.2), noLine(flat("#ffffff", { map: sFace.tex })), false, false);
    sf.position.z = 0.075; sg.add(sf);
    cyl(sg, 0.025, 0.025, 0.36, 0, h / 2, 0.12, M.dark, 8); // hook from the board top to the bell's pivot
    bell.position.set(0, h / 2 + 0.36, 0.12); sg.add(bell);
    const cup = mesh(new THREE.CylinderGeometry(0.08, 0.2, 0.26, 16), toon("#ffd23f"), false, false);
    cup.position.y = -0.2; bell.add(cup); // hangs below the pivot
    const clapper = mesh(new THREE.SphereGeometry(0.05, 10, 8), toon("#c98a4b"), false, false);
    clapper.position.y = -0.36; bell.add(clapper);
  }

  // ruang kreatif (prototype: ruang rapat): whiteboard on a stand + card table, open to the street
  let wb: KantorProps["wb"];
  {
    const w = canvasTex(512, 320);
    const X = -11.15, Z = -2.1;
    boxAt(g, 0.1, 1.9, 3.0, X, Y + 0.9, Z, M.dark, 0.04);
    for (const dz of [-1.55, 1.55]) {
      cyl(g, 0.05, 0.05, 2.85, X, Y, Z + dz, M.dark, 8);
      boxAt(g, 0.8, 0.06, 0.12, X, Y, Z + dz, M.dark, 0.02);
    }
    const s = mesh(new THREE.PlaneGeometry(2.85, 1.75), noLine(flat("#ffffff", { map: w.tex })), false, false);
    s.position.set(X + 0.06, Y + 1.85, Z); s.rotation.y = Math.PI / 2; g.add(s);
    w.ctx.fillStyle = "#ffffff"; w.ctx.fillRect(0, 0, 512, 320); w.tex.needsUpdate = true;
    wb = { ...w, strokes: 0, cx: 120, cy: 120 };
    cyl(g, 0.12, 0.3, 0.9, -6.8, Y, -2.0, M.dark, 14);
    cyl(g, 0.75, 0.75, 0.08, -6.8, Y + 0.9, -2.0, toon("#2e8b6a"), 28);
    for (const x of [-8.0, -5.6]) {
      cyl(g, 0.06, 0.15, 0.7, x, Y, -2.0, M.dark, 10);
      cyl(g, 0.32, 0.32, 0.1, x, Y + 0.7, -2.0, M.red, 18);
    }
    for (let i = 0; i < 5; i++) {
      const c = mesh(rbox(0.16, 0.012, 0.22, 0.005), noLine(toon("#fff6e3")), false, false);
      c.position.set(-6.9 + (i - 2) * 0.08, Y + 0.99 + i * 0.004, -2.0 + (i % 2) * 0.05); c.rotation.y = i * 0.3; g.add(c);
    }
    partition(b, g, "x", -4.0, -11.4, -4.2, Y);
    partition(b, g, "z", -4.0, -3.6, 0.0, Y);
    roomLabel(b, g, "RUANG KREATIF", -7.6, Y + 0.2, 2.2, "kantor"); // "RUANG RAPAT" in the prototype (deviation 24)
  }
  // pojok baca: bookshelf with the two armchairs in front of it
  {
    const bs = new THREE.Group(); bs.position.set(-1.2, Y, -4.2); g.add(bs);
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
    for (const [x, c] of [[-2.4, "#59c3ff"], [0.4, "#ff9f68"]] as const) {
      const ch = new THREE.Group(); ch.position.set(x, Y, -2.45); g.add(ch);
      boxAt(ch, 1.35, 0.45, 1.1, 0, 0.1, 0, toon(c), 0.14);
      boxAt(ch, 1.35, 1.05, 0.3, 0, 0.5, -0.45, toon(c), 0.14);
      for (const s of [-1, 1]) boxAt(ch, 0.28, 0.7, 1.1, s * 0.6, 0.1, 0, toon(shade(c, -0.08)), 0.12);
      boxAt(ch, 0.98, 0.14, 0.85, 0, 0.55, 0.06, toon(shade(c, 0.12)), 0.06);
    }
    cyl(g, 0.2, 0.25, 0.08, -1.0, Y, -1.55, M.dark);
    cyl(g, 0.03, 0.03, 1.6, -1.0, Y + 0.08, -1.55, M.dark, 8);
    cyl(g, 0.22, 0.38, 0.4, -1.0, Y + 1.6, -1.55, M.yellow, 16);
    roomLabel(b, g, "POJOK BACA", -1.0, Y + 0.2, 2.2, "kantor");
  }
  // taman: pond, two benches facing the camera, alien plants, garden lamps (new with the single floor)
  {
    const pond = mesh(new THREE.CircleGeometry(1, 40), noLine(toon("#8a7a6a")), false, true);
    pond.rotation.x = -Math.PI / 2; pond.scale.set(2.9, 1.9, 1); pond.position.set(13.0, Y + 0.02, -3.8); g.add(pond);
    const water = mesh(new THREE.CircleGeometry(1, 40), noLine(toon("#59c3ff")), false, true);
    water.rotation.x = -Math.PI / 2; water.scale.set(2.6, 1.6, 1); water.position.set(13.0, Y + 0.03, -3.8); g.add(water);
    for (const [x, z, r] of [[12.0, -4.2, 0.32], [14.1, -3.2, 0.26], [13.3, -4.7, 0.22]] as const) {
      const pad = mesh(new THREE.CircleGeometry(r, 18, 0.4, Math.PI * 1.8), noLine(toon("#3aa35a")), false, false);
      pad.rotation.x = -Math.PI / 2; pad.position.set(x, Y + 0.04, z); g.add(pad);
    }
    for (const x of [10.0, 16.0]) {
      const bench = new THREE.Group(); bench.position.set(x, Y, -1.0); g.add(bench);
      boxAt(bench, 1.7, 0.12, 0.6, 0, 0.42, 0, M.wood, 0.04);
      boxAt(bench, 1.7, 0.5, 0.1, 0, 0.62, -0.32, M.wood, 0.04);
      for (const sx of [-0.7, 0.7]) boxAt(bench, 0.1, 0.42, 0.5, sx, 0, 0, M.dark, 0.02);
    }
    for (const [x, z, sc] of [[7.4, -5.6, 0.9], [19.4, -5.2, 1.0], [20.4, 1.4, 0.75], [27.4, -6.2, 0.9], [27.2, 1.6, 0.8]] as const) alienPlant(b, tentacles, g, x, Y, z, sc);
    for (const x of [7.6, 18.6]) {
      cyl(g, 0.06, 0.08, 1.9, x, Y, 1.7, M.dark, 8);
      const bulb = mesh(new THREE.SphereGeometry(0.2, 14, 10), noLine(flat("#fff3b0")), false, false);
      bulb.position.set(x, Y + 2.0, 1.7); g.add(bulb);
    }
    roomLabel(b, g, "TAMAN", 13.0, Y + 0.2, 1.6, "kantor");
  }

  return { board, clockHands: clockHands!, wb: wb!, taskBoard: { group: tbGroup, face, cards }, scheduleBoard: { group: sGroup, face: sFace, bell } };
}
