// Airlock (prd.md §7.10): a small metal room in the front right corner of the Santai tier, between the vending
// machines and the Teras. Kicked agents come in through a sliding inner door on its left side; a hatch on the
// island's right edge swings out to space.
// Clear glass at the front so the camera sees inside; a beacon and floor lights turn red while a launch runs.

import * as THREE from "three";
import { INK } from "../constants";
import { T0 } from "../layout";
import type { Fonts } from "../scene/fonts";
import { boxAt, canvasTex, mesh, noLine, rbox, thin, type CanvasTex } from "../scene/kit";
import { AIRLOCK, createAirlockSpots } from "../nav/places";
import { roomLabel, type Build } from "./structure";

type BasicMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
type ToonMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshToonMaterial>;

export interface AirlockProp {
  /** Inner sliding door (corridor side) and hatch (to space): `open` 0..1, eased by stepAirlock. */
  door: { leaf: THREE.Group; open: number };
  hatch: { leaf: THREE.Group; open: number };
  beacon: { dome: ToonMesh; beams: THREE.Group };
  /** Floor light strips: mint at rest, flashing red while armed. */
  lights: BasicMesh[];
  /** "AIRLOCK" sign on the back wall (drawn once the fonts are ready). */
  sign: CanvasTex & { draw: () => void };
}

/** Wall height (the camera sees over it), back wall height (carries the sign), door and hatch opening heights. */
const WALL_H = 2.6, BACK_H = 3.4, DOOR_H = 2.25, HATCH_H = 2.1;
/** How far the hatch swings out (radians) and the inner door slides. */
const HATCH_SWING = 1.9;
const DOOR_SLIDE = AIRLOCK.doorHalf * 2 + 0.05;
const REST = "#7fe3d0", ALARM = "#ff4f5e";

/** Yellow and ink warning stripes (repeating). */
function hazard(): CanvasTex {
  const t = canvasTex(64, 64);
  const c = t.ctx;
  c.fillStyle = "#ffd23f"; c.fillRect(0, 0, 64, 64);
  c.fillStyle = INK;
  for (let k = -64; k < 128; k += 32) {
    c.beginPath(); c.moveTo(k, 0); c.lineTo(k + 16, 0); c.lineTo(k + 16 - 64, 64); c.lineTo(k - 64, 64); c.closePath(); c.fill();
  }
  t.tex.wrapS = t.tex.wrapT = THREE.RepeatWrapping;
  return t;
}

export function buildAirlock(b: Build, g: THREE.Group, fonts: Fonts): AirlockProp {
  const { M } = b;
  const { toon, flat } = b.kit;
  const { x0, x1, z0, z1, doorZ, doorHalf, hatchHalf } = AIRLOCK;
  const cx = (x0 + x1) / 2, w = x1 - x0, d = z1 - z0;
  const wallM = toon("#8a84bd"), plateM = toon("#cfd3e6");

  // floor: dark plates, a warning band at the hatch, an arrow to it and a ring at each standing spot
  const ft = canvasTex(288, 256);
  {
    const c = ft.ctx, W = 288, H = 256;
    c.fillStyle = "#3b3466"; c.fillRect(0, 0, W, H);
    c.strokeStyle = "rgba(255,255,255,.09)"; c.lineWidth = 2;
    for (let x = 0; x <= W; x += 48) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke(); }
    for (let y = 0; y <= H; y += 48) { c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke(); }
    const band = W - 30;
    c.fillStyle = "#ffd23f"; c.fillRect(band, 0, 30, H);
    c.fillStyle = INK;
    for (let y = -30; y < H; y += 24) { c.beginPath(); c.moveTo(band, y); c.lineTo(band + 30, y + 22); c.lineTo(band + 30, y + 34); c.lineTo(band, y + 12); c.closePath(); c.fill(); }
    c.fillStyle = "#ff6fd8";
    const ay = ((doorZ - z0) / d) * H;
    c.beginPath(); c.moveTo(W - 46, ay); c.lineTo(W - 78, ay - 22); c.lineTo(W - 78, ay - 9); c.lineTo(W - 118, ay - 9);
    c.lineTo(W - 118, ay + 9); c.lineTo(W - 78, ay + 9); c.lineTo(W - 78, ay + 22); c.closePath(); c.fill();
    c.strokeStyle = REST; c.lineWidth = 4; c.setLineDash([8, 6]);
    for (const s of createAirlockSpots()) {
      c.beginPath(); c.arc(((s.final.x - x0) / w) * W, ((s.final.z - z0) / d) * H, 22, 0, Math.PI * 2); c.stroke();
    }
    c.setLineDash([]);
  }
  const fl = mesh(new THREE.PlaneGeometry(w, d), noLine(toon("#ffffff", { map: ft.tex })), false, true);
  fl.rotation.x = -Math.PI / 2; fl.position.set(cx, T0 + 0.016, (z0 + z1) / 2); g.add(fl);

  // back wall with the sign on its inner face
  boxAt(g, w + 0.2, BACK_H, 0.22, cx, T0, z0, wallM, 0.05);
  boxAt(g, w + 0.34, 0.14, 0.36, cx, T0 + BACK_H, z0, M.dark, 0.04);
  const sign = canvasTex(360, 100) as AirlockProp["sign"];
  sign.draw = () => {
    const c = sign.ctx;
    c.fillStyle = INK; c.fillRect(0, 0, 360, 100);
    c.textAlign = "center";
    c.font = `46px ${fonts.bungee}`; c.fillStyle = "#ff6fd8"; c.fillText("AIRLOCK", 180, 52);
    c.font = `18px ${fonts.bungee}`; c.fillStyle = REST; c.fillText("PINTU KE LUAR ANGKASA", 180, 86);
    sign.tex.needsUpdate = true;
  };
  const sg = mesh(new THREE.PlaneGeometry(2.3, 0.64), noLine(flat("#ffffff", { map: sign.tex })), false, false);
  sg.position.set(cx - 0.2, T0 + 2.75, z0 + 0.12); g.add(sg);
  boxAt(g, 2.42, 0.76, 0.06, cx - 0.2, T0 + 2.37, z0 + 0.09, M.dark, 0.02, false);

  // inner wall on the corridor side, with the sliding door
  const seg = (x: number, a0: number, a1: number, y0: number, h: number) => {
    if (a1 - a0 > 0.01) boxAt(g, 0.2, h, a1 - a0, x, y0, (a0 + a1) / 2, wallM, 0.04);
  };
  seg(x0, z0, doorZ - doorHalf, T0, WALL_H);
  seg(x0, doorZ + doorHalf, z1, T0, WALL_H);
  seg(x0, doorZ - doorHalf, doorZ + doorHalf, T0 + DOOR_H, WALL_H - DOOR_H);
  const door = new THREE.Group(); door.position.set(x0 + 0.14, T0, doorZ); g.add(door);
  const leaf = new THREE.Group(); door.add(leaf);
  leaf.add(mesh(rbox(0.07, DOOR_H - 0.05, doorHalf * 2, 0.02), plateM).translateY(0.02 + (DOOR_H - 0.05) / 2));
  leaf.add(mesh(new THREE.BoxGeometry(0.08, 0.14, doorHalf * 2 - 0.1), noLine(flat("#ff6fd8")), false, false).translateY(1.2));

  // clear glass front in a slim frame
  const glassM = noLine(toon("#bfe9ff", { transparent: true, opacity: 0.2, depthWrite: false, side: THREE.DoubleSide }));
  const glass = mesh(new THREE.BoxGeometry(w, WALL_H - 0.12, 0.04), glassM, false, false);
  glass.position.set(cx, T0 + 0.07 + (WALL_H - 0.12) / 2, z1); g.add(glass);
  const frameM = thin(toon("#f3efe6"), 0.55);
  for (const y of [T0, T0 + WALL_H - 0.06]) boxAt(g, w, 0.07, 0.1, cx, y, z1, frameM, 0.02, false);
  for (const x of [x0, x1]) boxAt(g, 0.1, WALL_H, 0.1, x, T0, z1, frameM, 0.02, false);

  // outer wall on the building edge, with a hazard frame and the hatch (hinged on its front side, swings out)
  const hz = hazard();
  const hazM = toon("#ffffff", { map: hz.tex });
  seg(x1, z0, doorZ - hatchHalf - 0.12, T0, WALL_H);
  seg(x1, doorZ + hatchHalf + 0.12, z1, T0, WALL_H);
  seg(x1, doorZ - hatchHalf - 0.12, doorZ + hatchHalf + 0.12, T0 + HATCH_H + 0.12, WALL_H - HATCH_H - 0.12);
  for (const s of [-1, 1]) boxAt(g, 0.3, HATCH_H + 0.12, 0.12, x1, T0, doorZ + s * (hatchHalf + 0.06), hazM, 0.02);
  boxAt(g, 0.3, 0.12, hatchHalf * 2 + 0.24, x1, T0 + HATCH_H, doorZ, hazM, 0.02);
  const hatch = new THREE.Group(); hatch.position.set(x1 + 0.12, T0, doorZ + hatchHalf); g.add(hatch);
  const hl = new THREE.Group(); hatch.add(hl);
  const slab = mesh(rbox(0.16, HATCH_H - 0.04, hatchHalf * 2 - 0.04, 0.05), plateM);
  slab.position.set(0, 0.02 + (HATCH_H - 0.04) / 2, -hatchHalf); hl.add(slab);
  const port = mesh(new THREE.CircleGeometry(0.26, 24), noLine(flat("#9fe6ff")), false, false);
  port.rotation.y = Math.PI / 2; port.position.set(0.085, 1.45, -hatchHalf); hl.add(port);
  const portRim = mesh(new THREE.TorusGeometry(0.28, 0.045, 8, 24), M.dark);
  portRim.rotation.y = Math.PI / 2; portRim.position.copy(port.position); hl.add(portRim);
  const wheel = mesh(new THREE.TorusGeometry(0.2, 0.04, 8, 20), M.red);
  wheel.rotation.y = Math.PI / 2; wheel.position.set(0.1, 0.85, -hatchHalf); hl.add(wheel);
  for (const r of [0, Math.PI / 2]) {
    const spoke = mesh(new THREE.BoxGeometry(0.03, 0.4, 0.04), M.red); spoke.rotation.x = r; spoke.position.copy(wheel.position); hl.add(spoke);
  }

  // beacon above the hatch end of the back wall
  const bc = new THREE.Group(); bc.position.set(x1 - 0.55, T0 + BACK_H + 0.07, z0); g.add(bc);
  boxAt(bc, 0.44, 0.1, 0.44, 0, 0, 0, M.dark, 0.03);
  const dome = mesh(new THREE.SphereGeometry(0.2, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), toon("#7a2030")) as ToonMesh;
  dome.position.y = 0.1; bc.add(dome);
  const beams = new THREE.Group(); beams.position.y = 0.2; bc.add(beams);
  const beamGeo = new THREE.ConeGeometry(0.5, 3.2, 16, 1, true); beamGeo.translate(0, -1.6, 0); beamGeo.rotateX(-Math.PI / 2);
  const beamMat = noLine(flat(ALARM, { transparent: true, opacity: 0.26, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
  for (const r of [0, Math.PI]) {
    const bm = new THREE.Mesh(beamGeo, beamMat); bm.rotation.y = r; beams.add(bm);
  }
  beams.visible = false;

  // floor light strips along the back wall and the glass
  const lights = [z0 + 0.17, z1 - 0.1].map((z) => {
    const m = mesh(rbox(w - 0.3, 0.05, 0.08, 0.02), noLine(flat(REST)), false, false) as BasicMesh;
    m.position.set(cx, T0 + 0.04, z); g.add(m);
    return m;
  });

  roomLabel(b, g, "AIRLOCK", cx, T0 + 0.2, z1 + 0.5, "santai");
  return { door: { leaf, open: 0 }, hatch: { leaf: hl, open: 0 }, beacon: { dome, beams }, lights, sign };
}

/** Ease the doors toward their wanted state; the beacon spins and the lights flash while `armed`. */
export function stepAirlock(al: AirlockProp, want: { door: boolean; hatch: boolean; armed: boolean }, t: number, dt: number) {
  al.door.open += ((want.door ? 1 : 0) - al.door.open) * Math.min(1, dt * 7);
  al.door.leaf.position.z = -DOOR_SLIDE * al.door.open;
  // the hatch bursts open and closes slowly
  al.hatch.open += ((want.hatch ? 1 : 0) - al.hatch.open) * Math.min(1, dt * (want.hatch ? 9 : 2.5));
  al.hatch.leaf.rotation.y = -HATCH_SWING * al.hatch.open;
  const flash = want.armed && Math.sin(t * 12) > 0;
  al.beacon.beams.visible = want.armed;
  al.beacon.beams.rotation.y += dt * 6;
  al.beacon.dome.material.color.set(want.armed ? (flash ? "#ff2a3a" : "#ffb3bb") : "#7a2030");
  for (const l of al.lights) l.material.color.set(want.armed ? (flash ? ALARM : "#5a1a2a") : REST);
}
