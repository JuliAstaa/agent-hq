// Walls, partitions, rails, floor planes and room labels (port from references/agent-hq.html).

import * as THREE from "three";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { canvasTex, mesh, noLine, rbox, V, type Kit, type Materials } from "../scene/kit";

export interface RoomLabel {
  o: CSS2DObject;
  floor: number;
}

export interface Build {
  kit: Kit;
  M: Materials;
  roomLabels: RoomLabel[];
  /** Textures not attached to any material (disposed with the engine). */
  looseTextures: THREE.Texture[];
}

export function roomLabel(b: Build, parent: THREE.Object3D, text: string, x: number, y: number, z: number, floor: number) {
  const el = document.createElement("div");
  el.className = "room";
  el.textContent = text;
  const o = new CSS2DObject(el);
  o.position.set(x, y, z);
  parent.add(o);
  b.roomLabels.push({ o, floor });
  return o;
}

export function floorTexture(nx: number, nz: number, c1: string, c2: string, W = 512, H = 320, speck = true) {
  const { ctx, tex } = canvasTex(W, H);
  const sw = W / nx, sh = H / nz;
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
    ctx.fillStyle = (i + j) % 2 ? c1 : c2;
    ctx.fillRect(i * sw, j * sh, sw + 1, sh + 1);
  }
  if (speck) {
    ctx.globalAlpha = 0.07;
    ctx.fillStyle = "#5a3d1e";
    for (let k = 0; k < 400; k++) ctx.fillRect(Math.random() * W, Math.random() * H, 2 + Math.random() * 3, 2 + Math.random() * 3);
    ctx.globalAlpha = 1;
  }
  return tex;
}

export function plankTexture() {
  const { ctx, tex } = canvasTex(512, 512);
  for (let r = 0; r < 16; r++) {
    const y = r * 32;
    ctx.fillStyle = r % 2 ? "#d9a066" : "#cf955b";
    ctx.fillRect(0, y, 512, 32);
    ctx.fillStyle = "rgba(90,50,20,.35)";
    ctx.fillRect(0, y, 512, 2);
    const off = (r * 137) % 512;
    ctx.fillRect(off, y, 2, 32);
    ctx.fillRect((off + 256) % 512, y, 2, 32);
  }
  return tex;
}

export function floorPlane(b: Build, parent: THREE.Object3D, x0: number, x1: number, z0: number, z1: number, y: number, tex: THREE.Texture) {
  const m = mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0), noLine(b.kit.toon("#ffffff", { map: tex })), false, true);
  m.rotation.x = -Math.PI / 2;
  m.position.set((x0 + x1) / 2, y + 0.006, (z0 + z1) / 2);
  parent.add(m);
  return m;
}

export interface Hole {
  a0: number;
  a1: number;
  y0: number;
  y1: number;
}

/** Wall along axis 'x' (at z = c) or 'z' (at x = c), with framed window holes. */
export function makeWall(b: Build, parent: THREE.Object3D, axis: "x" | "z", c: number, a0: number, a1: number, y0: number, h: number, holes: Hole[], mat: THREE.Material, t = 0.4, cast = true) {
  const seg = (s0: number, s1: number, yy0: number, yy1: number, m = mat, tt = t, r = 0.04) => {
    if (s1 - s0 < 0.01 || yy1 - yy0 < 0.01) return;
    const len = s1 - s0, hh = yy1 - yy0, mid = (s0 + s1) / 2;
    const w = mesh(axis === "x" ? rbox(len, hh, tt, r) : rbox(tt, hh, len, r), m, cast);
    if (axis === "x") w.position.set(mid, yy0 + hh / 2, c);
    else w.position.set(c, yy0 + hh / 2, mid);
    parent.add(w);
  };
  const T0 = b.M.trim;
  let cur = a0;
  for (const hl of [...holes].sort((p, q) => p.a0 - q.a0)) {
    seg(cur, hl.a0, y0, y0 + h);
    seg(hl.a0, hl.a1, y0, hl.y0);
    seg(hl.a0, hl.a1, hl.y1, y0 + h);
    const T = t + 0.14;
    seg(hl.a0 - 0.1, hl.a1 + 0.1, hl.y0 - 0.12, hl.y0 + 0.06, T0, T, 0.03);
    seg(hl.a0 - 0.1, hl.a1 + 0.1, hl.y1 - 0.06, hl.y1 + 0.12, T0, T, 0.03);
    seg(hl.a0 - 0.1, hl.a0 + 0.07, hl.y0, hl.y1, T0, T, 0.03);
    seg(hl.a1 - 0.07, hl.a1 + 0.1, hl.y0, hl.y1, T0, T, 0.03);
    const mid = (hl.a0 + hl.a1) / 2;
    seg(mid - 0.05, mid + 0.05, hl.y0, hl.y1, T0, T * 0.7, 0.02);
    seg(hl.a0, hl.a1, (hl.y0 + hl.y1) / 2 + 0.2, (hl.y0 + hl.y1) / 2 + 0.28, T0, T * 0.7, 0.02);
    cur = hl.a1;
  }
  seg(cur, a1, y0, y0 + h);
}

export function partition(b: Build, parent: THREE.Object3D, axis: "x" | "z", c: number, a0: number, a1: number, y0: number, h = 1.25) {
  makeWall(b, parent, axis, c, a0, a1, y0, h, [], b.M.part, 0.24);
  makeWall(b, parent, axis, c, a0 - 0.06, a1 + 0.06, y0 + h, 0.1, [], b.M.trim, 0.36);
}

export function rail(b: Build, parent: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3, r = 0.06, mat: THREE.Material = b.M.dark) {
  const d = to.clone().sub(from), len = d.length();
  const m = mesh(new THREE.CylinderGeometry(r, r, len, 8), mat);
  m.position.copy(from).addScaledVector(d, 0.5);
  m.quaternion.setFromUnitVectors(V(0, 1, 0), d.normalize());
  parent.add(m);
  return m;
}
