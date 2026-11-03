// Geometry / material / canvas helpers (port of the "helpers" block in references/agent-hq.html).
// createKit() is per engine instance: the toon gradient map is a GPU texture that must be disposed.

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";

export const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
export const rand = (a: number, b: number) => a + Math.random() * (b - a);
export const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)];

export type MatExtra = Partial<THREE.MeshToonMaterialParameters & THREE.MeshBasicMaterialParameters>;
type Mat = THREE.Material & { userData: Record<string, unknown> };

export interface CanvasTex {
  c: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  tex: THREE.CanvasTexture;
  draw?: () => void;
}

export function shade(hex: string, amt: number): string {
  const c = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  c.setHSL(hsl.h, hsl.s, Math.max(0, Math.min(1, hsl.l + amt)));
  return "#" + c.getHexString();
}

export function lerpAngle(a: number, b: number, k: number): number {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * Math.min(1, k);
}

export function canvasTex(w: number, h: number): CanvasTex {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return { c, ctx: c.getContext("2d")!, tex };
}

export const noLine = <T extends Mat>(m: T): T => {
  m.userData.outlineParameters = { visible: false };
  return m;
};
export const thin = <T extends Mat>(m: T, k = 0.6): T => {
  m.userData.outlineParameters = { thickness: 0.0038 * k };
  return m;
};

export function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, cast = true, receive = true): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = cast;
  m.receiveShadow = receive;
  return m;
}

export const rbox = (w: number, h: number, d: number, r = 0.08) =>
  new RoundedBoxGeometry(w, h, d, 3, Math.max(0.005, Math.min(r, w / 2 - 0.002, h / 2 - 0.002, d / 2 - 0.002)));

/** Box with its bottom at y0. */
export function boxAt(parent: THREE.Object3D, w: number, h: number, d: number, x: number, y0: number, z: number, mat: THREE.Material, r = 0.06, cast = true) {
  const m = mesh(rbox(w, h, d, r), mat, cast);
  m.position.set(x, y0 + h / 2, z);
  parent.add(m);
  return m;
}

export function cyl(parent: THREE.Object3D, rt: number, rb: number, h: number, x: number, y0: number, z: number, mat: THREE.Material, seg = 20) {
  const m = mesh(new THREE.CylinderGeometry(rt, rb, h, seg), mat);
  m.position.set(x, y0 + h / 2, z);
  parent.add(m);
  return m;
}

/** Organic noise displacement along the vertex direction. */
export function wobble(geo: THREE.BufferGeometry, amt = 0.05, seed = 1): THREE.BufferGeometry {
  geo.deleteAttribute("uv");
  const merged = mergeVertices(geo);
  geo.dispose();
  const p = merged.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n = Math.sin(v.x * 3.1 + seed) * Math.cos(v.y * 2.7 + seed * 1.3) * Math.sin(v.z * 3.3 + seed * 0.7) + 0.5 * Math.sin(v.x * 6.3 - seed * 2.1 + v.z * 5.1);
    v.multiplyScalar(1 + n * amt);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  merged.computeVertexNormals();
  return merged;
}

export interface Kit {
  gradientMap: THREE.DataTexture;
  toon: (color: THREE.ColorRepresentation, extra?: MatExtra) => THREE.MeshToonMaterial;
  flat: (color: THREE.ColorRepresentation, extra?: MatExtra) => THREE.MeshBasicMaterial;
}

export function createKit(): Kit {
  // 3-step toon shading.
  const gradientMap = new THREE.DataTexture(new Uint8Array([80, 165, 255]), 3, 1, THREE.RedFormat);
  gradientMap.minFilter = gradientMap.magFilter = THREE.NearestFilter;
  gradientMap.needsUpdate = true;
  return {
    gradientMap,
    toon: (color, extra = {}) => new THREE.MeshToonMaterial({ color, gradientMap, shadowSide: THREE.FrontSide, ...(extra as THREE.MeshToonMaterialParameters) }),
    flat: (color, extra = {}) => new THREE.MeshBasicMaterial({ color, ...(extra as THREE.MeshBasicMaterialParameters) }),
  };
}

export type Materials = ReturnType<typeof createMaterials>;

export function createMaterials({ toon }: Kit) {
  return {
    wall1: toon("#76c2ae"), wall2: toon("#8fb9e8"), part: toon("#f2d6a2"), trim: toon("#f6e8c6"), dark: toon("#3d3566"),
    slab: toon("#3d2e6b"), wood: toon("#c98a4b"), woodD: toon("#8a5a32"), mustard: toon("#f2b84b"),
    sofa: toon("#ff6f91"), sofa2: toon("#ff8fab"), teal: toon("#59c3ff"), lilac: toon("#c3a6ff"), white: toon("#fff6e3"),
    red: toon("#ff4f5e"), yellow: toon("#ffd23f"), green: toon("#8bd450"), steel: toon("#cfd3e6"),
    redWall: toon("#5a2a4a"), repWall: toon("#e9d8b4"), socWall: toon("#24345e"),
  };
}
