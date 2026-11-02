import * as THREE from "three";
import { F2 } from "../../constants";
import { canvasTex, mesh, noLine, rbox, type CanvasTex } from "../../scene/kit";
import type { DeskSlot } from "../../nav/places";
import type { Build } from "../structure";

type BasicMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;

export interface Desk {
  group: THREE.Group;
  strip: BasicMesh;
  scr: CanvasTex;
  plate: CanvasTex;
  ring: BasicMesh;
  glow: BasicMesh;
  chair: THREE.Group;
  mug: THREE.Mesh;
  plateName?: string;
}

/** Home desk with monitor, name plate and hover chair (built when an agent gets a slot). */
export function buildDesk(b: Build, g2: THREE.Group, slot: DeskSlot): Desk {
  const { M } = b;
  const { toon, flat } = b.kit;
  const g = new THREE.Group(); g.position.set(slot.x, F2, slot.z); g2.add(g);
  g.add(mesh(rbox(2.7, 0.16, 1.35, 0.06), M.mustard).translateY(1.02));
  for (const sx of [-1.18, 1.18]) {
    const leg = mesh(rbox(0.14, 0.95, 1.15, 0.04), M.dark); leg.position.set(sx, 0.48, 0); g.add(leg);
  }
  const strip = mesh(rbox(2.3, 0.07, 0.05, 0.02), flat("#a6e22e")) as BasicMesh;
  strip.position.set(0, 0.86, 0.62); g.add(strip);
  const mon = new THREE.Group(); mon.position.set(-0.6, 1.1, -0.05); mon.rotation.y = 0.75; g.add(mon);
  mon.add(mesh(new THREE.CylinderGeometry(0.05, 0.18, 0.28, 10), M.dark).translateY(0.12));
  mon.add(mesh(rbox(1.15, 0.74, 0.1, 0.06), M.dark).translateY(0.62));
  const scr = canvasTex(256, 160);
  const screen = mesh(new THREE.PlaneGeometry(1.0, 0.6), noLine(flat("#ffffff", { map: scr.tex })), false, false);
  screen.position.set(0, 0.62, 0.056); mon.add(screen);
  const kb = mesh(rbox(0.75, 0.05, 0.26, 0.02), toon("#e9e3f5")); kb.position.set(0.3, 1.12, -0.28); g.add(kb);
  const mug = mesh(new THREE.CylinderGeometry(0.09, 0.08, 0.18, 12), toon("#ff8fab")); mug.position.set(1.0, 1.19, 0.25); g.add(mug);
  const plate = canvasTex(256, 64);
  const pl = new THREE.Group(); pl.position.set(0.72, 1.2, 0.5); g.add(pl);
  pl.add(mesh(rbox(0.86, 0.24, 0.06, 0.02), M.dark));
  const plFace = mesh(new THREE.PlaneGeometry(0.8, 0.2), noLine(flat("#ffffff", { map: plate.tex })), false, false);
  plFace.position.z = 0.032; pl.add(plFace);
  const chair = new THREE.Group(); chair.position.set(0, 0, -1.05); g.add(chair);
  chair.add(mesh(new THREE.CylinderGeometry(0.58, 0.5, 0.14, 24), toon("#5d4f99")).translateY(0.58));
  const ring = mesh(new THREE.TorusGeometry(0.42, 0.05, 8, 28), noLine(flat("#a6e22e")), false, false) as BasicMesh;
  ring.rotation.x = Math.PI / 2; ring.position.y = 0.36; chair.add(ring);
  const glow = mesh(new THREE.CircleGeometry(0.6, 24), noLine(flat("#a6e22e", { transparent: true, opacity: 0.35 })), false, false) as BasicMesh;
  glow.rotation.x = -Math.PI / 2; glow.position.y = 0.012; chair.add(glow);
  return { group: g, strip, scr, plate, ring, glow, chair, mug };
}
