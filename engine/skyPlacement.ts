// Where sky events happen (deviation 13). Pure geometry, no DOM, so it is unit-tested.
//
// An event picks a zone of the screen (left, center or right, random), then samples spots in it and keeps one that
//  - is far behind the building (so nothing ever flies in front of or into the office),
//  - stays clear of the planets, moons and floating rocks (no flying through them),
//  - can be seen: never under a UI panel or off screen; partly behind the building's roof or a planet is fine
//    (it is out there behind them, so a portal may peek over the roof), as long as enough of it shows.
// If the chosen zone has no good spot from the current camera (for example the building fills the center on a
// wide screen), the other zones are tried. No good spot anywhere: the event is skipped and retried later.

import * as THREE from "three";
import { rand } from "./scene/kit";

export type SkyZone = "left" | "center" | "right";
export const ZONES: readonly SkyZone[] = ["left", "center", "right"];
/** Screen x range (NDC) of each zone. */
export const ZONE_X: Record<SkyZone, [number, number]> = { left: [-0.94, -0.38], center: [-0.34, 0.34], right: [0.38, 0.94] };

/** A screen area covered by UI, in NDC (x0 < x1, y0 < y1). */
export interface NdcRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface PlaceCtx {
  camera: THREE.PerspectiveCamera;
  /** Solid sky bodies (world space) to keep clear of. */
  obstacles: THREE.Sphere[];
  /** Bodies big enough to hide an event behind them (planets, moons). Defaults to `obstacles`. */
  occluders?: THREE.Sphere[];
  /** Silhouette points of the visible building (slab, walls, rock underneath), world space. */
  building: THREE.Vector3[];
  uiRects: NdcRect[];
}

export interface PortalPlan {
  zone: SkyZone;
  center: THREE.Vector3;
  /** Shuttle path control points (out of the gate, then away into deep space). */
  p1: THREE.Vector3;
  p2: THREE.Vector3;
  /** World size scale: farther spots get bigger so the portal reads the same on screen. */
  scale: number;
  /** Visible fraction of the gate, 0..1. */
  score: number;
}

export interface MeteorPath {
  from: THREE.Vector3;
  to: THREE.Vector3;
  r: number;
}
export interface MeteorPlan {
  zone: SkyZone;
  rocks: MeteorPath[];
  score: number;
}

/** Reference depth the event sizes were designed at. */
export const REF_DEPTH = 97;
/** Portal gate size factor at scale 1, and its radius in world units (outer ring 3.75). */
export const PORTAL_SIZE = 1.6;
export const PORTAL_RADIUS = 3.75 * PORTAL_SIZE;
/** Shuttle bounding radius at scale 1. */
export const SHIP_RADIUS = 2.7;

const shuffle = <T,>(a: T[]) => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const zoneOrder = (first?: SkyZone): SkyZone[] => {
  const z = first ?? ZONES[Math.floor(Math.random() * ZONES.length)];
  return [z, ...shuffle(ZONES.filter((x) => x !== z))];
};

/* ---------------- screen helpers ---------------- */

export function rayPoint(camera: THREE.PerspectiveCamera, nx: number, ny: number, dist: number): THREE.Vector3 {
  const dir = new THREE.Vector3(nx, ny, 0.5).unproject(camera).sub(camera.position).normalize();
  return camera.position.clone().addScaledVector(dir, Math.min(dist, camera.far * 0.9));
}

/** NDC of a world point, or null when it is behind the camera. */
function toNdc(camera: THREE.PerspectiveCamera, p: THREE.Vector3): THREE.Vector2 | null {
  const v = p.clone().applyMatrix4(camera.matrixWorldInverse);
  if (v.z >= -camera.near) return null;
  const n = p.clone().project(camera);
  return new THREE.Vector2(n.x, n.y);
}

/** Convex hull (Andrew's monotone chain), counter-clockwise. */
function hull(points: THREE.Vector2[]): THREE.Vector2[] {
  const p = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cross = (o: THREE.Vector2, a: THREE.Vector2, b: THREE.Vector2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: THREE.Vector2[] = [], upper: THREE.Vector2[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}
function inHull(h: THREE.Vector2[], q: THREE.Vector2): boolean {
  if (h.length < 3) return false;
  for (let i = 0; i < h.length; i++) {
    const a = h[i], b = h[(i + 1) % h.length];
    if ((b.x - a.x) * (q.y - a.y) - (b.y - a.y) * (q.x - a.x) < 0) return false;
  }
  return true;
}

/** Shared per-placement facts: building silhouette on screen, how far "behind the building" is. */
function frame(ctx: PlaceCtx) {
  const { camera } = ctx;
  camera.updateMatrixWorld();
  const center = new THREE.Vector3();
  for (const p of ctx.building) center.add(p);
  center.divideScalar(Math.max(1, ctx.building.length));
  let radius = 0;
  for (const p of ctx.building) radius = Math.max(radius, p.distanceTo(center));
  const pts = ctx.building.map((p) => toNdc(camera, p));
  const silhouette = pts.every(Boolean) ? hull(pts as THREE.Vector2[]) : []; // camera inside the hull: skip
  const centroid = silhouette.length ? silhouette.reduce((s, p) => s.add(p), new THREE.Vector2()).divideScalar(silhouette.length) : new THREE.Vector2();
  // Anything at least this far from the camera is beyond the building's bounding sphere.
  const behind = camera.position.distanceTo(center) + radius;
  return { silhouette, centroid, behind };
}
type Frame = ReturnType<typeof frame>;

/** How a world point (assumed behind the building) shows: in view, behind scenery, or covered by UI/off screen. */
type Sight = "seen" | "behind" | "covered";
function sight(ctx: PlaceCtx, f: Frame, p: THREE.Vector3): Sight {
  const n = toNdc(ctx.camera, p);
  if (!n || Math.abs(n.x) > 0.98 || Math.abs(n.y) > 0.98) return "covered";
  for (const r of ctx.uiRects) if (n.x >= r.x0 && n.x <= r.x1 && n.y >= r.y0 && n.y <= r.y1) return "covered";
  if (inHull(f.silhouette, n)) return "behind";
  // hidden behind a sky body that is nearer than p
  const cam = ctx.camera.position, dir = p.clone().sub(cam), len = dir.length();
  dir.divideScalar(len);
  const ray = new THREE.Ray(cam, dir), hit = new THREE.Vector3();
  for (const s of ctx.occluders ?? ctx.obstacles) if (ray.intersectSphere(s, hit) && hit.distanceTo(cam) < len) return "behind";
  return "seen";
}

/** Portal: share of the gate in view; under a panel or off screen it may only touch the edge. */
const PORTAL_MIN = 0.45, PORTAL_GOOD = 0.85, PORTAL_MAX_COVERED = 2;
/** Meteor: share of its path in view (a quick glimpse between the roof and the panels is fine). */
const METEOR_MIN = 0.3, METEOR_GOOD = 0.75;

/** Shortest distance from point p to segment ab. */
export function segmentDistance(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number {
  const ab = b.clone().sub(a), t = THREE.MathUtils.clamp(p.clone().sub(a).dot(ab) / Math.max(1e-9, ab.lengthSq()), 0, 1);
  return a.clone().addScaledVector(ab, t).distanceTo(p);
}
/** Does a body of radius `r` moving along a..b stay clear of every obstacle (with `margin` to spare)? */
export function pathClear(obstacles: THREE.Sphere[], a: THREE.Vector3, b: THREE.Vector3, r: number, margin = 2): boolean {
  return obstacles.every((s) => segmentDistance(s.center, a, b) > s.radius + r + margin);
}
const bezier = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, k: number) =>
  a.clone().multiplyScalar((1 - k) * (1 - k)).addScaledVector(b, 2 * (1 - k) * k).addScaledVector(c, k * k);

/* ---------------- portal ---------------- */

export function planPortal(ctx: PlaceCtx, zone?: SkyZone, tries = 40): PortalPlan | null {
  const f = frame(ctx);
  const { camera } = ctx;
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
  const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
  let fallback: PortalPlan | null = null;
  for (const [zi, z] of zoneOrder(zone).entries()) {
    let best: PortalPlan | null = null;
    for (let i = 0; i < (zi === 0 ? tries : tries / 2); i++) {
      const nx = rand(...ZONE_X[z]), ny = rand(-0.92, 0.9); // above or beside the building, or under the island
      const dist = f.behind + rand(10, 46);
      const center = rayPoint(camera, nx, ny, dist);
      const scale = center.distanceTo(camera.position) / REF_DEPTH;
      const R = PORTAL_RADIUS * scale;
      if (!ctx.obstacles.every((s) => s.center.distanceTo(center) > s.radius + R + 3)) continue;
      // visible share of the gate: center + 12 rim points (the gate faces the camera)
      const looks = [sight(ctx, f, center)];
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2;
        looks.push(sight(ctx, f, center.clone().addScaledVector(right, Math.cos(a) * R * 0.85).addScaledVector(up, Math.sin(a) * R * 0.85)));
      }
      if (looks.filter((l) => l === "covered").length > PORTAL_MAX_COVERED) continue;
      const score = looks.filter((l) => l === "seen").length / looks.length;
      if (best && score <= best.score) continue;
      // shuttle: away from the building on screen with an upward lean, and deeper (shrinking into space)
      const n = new THREE.Vector2(nx, ny);
      const out = n.clone().sub(f.centroid);
      if (out.lengthSq() < 1e-4) out.set(0, 1);
      // lean up when the gate is above the building's middle, down when it hangs below the island
      const lean = ny >= f.centroid.y ? (z === "center" ? 1.2 : 0.55) : z === "center" ? -1.2 : -0.35;
      out.normalize().add(new THREE.Vector2(0, lean)).normalize();
      const p1 = rayPoint(camera, nx + out.x * 0.12, ny + out.y * 0.12, dist * 1.3);
      const p2 = rayPoint(camera, nx + out.x * 0.32, ny + out.y * 0.32, dist * 2.6);
      let clear = true;
      for (let k = 1; k <= 12 && clear; k++) {
        const a = bezier(center, p1, p2, (k - 1) / 12), b = bezier(center, p1, p2, k / 12);
        clear = pathClear(ctx.obstacles, a, b, SHIP_RADIUS * scale * (1 + (k / 12) * 1.6));
      }
      if (!clear) continue;
      best = { zone: z, center, p1, p2, scale, score };
      if (score >= PORTAL_GOOD) break;
    }
    if (best && best.score >= PORTAL_MIN) return best;
    if (best && (!fallback || best.score > fallback.score)) fallback = best;
  }
  return fallback && fallback.score >= PORTAL_MIN ? fallback : null;
}

/* ---------------- meteors ---------------- */

/** Main rock plus, sometimes, a small shower. Each streaks diagonally down across its zone and burns out. */
export function planMeteors(ctx: PlaceCtx, zone?: SkyZone, count = 1, tries = 40): MeteorPlan | null {
  const f = frame(ctx);
  const { camera } = ctx;
  const path = (nx: number, ny: number, dx: number, dy: number, dist: number, r: number): MeteorPath | null => {
    const from = rayPoint(camera, nx - dx, ny - dy, dist);
    const to = rayPoint(camera, nx + dx * 0.55, ny + dy * 0.55, dist);
    return pathClear(ctx.obstacles, from, to, r * 1.6) ? { from, to, r } : null;
  };
  const seenShare = (p: MeteorPath) => {
    let n = 0;
    for (let k = 0; k < 9; k++) if (sight(ctx, f, p.from.clone().lerp(p.to, 0.2 + (k / 8) * 0.55)) === "seen") n++;
    return n / 9;
  };
  let fallback: MeteorPlan | null = null;
  for (const [zi, z] of zoneOrder(zone).entries()) {
    let best: MeteorPlan | null = null;
    for (let i = 0; i < (zi === 0 ? tries : tries / 2); i++) {
      const nx = rand(...ZONE_X[z]), ny = rand(-0.6, 0.8);
      const sx = z === "left" ? 1 : z === "right" ? -1 : Math.random() < 0.5 ? -1 : 1;
      const dx = sx * rand(0.45, 0.85), dy = -rand(0.7, 1.05);
      const dist = f.behind + rand(10, 48);
      const main = path(nx, ny, dx, dy, dist, rand(1.3, 2.0));
      if (!main) continue;
      const score = seenShare(main);
      if (best && score <= best.score) continue;
      best = { zone: z, rocks: [main], score };
      if (score >= METEOR_GOOD) break;
    }
    if (best && best.score >= METEOR_MIN) {
      // shower: smaller rocks on nearby parallel paths, each checked on its own
      const m = best.rocks[0];
      const n0 = toNdc(camera, m.from.clone().lerp(m.to, 0.645))!; // the main rock's aim point
      const dirN = toNdc(camera, m.to)!.sub(toNdc(camera, m.from)!);
      for (let k = 1; k < count; k++) {
        for (let tryK = 0; tryK < 5; tryK++) {
          const ex = path(n0.x + rand(-0.14, 0.14), n0.y + rand(-0.1, 0.1), dirN.x / 1.55, dirN.y / 1.55, m.from.distanceTo(camera.position) + rand(-6, 6), rand(0.6, 1.1));
          if (ex) {
            best.rocks.push(ex);
            break;
          }
        }
      }
      return best;
    }
    if (best && (!fallback || best.score > fallback.score)) fallback = best;
  }
  return fallback && fallback.score >= METEOR_MIN ? fallback : null;
}
