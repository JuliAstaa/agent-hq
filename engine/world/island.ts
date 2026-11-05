// The island and its three tiers (deviation 29): slab and rock, tier platforms with risers, stairs, railings along the
// open edges, the outer left wall per tier, and the floor of every area. Room walls and furniture are built by the
// area builders (santai.ts, kantor.ts, security.ts, meeting.ts, server.ts).

import * as THREE from "three";
import { boxAt, canvasTex, mesh, noLine, rbox, V, wobble } from "../scene/kit";
import { STAIRS, STAIR_DEPTH, STAIR_STEPS, T0, T1, T2, X_LEFT, X_RIGHT, X_SEC_END, X_SERVER, Z_BACK, Z_FRONT, Z_RISER_B, Z_RISER_F, type Stair } from "../layout";
import { floorPlane, floorTexture, makeWall, plankTexture, rail, type Build } from "./structure";

/** Inner face of the left wall, and the slab lip around the open edges. */
const X_IN = X_LEFT + 0.2;
const LIP = 0.6;

function tileTexture(base: string, alt: string, line: string) {
  const t = canvasTex(128, 128);
  const c = t.ctx;
  c.fillStyle = base; c.fillRect(0, 0, 128, 128);
  c.fillStyle = alt; c.fillRect(0, 0, 64, 64); c.fillRect(64, 64, 64, 64);
  c.strokeStyle = line; c.lineWidth = 2; c.strokeRect(1, 1, 126, 126);
  t.tex.wrapS = t.tex.wrapT = THREE.RepeatWrapping;
  return t.tex;
}

/** Raised server floor: grey-blue tiles, every third one perforated. */
function serverFloorTexture() {
  const t = canvasTex(192, 192);
  const c = t.ctx;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    c.fillStyle = (i + j) % 2 ? "#3b4a6b" : "#34425f";
    c.fillRect(i * 64, j * 64, 64, 64);
    c.strokeStyle = "rgba(150,200,255,.25)"; c.lineWidth = 2; c.strokeRect(i * 64 + 1, j * 64 + 1, 62, 62);
    if ((i + 2 * j) % 3 === 0) {
      c.fillStyle = "rgba(10,14,30,.55)";
      for (let a = 0; a < 6; a++) for (let b2 = 0; b2 < 6; b2++) c.fillRect(i * 64 + 10 + a * 8, j * 64 + 10 + b2 * 8, 4, 4);
    }
  }
  t.tex.wrapS = t.tex.wrapT = THREE.RepeatWrapping;
  return t.tex;
}

function grassTexture() {
  const t = canvasTex(256, 256);
  const c = t.ctx;
  c.fillStyle = "#6fbf5a"; c.fillRect(0, 0, 256, 256);
  for (let k = 0; k < 900; k++) {
    c.fillStyle = Math.random() < 0.5 ? "#62b14f" : "#7fcd67";
    c.fillRect(Math.random() * 256, Math.random() * 256, 3, 5 + Math.random() * 4);
  }
  t.tex.wrapS = t.tex.wrapT = THREE.RepeatWrapping;
  return t.tex;
}

/** Repeat a shared texture over a floor of w x d units, `unit` units per repeat. */
function tiled(b: Build, tex: THREE.Texture, w: number, d: number, unit: number) {
  const t = tex.clone();
  t.repeat.set(w / unit, d / unit);
  t.needsUpdate = true;
  b.looseTextures.push(t);
  return t;
}

export function buildIsland(b: Build, world: THREE.Group) {
  const { M } = b;
  const { toon } = b.kit;
  const x0 = X_LEFT - 0.8, x1 = X_RIGHT, z0 = Z_BACK - 0.6, z1 = Z_FRONT + LIP;
  // slab + rock underneath (scaled up from the prototype's island)
  world.add(mesh(rbox(x1 - x0, 0.8, z1 - z0, 0.22), M.slab).translateX((x0 + x1) / 2).translateZ((z0 + z1) / 2).translateY(-0.4));
  const rock = mesh(wobble(new THREE.ConeGeometry(30, 15, 20, 7), 0.08, 3), toon("#6b4c8a"), true, false);
  rock.scale.set(1, 1, 0.64);
  rock.rotation.x = Math.PI;
  rock.position.set(0, -8.3, (z0 + z1) / 2);
  world.add(rock);
  const rock2 = mesh(wobble(new THREE.ConeGeometry(9, 9, 12, 4), 0.12, 8), toon("#5a3f78"), false, false);
  rock2.rotation.x = Math.PI;
  rock2.position.set(7, -17, -1);
  world.add(rock2);

  // tier platforms: the middle tier on the slab, the back tier on top of that height. Their fronts are the risers.
  const riserM = toon("#5d4c9a");
  boxAt(world, x1 - (X_LEFT - 0.2), T1, Z_RISER_F - Z_RISER_B, (X_LEFT - 0.2 + x1) / 2, 0, (Z_RISER_B + Z_RISER_F) / 2, riserM, 0.04, false);
  boxAt(world, x1 - (X_LEFT - 0.2), T2, Z_RISER_B - z0, (X_LEFT - 0.2 + x1) / 2, 0, (z0 + Z_RISER_B) / 2, riserM, 0.04, false);
  // cap trim along the riser tops
  for (const [z, y] of [[Z_RISER_F, T1], [Z_RISER_B, T2]] as const) boxAt(world, x1 - X_IN, 0.1, 0.3, (X_IN + x1) / 2, y - 0.08, z, M.trim, 0.03, false);

  // floors per area
  const beige = floorTexture(13, 8, "#e7d3a8", "#f6e8c6");
  beige.wrapS = beige.wrapT = THREE.RepeatWrapping;
  b.looseTextures.push(beige);
  floorPlane(b, world, X_IN, x1, Z_RISER_F, z1, T0, tiled(b, beige, x1 - X_IN, z1 - Z_RISER_F, 26));
  const plank = plankTexture();
  plank.wrapS = plank.wrapT = THREE.RepeatWrapping;
  b.looseTextures.push(plank);
  const X_GARDEN = 5.6;
  floorPlane(b, world, X_IN, X_GARDEN, Z_RISER_B, Z_RISER_F, T1, tiled(b, plank, X_GARDEN - X_IN, Z_RISER_F - Z_RISER_B, 5.5));
  const grass = grassTexture();
  b.looseTextures.push(grass);
  floorPlane(b, world, X_GARDEN, x1, Z_RISER_B, Z_RISER_F, T1, tiled(b, grass, x1 - X_GARDEN, Z_RISER_F - Z_RISER_B, 6));
  const secTile = tileTexture("#2f2858", "#383066", "rgba(160,140,255,.18)");
  b.looseTextures.push(secTile);
  floorPlane(b, world, X_IN, X_SEC_END, Z_BACK + 0.2, Z_RISER_B, T2, tiled(b, secTile, X_SEC_END - X_IN, Z_RISER_B - Z_BACK, 4));
  const meetTile = tileTexture("#2f5d66", "#356872", "rgba(190,255,240,.14)");
  b.looseTextures.push(meetTile);
  floorPlane(b, world, X_SEC_END, X_SERVER, Z_BACK + 0.2, Z_RISER_B, T2, tiled(b, meetTile, X_SERVER - X_SEC_END, Z_RISER_B - Z_BACK, 4));
  const srvTile = serverFloorTexture();
  b.looseTextures.push(srvTile);
  floorPlane(b, world, X_SERVER, x1, Z_BACK + 0.2, Z_RISER_B, T2, tiled(b, srvTile, x1 - X_SERVER, Z_RISER_B - Z_BACK, 3));

  // stairs
  for (const s of STAIRS) buildStair(b, world, s);

  // railings along the riser edges (gaps at the stairs) and along the open right edge of the upper tiers
  const gaps = (z: number) => STAIRS.filter((s) => s.riserZ === z).map((s) => [s.x - s.width / 2 - 0.15, s.x + s.width / 2 + 0.15] as const);
  railing(b, world, "x", Z_RISER_F - 0.12, X_IN + 0.3, x1 - 0.3, T1, gaps(Z_RISER_F));
  railing(b, world, "x", Z_RISER_B - 0.12, X_IN + 0.3, X_SERVER - 0.2, T2, gaps(Z_RISER_B).filter(([a]) => a < X_SERVER));
  railing(b, world, "x", Z_RISER_B - 0.12, X_SERVER + 0.2, x1 - 0.3, T2, gaps(Z_RISER_B).filter(([a]) => a > X_SERVER));
  railing(b, world, "z", x1 - 0.25, Z_RISER_B + 0.3, Z_RISER_F - 0.3, T1, []);

  // outer left wall, one section per tier (front: lobby teal, middle: office blue, back: built by Security)
  makeWall(b, world, "z", X_LEFT, Z_RISER_F, Z_FRONT, T0, 5.2, [{ a0: 9.4, a1: 12.8, y0: 1.7, y1: 4.0 }], M.wall1);
  boxAt(world, 0.48, 0.25, Z_FRONT - Z_RISER_F, X_LEFT, T0, (Z_RISER_F + Z_FRONT) / 2, M.dark, 0.04);
  makeWall(b, world, "z", X_LEFT, Z_RISER_B, Z_RISER_F, T1, 5.2, [], M.wall2);
  boxAt(world, 0.48, 0.25, Z_RISER_F - Z_RISER_B, X_LEFT, T1, (Z_RISER_B + Z_RISER_F) / 2, M.dark, 0.04);
}

/** Steps from `lo` at riserZ + STAIR_DEPTH up to `hi` at the riser, each a block standing on the lower tier. */
function buildStair(b: Build, parent: THREE.Object3D, s: Stair) {
  const { M } = b;
  const rise = (s.hi - s.lo) / STAIR_STEPS, run = STAIR_DEPTH / STAIR_STEPS;
  for (let k = 1; k <= STAIR_STEPS; k++) {
    const front = s.riserZ + run * (STAIR_STEPS - k + 1);
    boxAt(parent, s.width, rise * k, front - s.riserZ + 0.02, s.x, s.lo, (s.riserZ + front) / 2 - 0.01, k % 2 ? M.wood : M.woodD, 0.03, false);
  }
  // hand rails on both sides, following the slope
  for (const side of [-1, 1]) {
    const x = s.x + side * (s.width / 2 + 0.06);
    const bot = V(x, s.lo, s.riserZ + STAIR_DEPTH), top = V(x, s.hi, s.riserZ);
    for (const p of [bot, top]) rail(b, parent, p, p.clone().setY(p.y + 1.0), 0.05);
    rail(b, parent, bot.clone().setY(bot.y + 1.0), top.clone().setY(top.y + 1.0), 0.06, M.red);
  }
}

/** Posts every ~1.2 and a red top rail, along `axis` at `c`, from a0 to a1, skipping the [g0, g1] gaps. */
function railing(b: Build, parent: THREE.Object3D, axis: "x" | "z", c: number, a0: number, a1: number, y: number, gaps: readonly (readonly [number, number])[]) {
  const P = (a: number, yy: number) => (axis === "x" ? V(a, yy, c) : V(c, yy, a));
  const spans: [number, number][] = [];
  let cur = a0;
  for (const [g0, g1] of [...gaps].sort((p, q) => p[0] - q[0])) {
    if (g0 > cur) spans.push([cur, g0]);
    cur = Math.max(cur, g1);
  }
  if (a1 > cur) spans.push([cur, a1]);
  for (const [s0, s1] of spans) {
    if (s1 - s0 < 0.3) continue;
    const n = Math.max(1, Math.round((s1 - s0) / 1.2));
    for (let i = 0; i <= n; i++) rail(b, parent, P(s0 + ((s1 - s0) * i) / n, y), P(s0 + ((s1 - s0) * i) / n, y + 1.0), 0.045);
    rail(b, parent, P(s0, y + 1.0), P(s1, y + 1.0), 0.06, b.M.red);
  }
}

/** Shared by the area builders: a plain colored rug on the floor of tier `y`. */
export function rug(b: Build, parent: THREE.Object3D, x0: number, x1: number, z0: number, z1: number, y: number, color: string) {
  const m = mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0), noLine(b.kit.toon(color)), false, true);
  m.rotation.x = -Math.PI / 2;
  m.position.set((x0 + x1) / 2, y + 0.012, (z0 + z1) / 2);
  parent.add(m);
  return m;
}
