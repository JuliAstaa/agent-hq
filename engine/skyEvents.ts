// Random sky events (deviation 13). Original designs in the office's own palette:
//  - portal: a pink/cyan ring gate with a starry violet window, far out among the planets; a little yellow courier
//    shuttle (glass dome, a one-eyed pilot, orange fins) flies out and away into deep space, then the gate shuts.
//    It always stays behind the building (user request), never crossing in front of the office.
//  - meteor: a rock with a fiery trail and embers streaking across the sky, sometimes a small shower.
// Where they happen is decided by ./skyPlacement.ts: a random zone (left, center or right), always far behind the
// building, clear of planets, moons and floating rocks, and mostly visible from the current camera (not hidden by
// the building or a UI panel). Decorative only: no store state.
// Sounds are requested through `emit` (the engine forwards them as the DOM event lib/audio.ts listens for).
// Everything an event creates is disposed when the event ends, and on dispose().

import * as THREE from "three";
import type { SfxDetail } from "@/lib/audio";
import { canvasTex, mesh, noLine, rand, rbox, V, wobble, type Kit } from "./scene/kit";
import { planMeteors, planPortal, PORTAL_SIZE, type MeteorPlan, type PlaceCtx, type PortalPlan, type SkyZone } from "./skyPlacement";

export type SkyEventKind = "portal" | "meteor";

export interface SkyEvents {
  update: (dt: number) => void;
  /**
   * Start an event now (random kind and zone when omitted). False while another event is running, or when no
   * clear, visible spot exists from the current camera (it is retried a few seconds later).
   */
  trigger: (kind?: SkyEventKind, zone?: SkyZone) => boolean;
  active: () => SkyEventKind | null;
  /** Zone of the running event (or the last one). */
  zone: () => SkyZone | null;
  dispose: () => void;
}

interface Opts {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** Current camera, obstacles, building silhouette and UI panels, read when an event is placed. */
  place: () => PlaceCtx;
  kit: Kit;
  emit: (d: SfxDetail) => void;
}

/** Seconds until the first event, and between events. */
export const FIRST_DELAY: [number, number] = [25, 50];
export const EVENT_GAP: [number, number] = [45, 120];

const UP = V(0, 1, 0);
const easeOutBack = (k: number) => 1 + 2.4 * Math.pow(k - 1, 3) + 1.4 * Math.pow(k - 1, 2);
const smooth = (k: number) => k * k * (3 - 2 * k);
const clamp01 = (k: number) => Math.min(1, Math.max(0, k));
const bezier = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, k: number, out = new THREE.Vector3()) =>
  out.copy(a).multiplyScalar((1 - k) * (1 - k)).addScaledVector(b, 2 * (1 - k) * k).addScaledVector(c, k * k);

interface Running {
  kind: SkyEventKind;
  /** Advance; false once finished. */
  step: (dt: number) => boolean;
  dispose: () => void;
}

/** Owns every geometry, material and texture an event creates, and frees them together. */
function makeBag(scene: THREE.Scene) {
  const roots: THREE.Object3D[] = [];
  const res = new Set<{ dispose: () => void }>();
  const own = <T extends { dispose: () => void }>(x: T): T => (res.add(x), x);
  const add = (o: THREE.Object3D) => {
    o.traverse((c) => {
      const m = c as THREE.Mesh;
      if (m.geometry) own(m.geometry);
      const mats = m.material ? (Array.isArray(m.material) ? m.material : [m.material]) : [];
      for (const mat of mats) {
        own(mat);
        const map = (mat as THREE.MeshBasicMaterial).map;
        if (map) own(map);
      }
    });
    scene.add(o);
    roots.push(o);
    return o;
  };
  const free = () => {
    for (const r of roots) r.removeFromParent();
    for (const x of res) x.dispose();
    roots.length = 0;
    res.clear();
  };
  return { add, free };
}

/** Tiny glowing particles that fade out (portal sparks, shuttle exhaust puffs, meteor embers). */
function makeParticles(scene: THREE.Scene, kit: Kit) {
  const geo = new THREE.SphereGeometry(1, 8, 6);
  const list: { m: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>; vel: THREE.Vector3; life: number; max: number; size: number }[] = [];
  return {
    spawn(pos: THREE.Vector3, vel: THREE.Vector3, color: string, size: number, life: number) {
      const m = mesh(geo, noLine(kit.flat(color, { transparent: true, depthWrite: false })), false, false) as THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
      m.position.copy(pos);
      m.scale.setScalar(size);
      scene.add(m);
      list.push({ m, vel, life, max: life, size });
    },
    update(dt: number) {
      for (let i = list.length - 1; i >= 0; i--) {
        const p = list[i];
        p.life -= dt;
        if (p.life <= 0) {
          p.m.removeFromParent();
          p.m.material.dispose();
          list.splice(i, 1);
          continue;
        }
        const k = p.life / p.max;
        p.m.position.addScaledVector(p.vel, dt);
        p.vel.multiplyScalar(1 - dt * 1.5);
        p.m.material.opacity = k;
        p.m.scale.setScalar(p.size * (0.4 + 0.6 * k));
      }
    },
    count: () => list.length,
    dispose() {
      for (const p of list) {
        p.m.removeFromParent();
        p.m.material.dispose();
      }
      list.length = 0;
      geo.dispose();
    },
  };
}

function portalWindowTexture() {
  const t = canvasTex(256, 256);
  const c = t.ctx, r = 128;
  const g = c.createRadialGradient(r, r, 4, r, r, r);
  g.addColorStop(0, "#fff6e3");
  g.addColorStop(0.12, "#c3a6ff");
  g.addColorStop(0.45, "#5b2bb5");
  g.addColorStop(0.8, "#2a1060");
  g.addColorStop(1, "#ff6fd8");
  c.fillStyle = g;
  c.fillRect(0, 0, 256, 256);
  c.strokeStyle = "rgba(255,246,227,.22)";
  c.lineWidth = 3;
  for (const rr of [40, 70, 98]) {
    c.beginPath();
    c.arc(r, r, rr, 0, Math.PI * 2);
    c.stroke();
  }
  for (let i = 0; i < 70; i++) {
    const a = Math.random() * Math.PI * 2, d = 20 + Math.random() * 100;
    c.fillStyle = i % 5 ? "rgba(255,246,227,.85)" : "#ffd23f";
    c.beginPath();
    c.arc(r + Math.cos(a) * d, r + Math.sin(a) * d, Math.random() * 2.2 + 0.6, 0, Math.PI * 2);
    c.fill();
  }
  t.tex.needsUpdate = true;
  return t.tex;
}

function buildPortal(kit: Kit) {
  const g = new THREE.Group();
  const win = mesh(new THREE.CircleGeometry(3.0, 48), noLine(kit.flat("#ffffff", { map: portalWindowTexture() })), false, false);
  g.add(win);
  const rim = mesh(new THREE.TorusGeometry(3.1, 0.34, 12, 64), kit.toon("#ff6fd8"), false, false);
  g.add(rim);
  const outer = mesh(new THREE.TorusGeometry(3.75, 0.11, 8, 64), kit.flat("#59c3ff"), false, false);
  g.add(outer);
  const studs = new THREE.Group();
  g.add(studs);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const s = mesh(rbox(0.42, 0.42, 0.42, 0.1), kit.toon("#ffd23f"), false, false);
    s.position.set(Math.cos(a) * 3.45, Math.sin(a) * 3.45, 0);
    s.rotation.z = a;
    studs.add(s);
  }
  return { g, win, rim, outer, studs };
}

function buildShuttle(kit: Kit) {
  const g = new THREE.Group(); // nose along +z
  const body = mesh(new THREE.CapsuleGeometry(0.55, 1.4, 8, 16), kit.toon("#ffd23f"), false, false);
  body.rotation.x = Math.PI / 2;
  g.add(body);
  const band = mesh(new THREE.CylinderGeometry(0.59, 0.59, 0.2, 24), kit.toon("#ff6fd8"), false, false);
  band.rotation.x = Math.PI / 2;
  band.position.z = -0.25;
  g.add(band);
  const dome = mesh(new THREE.SphereGeometry(0.46, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), kit.toon("#9fe6ff", { transparent: true, opacity: 0.6 }), false, false);
  dome.position.set(0, 0.38, 0.3);
  g.add(dome);
  const pilot = mesh(new THREE.SphereGeometry(0.22, 14, 10), kit.toon("#a6e22e"), false, false);
  pilot.position.set(0, 0.45, 0.3);
  g.add(pilot);
  const eye = mesh(new THREE.SphereGeometry(0.1, 10, 8), kit.toon("#ffffff"), false, false);
  eye.position.set(0, 0.5, 0.48);
  g.add(eye);
  const pupil = mesh(new THREE.SphereGeometry(0.045, 8, 6), noLine(kit.flat("#1b1530")), false, false);
  pupil.position.set(0, 0.5, 0.57);
  g.add(pupil);
  for (const s of [-1, 1]) {
    const fin = mesh(rbox(0.9, 0.09, 0.5, 0.04), kit.toon("#ff9f68"), false, false);
    fin.position.set(s * 0.68, -0.05, -0.45);
    fin.rotation.z = s * -0.3;
    g.add(fin);
  }
  const tail = mesh(rbox(0.09, 0.6, 0.5, 0.04), kit.toon("#ff9f68"), false, false);
  tail.position.set(0, 0.5, -0.8);
  g.add(tail);
  const beacon = mesh(new THREE.SphereGeometry(0.08, 8, 6), noLine(kit.flat("#ff4f5e")), false, false);
  beacon.position.set(0, 0.84, -0.8);
  g.add(beacon);
  const nozzle = mesh(new THREE.CylinderGeometry(0.28, 0.36, 0.3, 16), kit.toon("#3d3566"), false, false);
  nozzle.rotation.x = Math.PI / 2;
  nozzle.position.z = -1.2;
  g.add(nozzle);
  const flame = mesh(new THREE.ConeGeometry(0.27, 1.1, 14), noLine(kit.flat("#ffb86b", { transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending })), false, false);
  flame.rotation.x = -Math.PI / 2;
  flame.position.z = -1.9;
  g.add(flame);
  g.scale.setScalar(1.35);
  return { g, flame, beacon };
}

function buildMeteor(kit: Kit, r: number) {
  const g = new THREE.Group();
  const rock = mesh(wobble(new THREE.IcosahedronGeometry(r, 1), 0.2, Math.random() * 10), kit.toon(Math.random() < 0.5 ? "#7a5a46" : "#6b4c8a"), false, false);
  g.add(rock);
  const glow = mesh(new THREE.SphereGeometry(r * 1.45, 16, 12), noLine(kit.flat("#ffb347", { transparent: true, opacity: 0.45, depthWrite: false, blending: THREE.AdditiveBlending })), false, false);
  g.add(glow);
  const trail = new THREE.Group(); // +y points backwards along the path
  g.add(trail);
  const outerGeo = new THREE.ConeGeometry(r * 1.15, r * 8, 18, 1, true);
  outerGeo.translate(0, r * 4, 0);
  trail.add(mesh(outerGeo, noLine(kit.flat("#ff6f3c", { transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending })), false, false));
  const innerGeo = new THREE.ConeGeometry(r * 0.7, r * 5, 14, 1, true);
  innerGeo.translate(0, r * 2.5, 0);
  trail.add(mesh(innerGeo, noLine(kit.flat("#fff2a8", { transparent: true, opacity: 0.7, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending })), false, false));
  return { g, rock, glow, trail };
}

/** Seconds before retrying when no good spot was found. */
export const RETRY_DELAY = 8;

export function createSkyEvents({ scene, camera, place, kit, emit }: Opts): SkyEvents {
  const particles = makeParticles(scene, kit);
  let clock = 0;
  let nextAt = rand(...FIRST_DELAY);
  let running: Running | null = null;
  let lastZone: SkyZone | null = null;
  const tmp = new THREE.Vector3();

  const panOf = (p: THREE.Vector3) => clamp01((tmp.copy(p).project(camera).x + 1) / 2) * 2 - 1;

  function startPortal(plan: PortalPlan): Running {
    const bag = makeBag(scene);
    const side = plan.zone === "left" ? -1 : plan.zone === "right" ? 1 : Math.random() < 0.5 ? -1 : 1;
    const { center, p1, p2 } = plan;
    const P = buildPortal(kit);
    const SIZE = PORTAL_SIZE * plan.scale; // farther spots get bigger, so it reads the same on screen
    const FAR = 0.55; // distant: quieter sounds
    P.g.position.copy(center);
    P.g.lookAt(camera.position);
    P.g.scale.setScalar(0.001);
    bag.add(P.g);
    const S = buildShuttle(kit);
    S.g.visible = false;
    bag.add(S.g);
    const p0 = center.clone();
    const SHIP_SCALE = 2.0 * plan.scale, SHIP_AT = 0.9, SHIP_DUR = 5.6, CLOSE_AT = 3.3, CLOSE_DUR = 0.45, END = SHIP_AT + SHIP_DUR;
    let t = 0, puff = 0, shipSfx = false, closeSfx = false;
    emit({ kind: "portal-open", pan: panOf(center), intensity: FAR });
    for (let i = 0; i < 26; i++) {
      const dir = V(Math.cos((i / 26) * Math.PI * 2), Math.sin((i / 26) * Math.PI * 2), 0).applyQuaternion(P.g.quaternion);
      particles.spawn(center.clone().addScaledVector(dir, 2.6 * SIZE), dir.multiplyScalar(rand(4, 8) * SIZE), i % 2 ? "#ff6fd8" : "#59c3ff", rand(0.08, 0.16) * SIZE, rand(0.6, 1.1));
    }
    const pos = new THREE.Vector3(), ahead = new THREE.Vector3();
    return {
      kind: "portal",
      step(dt) {
        t += dt;
        // gate
        let s = 0;
        if (t < 0.7) s = easeOutBack(clamp01(t / 0.7));
        else if (t < CLOSE_AT) s = 1 + Math.sin(t * 6) * 0.03;
        else s = 1 - smooth(clamp01((t - CLOSE_AT) / CLOSE_DUR));
        P.g.visible = s > 0.002;
        P.g.scale.setScalar(Math.max(0.001, s * SIZE));
        P.win.rotation.z += dt * 1.4;
        P.studs.rotation.z -= dt * 0.8;
        P.outer.rotation.z += dt * 0.5;
        if (t >= CLOSE_AT && !closeSfx) {
          closeSfx = true;
          emit({ kind: "portal-close", pan: panOf(center), intensity: FAR });
        }
        // shuttle
        if (t >= SHIP_AT && t < END) {
          const k = (t - SHIP_AT) / SHIP_DUR;
          if (!shipSfx) {
            shipSfx = true;
            emit({ kind: "ship-pass", pan: panOf(center), intensity: FAR });
          }
          S.g.visible = true;
          const e = smooth(k) * 0.85 + k * 0.15;
          bezier(p0, p1, p2, e, pos);
          pos.y += Math.sin(k * Math.PI * 3) * 0.6 * plan.scale;
          bezier(p0, p1, p2, Math.min(1, e + 0.01), ahead);
          S.g.position.copy(pos);
          S.g.lookAt(ahead);
          S.g.rotateZ(Math.sin(k * Math.PI * 2) * 0.35 * -side);
          S.g.scale.setScalar(SHIP_SCALE * Math.min(1, (t - SHIP_AT) / 0.35));
          S.flame.scale.set(1, 0.8 + Math.random() * 0.5, 1);
          (S.beacon.material as THREE.MeshBasicMaterial).color.set(Math.sin(t * 14) > 0 ? "#ff4f5e" : "#a6e22e");
          puff += dt;
          if (puff > 0.07) {
            puff = 0;
            const back = S.g.localToWorld(V(0, 0, -2.4));
            particles.spawn(back, V(rand(-0.3, 0.3), rand(-0.2, 0.3), rand(-0.3, 0.3)), "#fff6e3", rand(0.12, 0.22) * SHIP_SCALE, 0.7);
          }
        } else S.g.visible = false;
        if (t >= END && t >= CLOSE_AT + CLOSE_DUR) {
          bag.free();
          return false;
        }
        return true;
      },
      dispose: bag.free,
    };
  }

  function startMeteors(plan: MeteorPlan): Running {
    const bag = makeBag(scene);
    // Each rock streaks diagonally down its own pre-checked path and burns out before the end of it.
    const rocks = plan.rocks.map(({ from, to, r }, i) => {
      const m = buildMeteor(kit, r);
      m.g.visible = false;
      bag.add(m.g);
      const vel = to.clone().sub(from);
      const dir = vel.clone().normalize();
      m.trail.quaternion.setFromUnitVectors(UP, dir.clone().negate());
      return { ...m, r, from, to, dir, delay: i === 0 ? 0 : rand(0.35, 0.9) * i, dur: rand(2.4, 3.3), started: false, ember: 0 };
    });
    let t = 0;
    return {
      kind: "meteor",
      step(dt) {
        t += dt;
        let alive = false;
        for (const m of rocks) {
          const lt = t - m.delay;
          if (lt < 0) {
            alive = true;
            continue;
          }
          const k = lt / m.dur;
          if (k >= 1) {
            m.g.visible = false;
            continue;
          }
          alive = true;
          if (!m.started) {
            m.started = true;
            emit({ kind: "meteor", pan: panOf(m.from), intensity: Math.min(1, 0.45 + m.r * 0.4) });
          }
          m.g.visible = true;
          m.g.position.lerpVectors(m.from, m.to, k);
          m.rock.rotation.x += dt * 2.3;
          m.rock.rotation.y += dt * 1.7;
          const fade = k > 0.8 ? 1 - (k - 0.8) / 0.2 : 1; // burns out at the end
          m.g.scale.setScalar(Math.max(0.01, fade));
          (m.glow.material as THREE.MeshBasicMaterial).opacity = 0.35 + Math.sin(t * 30) * 0.1;
          m.ember += dt;
          if (m.ember > 0.035) {
            m.ember = 0;
            const back = m.g.position.clone().addScaledVector(m.dir, -m.r * rand(0.5, 2));
            particles.spawn(back, m.dir.clone().multiplyScalar(-rand(2, 5)).add(V(rand(-1, 1), rand(-1, 1), rand(-1, 1))), Math.random() < 0.6 ? "#ffd23f" : "#ff6fd8", m.r * rand(0.12, 0.22), rand(0.5, 0.9));
          }
        }
        if (!alive) {
          bag.free();
          return false;
        }
        return true;
      },
      dispose: bag.free,
    };
  }

  function trigger(kind?: SkyEventKind, zone?: SkyZone) {
    if (running) return false;
    const k = kind ?? (Math.random() < 0.45 ? "portal" : "meteor");
    if (k === "portal") {
      const plan = planPortal(place(), zone);
      if (!plan) return false;
      lastZone = plan.zone;
      running = startPortal(plan);
    } else {
      const plan = planMeteors(place(), zone, Math.random() < 0.3 ? Math.floor(rand(2, 4.99)) : 1);
      if (!plan) return false;
      lastZone = plan.zone;
      running = startMeteors(plan);
    }
    return true;
  }

  return {
    update(dt) {
      clock += dt;
      if (running && !running.step(dt)) {
        running = null;
        nextAt = clock + rand(...EVENT_GAP);
      }
      if (!running && clock >= nextAt && !trigger()) nextAt = clock + RETRY_DELAY;
      particles.update(dt);
    },
    trigger,
    active: () => running?.kind ?? null,
    zone: () => lastZone,
    dispose() {
      running?.dispose();
      running = null;
      particles.dispose();
    },
  };
}
