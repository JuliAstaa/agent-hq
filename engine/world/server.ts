// Back tier, right: "Ruang Server" (deviation 29). A dedicated server room behind clear tinted glass with a sliding
// door: two rack rows (the front row's CPU and RAM racks and the disk tank are the server monitor, prd.md §7.8),
// the wall screen above the back row, a cooling unit with spinning fans, cable trays over the racks, a status beacon
// over the door. The three DevOps stations (dept "ops", security.ts buildStation) stand between the racks and the
// glass. Not in the prototype; its racks and tank were the small server room on floor 2.

import * as THREE from "three";
import { boxAt, cyl, mesh, noLine, thin, V, type CanvasTex, canvasTex } from "../scene/kit";
import { SERVER_SCREEN_H, SERVER_SCREEN_W } from "../displays/server";
import { DOOR_HALF, RACK_BACK_Z, RACK_FRONT_Z, SERVER_DOOR_X, SERVER_FRONT_Z } from "../nav/places";
import { T2, X_RIGHT, X_SERVER, Z_BACK } from "../layout";
import { makeWall, roomLabel, type Build } from "./structure";

type BasicMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;

export interface Blinker {
  m: BasicMesh;
  rate: number;
  ph: number;
  color: string;
  /** Monitored rack (0 = CPU, 1 = RAM) or -1 for a decor rack, and the LED row from the bottom (0..5). */
  rack: number;
  row: number;
}

export interface ServerRoom {
  blinkers: Blinker[];
  tankBubbles: THREE.Mesh[];
  /** Tank liquid: its height shows disk usage. */
  liquid: THREE.Mesh<THREE.BufferGeometry, THREE.MeshToonMaterial>;
  /** Wall screen above the back racks, hidden until the bridge sends a sample. */
  screen: { group: THREE.Group; face: CanvasTex };
  /** Racks, tank and screen: a click on one of them opens the Server panel. */
  hit: THREE.Object3D[];
  /** Sliding glass door: `open` 0..1 (stepServerDoor). */
  door: { leaf: THREE.Group; open: number };
  /** Cooling unit fans (spin). */
  fans: THREE.Group[];
  /** Lamp over the door: server level color, dim without samples. */
  beacon: BasicMesh;
}

/** Back wall above the back rack row: [x, y above the tier, z] of the screen's center, and its size. */
export const SERVER_SCREEN_AT: [number, number, number] = [22.2, 3.55, Z_BACK + 0.25];
export const SERVER_SCREEN_SIZE: [number, number] = [2.5, 1.4];
/** Liquid height at 100% disk (decor: 2.0). Bottom at 0.62 above the floor, like the decor liquid. */
export const LIQUID_FULL = 2.4;
export const LIQUID_BASE = 0.62;
/** Right glass wall (the island edge is just beyond it). */
const X_GLASS = X_RIGHT - 0.4;
const WALL_H = 2.6, DOOR_H = 2.25;
const DOOR_SLIDE = DOOR_HALF * 2 + 0.05;

export function buildServerRoom(b: Build, g: THREE.Group): ServerRoom {
  const { M } = b;
  const { toon, flat } = b.kit;
  const blinkers: Blinker[] = [];
  const hit: THREE.Object3D[] = [];
  const Y = T2;

  // back wall (dark steel) with trims
  makeWall(b, g, "x", Z_BACK, X_SERVER, X_RIGHT, Y, 4.4, [], toon("#2c3550"));
  boxAt(g, X_RIGHT - X_SERVER, 0.18, 0.56, (X_SERVER + X_RIGHT) / 2, Y + 4.4, Z_BACK, M.trim, 0.04);
  boxAt(g, X_RIGHT - X_SERVER, 0.25, 0.48, (X_SERVER + X_RIGHT) / 2, Y, Z_BACK, M.dark, 0.04);

  // racks: LED rows on the front (+z); the front row's first two are the CPU and RAM racks of the monitor
  const rack = (x: number, z: number, h: number, rows: number, monitored: number) => {
    const r = new THREE.Group(); r.position.set(x, Y, z); g.add(r); hit.push(r);
    boxAt(r, 1.2, h, 1.2, 0, 0, 0, M.dark, 0.1);
    boxAt(r, 1.24, 0.12, 1.24, 0, h - 0.06, 0, toon("#4a3f80"), 0.04);
    for (let row = 0; row < rows; row++) {
      boxAt(r, 1.0, 0.3, 0.06, 0, 0.35 + row * 0.46, 0.61, toon("#2a2350"), 0.03);
      for (let k = 0; k < 3; k++) {
        const led = mesh(new THREE.SphereGeometry(0.045, 8, 6), noLine(flat("#a6e22e")), false, false) as BasicMesh;
        led.position.set(-0.3 + k * 0.18, 0.5 + row * 0.46, 0.66); r.add(led);
        blinkers.push({ m: led, rate: 2 + Math.random() * 6, ph: Math.random() * 10, color: ["#a6e22e", "#59c3ff", "#ff6fd8"][k], rack: monitored, row });
      }
    }
  };
  [19.4, 20.8, 22.2, 23.6].forEach((x, i) => rack(x, RACK_FRONT_Z, 3.2, 6, i < 2 ? i : -1));
  [19.4, 20.8, 22.2, 23.6, 25.0].forEach((x) => rack(x, RACK_BACK_Z, 2.6, 5, -1));

  // disk tank (decor liquid until samples arrive)
  const tankBubbles: THREE.Mesh[] = [];
  let liquid: ServerRoom["liquid"];
  {
    const tg = new THREE.Group(); tg.position.set(25.7, Y, RACK_FRONT_Z); g.add(tg); hit.push(tg);
    cyl(tg, 0.85, 1.0, 0.6, 0, 0, 0, M.dark, 24);
    const glass = mesh(new THREE.CylinderGeometry(0.7, 0.7, 2.6, 24, 1, true), thin(toon("#ffd1f3", { transparent: true, opacity: 0.32, side: THREE.DoubleSide }), 0.8), false, false);
    glass.position.y = 1.9; tg.add(glass);
    liquid = mesh(new THREE.CylinderGeometry(0.62, 0.62, 2.0, 24), noLine(toon("#ff6fd8", { transparent: true, opacity: 0.75 })), false, false) as ServerRoom["liquid"];
    liquid.position.y = 1.62; tg.add(liquid);
    cyl(tg, 0.82, 0.82, 0.32, 0, 3.15, 0, M.dark, 24);
    for (let i = 0; i < 14; i++) {
      const bb = mesh(new THREE.SphereGeometry(0.05 + Math.random() * 0.07, 10, 8), noLine(flat("#ffe6fa")), false, false);
      bb.userData = { sp: 0.4 + Math.random() * 0.7, ph: Math.random() * 6, x: (Math.random() - 0.5) * 0.8, z: (Math.random() - 0.5) * 0.8 };
      bb.position.set(bb.userData.x, 0.7 + Math.random() * 1.9, bb.userData.z); tg.add(bb);
      tankBubbles.push(bb);
    }
  }

  // cooling unit in the back-right corner, two fans on its front
  const fans: THREE.Group[] = [];
  {
    const cg = new THREE.Group(); cg.position.set(27.6, Y, RACK_BACK_Z + 0.1); g.add(cg);
    boxAt(cg, 1.8, 2.9, 1.1, 0, 0, 0, toon("#d7e3f2"), 0.08);
    boxAt(cg, 1.6, 0.4, 0.06, 0, 2.3, 0.56, toon("#59c3ff"), 0.03);
    for (const fy of [0.75, 1.65]) {
      const ring = mesh(new THREE.TorusGeometry(0.36, 0.05, 8, 24), M.dark); ring.position.set(0, fy, 0.57); cg.add(ring);
      const fan = new THREE.Group(); fan.position.set(0, fy, 0.58); cg.add(fan);
      for (let k = 0; k < 4; k++) {
        const blade = mesh(new THREE.BoxGeometry(0.1, 0.32, 0.02), noLine(toon("#8fa3b8")), false, false);
        blade.position.y = 0.16; const piv = new THREE.Group(); piv.rotation.z = (k / 4) * Math.PI * 2; piv.add(blade); fan.add(piv);
      }
      fans.push(fan);
    }
  }

  // cable trays over both rows, with cables looping from the front row to the back row
  {
    const tray = toon("#ffd23f");
    boxAt(g, 4.6, 0.08, 0.5, 21.5, Y + 3.45, RACK_FRONT_Z, tray, 0.02);
    boxAt(g, 6.0, 0.08, 0.5, 22.2, Y + 2.85, RACK_BACK_Z, tray, 0.02);
    for (const [x, c] of [[19.8, "#ff6fd8"], [20.6, "#59c3ff"], [21.6, "#a6e22e"], [22.8, "#ff9f1c"]] as const) {
      const curve = new THREE.CatmullRomCurve3([V(x, Y + 3.5, RACK_FRONT_Z - 0.1), V(x + 0.1, Y + 3.95, (RACK_FRONT_Z + RACK_BACK_Z) / 2), V(x + 0.2, Y + 2.9, RACK_BACK_Z + 0.1)]);
      g.add(mesh(new THREE.TubeGeometry(curve, 16, 0.05, 6, false), toon(c), false, false));
    }
  }

  // wall screen above the back racks (server monitor): hidden until a sample arrives
  const face = canvasTex(SERVER_SCREEN_W, SERVER_SCREEN_H);
  const sGroup = new THREE.Group();
  {
    const [sx, sy, sz] = SERVER_SCREEN_AT, [sw, sh] = SERVER_SCREEN_SIZE;
    sGroup.position.set(sx, Y + sy, sz); sGroup.visible = false; g.add(sGroup); hit.push(sGroup);
    sGroup.add(mesh(new THREE.BoxGeometry(sw, sh, 0.14), M.dark));
    const sf = mesh(new THREE.PlaneGeometry(sw - 0.2, sh - 0.2), noLine(flat("#ffffff", { map: face.tex })), false, false);
    sf.position.z = 0.075; sGroup.add(sf);
  }

  // clear tinted glass: front wall with the door, right wall along the island edge (Meeting C's glass is the left)
  const glassM = noLine(toon("#bfefff", { transparent: true, opacity: 0.2, depthWrite: false, side: THREE.DoubleSide }));
  const frameM = thin(toon("#9fb4d0"), 0.55);
  const pane = (axis: "x" | "z", c: number, a0: number, a1: number, y0: number, h: number) => {
    const len = a1 - a0, mid = (a0 + a1) / 2;
    const m = mesh(axis === "x" ? new THREE.BoxGeometry(len, h, 0.04) : new THREE.BoxGeometry(0.04, h, len), glassM, false, false);
    m.position.set(axis === "x" ? mid : c, y0 + h / 2, axis === "x" ? c : mid); g.add(m);
  };
  const bar = (axis: "x" | "z", c: number, a0: number, a1: number, y0: number, h: number) => {
    const len = a1 - a0, mid = (a0 + a1) / 2;
    boxAt(g, axis === "x" ? len : 0.09, h, axis === "x" ? 0.09 : len, axis === "x" ? mid : c, y0, axis === "x" ? c : mid, frameM, 0.02, false);
  };
  const d0 = SERVER_DOOR_X - DOOR_HALF, d1 = SERVER_DOOR_X + DOOR_HALF;
  for (const [a0, a1] of [[X_SERVER, d0], [d1, X_GLASS]] as const) {
    pane("x", SERVER_FRONT_Z, a0, a1, Y + 0.07, WALL_H - 0.1);
    bar("x", SERVER_FRONT_Z, a0, a1, Y, 0.07);
  }
  pane("x", SERVER_FRONT_Z, d0, d1, Y + DOOR_H + 0.05, WALL_H - DOOR_H - 0.08);
  bar("x", SERVER_FRONT_Z, d0, d1, Y + DOOR_H, 0.06);
  bar("x", SERVER_FRONT_Z, X_SERVER, X_GLASS, Y + WALL_H - 0.04, 0.06);
  pane("z", X_GLASS, Z_BACK + 0.2, SERVER_FRONT_Z, Y + 0.07, WALL_H - 0.1);
  bar("z", X_GLASS, Z_BACK + 0.2, SERVER_FRONT_Z, Y, 0.07);
  bar("z", X_GLASS, Z_BACK + 0.2, SERVER_FRONT_Z, Y + WALL_H - 0.04, 0.06);
  for (const x of [X_SERVER, d0, d1, X_GLASS]) boxAt(g, 0.09, WALL_H, 0.09, x, Y, SERVER_FRONT_Z, frameM, 0.02, false);
  boxAt(g, 0.09, WALL_H, 0.09, X_GLASS, Y, Z_BACK + 0.2, frameM, 0.02, false);
  // sliding door leaf on the street side, slides right over the glass
  const dg = new THREE.Group(); dg.position.set(SERVER_DOOR_X, Y, SERVER_FRONT_Z + 0.1); g.add(dg);
  const leaf = new THREE.Group(); dg.add(leaf);
  const lh = DOOR_H - 0.06;
  const lp = mesh(new THREE.BoxGeometry(DOOR_HALF * 2, lh, 0.04), glassM, false, false);
  lp.position.y = 0.03 + lh / 2; leaf.add(lp);
  for (const sx of [-DOOR_HALF, DOOR_HALF]) boxAt(leaf, 0.06, lh, 0.07, sx, 0.03, 0, frameM, 0.02, false);
  boxAt(leaf, 0.05, 0.7, 0.1, -DOOR_HALF + 0.2, 0.75, 0.04, M.dark, 0.02, false);
  // badge reader and status beacon
  boxAt(g, 0.22, 0.32, 0.08, d1 + 0.45, Y + 1.1, SERVER_FRONT_Z + 0.08, M.dark, 0.02);
  const led = mesh(new THREE.SphereGeometry(0.035, 8, 6), noLine(flat("#a6e22e")), false, false); led.position.set(d1 + 0.45, Y + 1.32, SERVER_FRONT_Z + 0.13); g.add(led);
  cyl(g, 0.16, 0.18, 0.1, SERVER_DOOR_X, Y + WALL_H + 0.02, SERVER_FRONT_Z, M.dark, 16);
  const beacon = mesh(new THREE.SphereGeometry(0.15, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), noLine(flat("#59c3ff")), false, false) as BasicMesh;
  beacon.position.set(SERVER_DOOR_X, Y + WALL_H + 0.12, SERVER_FRONT_Z); g.add(beacon);

  roomLabel(b, g, "RUANG SERVER", SERVER_DOOR_X, Y + 0.2, SERVER_FRONT_Z + 0.75, "server");
  return { blinkers, tankBubbles, liquid: liquid!, screen: { group: sGroup, face }, hit, door: { leaf, open: 0 }, fans, beacon };
}

/** The door slides open while someone is near it (agent positions, world-group coordinates). */
export function stepServerDoor(door: ServerRoom["door"], at: THREE.Vector3[], dt: number) {
  const near = at.some((p) => Math.abs(p.y - T2) < 1 && Math.abs(p.x - SERVER_DOOR_X) < DOOR_HALF + 0.9 && Math.abs(p.z - SERVER_FRONT_Z) < 1.6);
  door.open += ((near ? 1 : 0) - door.open) * Math.min(1, dt * 7);
  door.leaf.position.x = DOOR_SLIDE * door.open;
}
