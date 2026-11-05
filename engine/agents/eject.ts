// Kicked agents (prd.md §7.10). A small escort drone leads the agent to the Airlock on floor 4. Inside, the inner
// door shuts and the alarm goes; then the hatch swings open and the agent is blown out, tumbling away into space
// toward the yellow moon until it twinkles out. The store has already dropped the agent: the engine hands its
// runtime over here (out of its agent map), so a returning agent can get a new avatar while this one still flies.

import * as THREE from "three";
import { F4, INK } from "../constants";
import { lerpAngle, mesh, noLine, V, type Kit, type Materials } from "../scene/kit";
import { AIRLOCK, type AirlockPlace } from "../nav/places";
import { route } from "../nav/router";
import { stepAirlock, type AirlockProp } from "../world/airlock";
import type { AgentRuntime } from "./animate";
import { floorAtY } from "./movement";
import type { SfxDetail } from "@/lib/audio";
import type { FloorMode } from "@/lib/store";

export type EjectPhase = "walk" | "wait" | "launch" | "fly" | "gone";

interface Drone {
  root: THREE.Group;
  rotor: THREE.Group;
  lamp: THREE.MeshBasicMaterial;
  /** Tractor beam from the drone down to the agent's head while it leads the way. */
  beam: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>;
  /** Pop-in 0..1; `leave` counts up once its agent is gone, then it flies off. */
  pop: number;
  leave: number;
}

export interface Eject {
  rt: AgentRuntime;
  phase: EjectPhase;
  /** Seconds in the current phase. */
  t: number;
  spot: AirlockPlace;
  drone: Drone;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
}

interface Twinkle {
  m: THREE.Mesh<THREE.ShapeGeometry, THREE.MeshBasicMaterial>;
  t: number;
}

export interface EjectCtx {
  world: THREE.Group;
  kit: Kit;
  M: Materials;
  camera: THREE.Camera;
  airlock: AirlockProp;
  spots: AirlockPlace[];
  smoke: (pos: THREE.Vector3, color?: string, size?: number, rise?: number) => void;
  sfx: (detail: SfxDetail) => void;
  /** Take the avatar out of the scene and free it (label DOM, geometry, materials). */
  dispose: (obj: THREE.Object3D, rt?: AgentRuntime) => void;
}

export interface View {
  floorMode: FloorMode;
  meetingHidden: boolean;
}

/** Walking speed to the Airlock (as fast as an urgent agent), seconds inside before launch, flight time. */
const SPEED = 4.6, WAIT = 1.4, FLY = 3.0;
/** Where the hatch lets out (mid height, just outside) and the way into space: up and to the right on screen in
 *  every floor view, a little away from the camera, so the agent shrinks and twinkles out before it leaves the frame. */
const EXIT = V(AIRLOCK.x1 + 0.3, F4 + 1.0, AIRLOCK.doorZ);
const AWAY = V(0.25, 0.85, -0.45).normalize();
/** The drone is a bit bigger than life so it reads next to the agent. */
const DRONE_SCALE = 1.5;
/** Outside the inner door: where the drone waits while the Airlock cycles. */
const DRONE_POST = V(AIRLOCK.x0 - 0.75, F4 + 2.1, AIRLOCK.doorZ);
const DOOR = V(AIRLOCK.x0, F4, AIRLOCK.doorZ);

export function createEjector(ctx: EjectCtx) {
  const list: Eject[] = [];
  const twinkles: Twinkle[] = [];
  const { toon, flat } = ctx.kit;
  const tmp = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);

  function buildDrone(at: THREE.Vector3): Drone {
    const root = new THREE.Group();
    root.position.copy(at);
    root.scale.setScalar(0.01);
    const body = mesh(new THREE.SphereGeometry(0.26, 20, 14), toon("#5d4f99"));
    body.scale.set(1, 0.8, 1); root.add(body);
    const band = mesh(new THREE.TorusGeometry(0.26, 0.04, 8, 24), noLine(flat("#ff6fd8")), false, false);
    band.rotation.x = Math.PI / 2; root.add(band);
    const eye = mesh(new THREE.SphereGeometry(0.1, 14, 10), toon("#ffffff")); eye.position.set(0, 0.03, 0.2); root.add(eye);
    const pupil = mesh(new THREE.SphereGeometry(0.05, 10, 8), noLine(flat(INK)), false, false); pupil.position.set(0, 0.03, 0.29); root.add(pupil);
    const lampMat = noLine(flat("#ff4f5e"));
    const lamp = mesh(new THREE.SphereGeometry(0.06, 10, 8), lampMat, false, false); lamp.position.y = 0.3; root.add(lamp);
    root.add(mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.14, 6), ctx.M.dark).translateY(0.22));
    const rotor = new THREE.Group(); rotor.position.y = 0.38; root.add(rotor);
    for (const r of [0, Math.PI / 2]) {
      const blade = mesh(new THREE.BoxGeometry(0.6, 0.02, 0.06), ctx.M.dark); blade.rotation.y = r; rotor.add(blade);
    }
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.035, 0.12, 1, 10, 1, true),
      noLine(flat("#ff6fd8", { transparent: true, opacity: 0.45, depthWrite: false, side: THREE.DoubleSide })),
    );
    beam.visible = false;
    ctx.world.add(root, beam);
    return { root, rotor, lamp: lampMat, beam, pop: 0, leave: 0 };
  }

  /** Take over a kicked agent's runtime and start the walk. Without the meeting floor (tests) it just goes poof. */
  function start(rt: AgentRuntime, meetingHidden: boolean) {
    const v = rt.av;
    v.root.scale.setScalar(1);
    delete v.spawn;
    for (const o of Object.values(v.P)) o.visible = false;
    v.chatLabel.visible = false;
    v.chatEl.classList.remove("on");
    v.el.classList.remove("sel", "chill");
    v.el.style.pointerEvents = "none";
    v.el.style.opacity = "1";
    (v.el.querySelector(".tt") as HTMLElement).textContent = "· diantar ke Airlock";
    if (meetingHidden) {
      ctx.smoke(v.root.position.clone().add(V(0, v.cy, 0)), "#e6f6ff", 1.2, 0.6);
      ctx.dispose(v.root, rt);
      return;
    }
    const busy = new Set(list.filter((e) => e.phase !== "fly" && e.phase !== "gone").map((e) => e.spot));
    const spot = ctx.spots.find((s) => !busy.has(s)) ?? ctx.spots[list.length % ctx.spots.length];
    const mv = rt.mv;
    mv.dest = spot;
    mv.path = route(mv.lastRef, spot);
    mv.mode = "walk";
    mv.speed = SPEED;
    mv.urgent = true;
    mv.activity = null;
    mv.fetching = mv.carrying = mv.hasMug = false;
    const drone = buildDrone(v.root.position.clone().add(V(0, v.top + 1.6, 0)));
    list.push({ rt, phase: "walk", t: 0, spot, drone, vel: new THREE.Vector3(), spin: V(rnd(3, 6), rnd(-2, 2), rnd(5, 9)) });
  }

  /** The agent came back before its launch: the leaving avatar goes poof, the new one (at its desk) takes over. */
  function cancel(id: string) {
    for (const e of list) {
      if (e.rt.id !== id || (e.phase !== "walk" && e.phase !== "wait")) continue;
      ctx.smoke(e.rt.root.position.clone().add(V(0, e.rt.av.cy, 0)), "#e6f6ff", 1.2, 0.6);
      ctx.dispose(e.rt.root, e.rt);
      next(e, "gone");
    }
  }

  function update(dt: number, t: number, view: View) {
    const walkerNear = list.some((e) => e.phase === "walk" && onFloor4(e.rt.root.position) && flatDist(e.rt.root.position, DOOR) < 3.6);
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      e.t += dt;
      const pos = e.rt.root.position;
      if (e.phase === "walk") {
        if (followPath(e.rt, dt)) next(e, "wait");
        else walkPose(e.rt, t, dt);
      } else if (e.phase === "wait") {
        e.rt.mv.yaw = e.spot.face;
        e.rt.root.rotation.y = lerpAngle(e.rt.root.rotation.y, e.spot.face, dt * 8);
        panicPose(e.rt, t, dt, ctx.camera);
        if (e.t >= WAIT && ctx.airlock.door.open < 0.06 && !walkerNear) {
          next(e, "launch");
          ctx.sfx({ kind: "airlock", pan: panOf(EXIT) });
        }
      } else if (e.phase === "launch") {
        panicPose(e.rt, t * 1.6, dt, ctx.camera);
        if (e.t >= 0.5 && ctx.airlock.hatch.open > 0.6) {
          // decompression: pulled toward the hatch, faster and faster, tumbling
          if (e.vel.lengthSq() === 0) for (let k = 0; k < 6; k++) ctx.smoke(EXIT.clone().add(V(rnd(0, 1.2), rnd(-0.6, 0.8), rnd(-0.7, 0.7))), "#e6f6ff", 0.9, 0.4);
          tmp.set(1, 0, (EXIT.z - pos.z) * 0.8).normalize();
          e.vel.addScaledVector(tmp, 30 * dt);
          e.vel.y += 4 * dt;
          pos.addScaledVector(e.vel, dt);
          tumble(e, dt, 0.6);
          if (pos.x > AIRLOCK.x1 + 0.4) next(e, "fly");
        }
      } else if (e.phase === "fly") {
        const speed = 2.5 + 2 * e.t;
        e.vel.lerp(tmp.copy(AWAY).multiplyScalar(speed), Math.min(1, dt * 5));
        pos.addScaledVector(e.vel, dt);
        tumble(e, dt, 1);
        flailPose(e.rt, t, dt);
        const k = Math.min(1, Math.max(0, (e.t - 0.6) / (FLY - 0.6)));
        e.rt.root.scale.setScalar(Math.max(0.01, 1 - k * k * (3 - 2 * k)));
        if (e.t >= FLY) {
          twinkle(pos);
          ctx.dispose(e.rt.root, e.rt);
          next(e, "gone");
        }
      }
      stepDrone(e, t, dt);
      if (e.phase === "gone" && e.drone.leave > 0.7) {
        ctx.dispose(e.drone.root);
        ctx.dispose(e.drone.beam);
        list.splice(i, 1);
        continue;
      }
      if (e.phase !== "gone") show(e, view);
      else show(e, view, false);
    }
    const armed = list.some((e) => e.phase === "wait" || e.phase === "launch" || (e.phase === "fly" && e.t < 1.2));
    const hatch = list.some((e) => (e.phase === "launch" && e.t > 0.25) || (e.phase === "fly" && e.t < 0.8));
    stepAirlock(ctx.airlock, { door: walkerNear, hatch, armed }, t, dt);
    for (let i = twinkles.length - 1; i >= 0; i--) {
      const w = twinkles[i];
      w.t += dt / 0.6;
      w.m.quaternion.copy(ctx.camera.quaternion);
      w.m.rotateZ(w.t * 3);
      w.m.scale.setScalar(Math.max(0.01, Math.sin(Math.min(1, w.t) * Math.PI) * 1.8));
      w.m.material.opacity = Math.min(1, 2 * (1 - w.t));
      if (w.t >= 1) {
        ctx.dispose(w.m);
        twinkles.splice(i, 1);
      }
    }
  }

  function next(e: Eject, phase: EjectPhase) {
    e.phase = phase;
    e.t = 0;
    if (phase === "wait") {
      e.rt.squash = 0.6;
      ctx.sfx({ kind: "airlock-alarm", pan: panOf(DOOR), intensity: 0.8 });
    }
    if (phase === "launch") e.rt.av.label.visible = false;
  }

  function stepDrone(e: Eject, t: number, dt: number) {
    const d = e.drone, rt = e.rt;
    d.rotor.rotation.y += dt * 26;
    d.lamp.color.set(Math.sin(t * 9) > 0 ? "#ff4f5e" : "#59c3ff");
    if (e.phase === "gone") {
      d.leave += dt;
      d.root.position.y += dt * 3;
      d.root.scale.setScalar(DRONE_SCALE * Math.max(0.01, 1 - d.leave / 0.7));
      d.beam.visible = false;
      return;
    }
    d.pop = Math.min(1, d.pop + dt * 3);
    // leading the way at head height, just in front (the status bubble sits above the head)
    const goal = e.phase === "walk"
      ? tmp.set(Math.sin(rt.mv.yaw), 0, Math.cos(rt.mv.yaw)).multiplyScalar(1.15).add(rt.root.position).setY(rt.root.position.y + rt.av.cy + 0.55)
      : tmp.copy(DRONE_POST);
    goal.y += Math.sin(t * 3.2) * 0.07;
    d.root.position.lerp(goal, Math.min(1, dt * (e.phase === "walk" ? 6 : 3)));
    d.root.rotation.y = lerpAngle(d.root.rotation.y, e.phase === "walk" ? rt.mv.yaw : Math.PI / 2, dt * 6);
    d.root.scale.setScalar(DRONE_SCALE * Math.max(0.01, 1 + 2.2 * Math.pow(d.pop - 1, 3) + 1.2 * Math.pow(d.pop - 1, 2)));
    // tractor beam from the drone to the agent's chest: it is led along
    d.beam.visible = e.phase === "walk" && d.pop > 0.5;
    if (d.beam.visible) {
      const head = rt.root.position.clone().setY(rt.root.position.y + rt.av.cy);
      const from = d.root.position.clone().setY(d.root.position.y - 0.2);
      const len = Math.max(0.05, from.distanceTo(head));
      d.beam.position.copy(from).add(head).multiplyScalar(0.5);
      d.beam.quaternion.setFromUnitVectors(up, from.sub(head).normalize());
      d.beam.scale.set(1, len, 1);
      d.beam.material.opacity = 0.45 + 0.15 * Math.sin(t * 10);
    }
  }

  /** Floor visibility like animateAgent: floors above the view are hidden, and floor 4 without the meeting floor. */
  function show(e: Eject, view: View, agent = true) {
    const fm = view.floorMode;
    const visOn = (y: number) => {
      const fl = floorAtY(y);
      return !(fm !== "all" && fl > Number(fm)) && !(view.meetingHidden && fl === 4);
    };
    if (agent) {
      const v = e.rt.av, fl = floorAtY(v.root.position.y);
      const vis = visOn(v.root.position.y);
      v.root.visible = vis;
      v.label.visible = vis && (e.phase === "walk" || e.phase === "wait") && !((fm === "3" || fm === "4") && fl < Number(fm));
      const badge = fm === "all" && fl < 4;
      v.el.classList.toggle("f1", badge);
      if (badge && v.badgeFloor !== fl) {
        v.badgeFloor = fl;
        (v.el.querySelector(".fl") as HTMLElement).textContent = "Lt." + fl;
      }
    }
    const dv = visOn(e.drone.root.position.y);
    e.drone.root.visible = dv;
    if (!dv) e.drone.beam.visible = false;
  }

  function twinkle(at: THREE.Vector3) {
    const s = new THREE.Shape();
    for (let k = 0; k < 8; k++) {
      const r = k % 2 ? 0.13 : 0.55, a = (k / 8) * Math.PI * 2 + Math.PI / 2;
      if (k === 0) s.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      else s.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    const m = new THREE.Mesh(new THREE.ShapeGeometry(s), noLine(flat("#fff6e3", { transparent: true, depthWrite: false, side: THREE.DoubleSide })));
    m.position.copy(at);
    m.scale.setScalar(0.01);
    ctx.world.add(m);
    twinkles.push({ m, t: 0 });
    ctx.sfx({ kind: "twinkle", pan: panOf(at), intensity: 0.7 });
  }

  /** Stereo position from where `p` is on screen. */
  function panOf(p: THREE.Vector3): number {
    const q = ctx.world.localToWorld(p.clone()).project(ctx.camera);
    return Math.max(-1, Math.min(1, q.x));
  }

  /** Everything this module put in the world, for the per-floor render passes (engine/index.ts renderFloors). */
  function objects(): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    for (const e of list) {
      if (e.phase !== "gone") out.push(e.rt.root);
      out.push(e.drone.root, e.drone.beam);
    }
    for (const w of twinkles) out.push(w.m);
    return out;
  }

  /** Tests: who is on the way out, and how far along. */
  const state = () => list.map((e) => ({ id: e.rt.id, phase: e.phase, t: e.t, floor: floorAtY(e.rt.root.position.y), door: ctx.airlock.door.open, hatch: ctx.airlock.hatch.open }));

  return { start, cancel, update, objects, state };
}

export type Ejector = ReturnType<typeof createEjector>;

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const onFloor4 = (p: THREE.Vector3) => Math.abs(p.y - F4) < 1;
const flatDist = (p: THREE.Vector3, q: THREE.Vector3) => Math.hypot(p.x - q.x, p.z - q.z);

/** Step along the route (like updateNav); true once there. */
function followPath(rt: AgentRuntime, dt: number): boolean {
  const mv = rt.mv;
  if (mv.path.length) {
    const pos = rt.root.position, tgt = mv.path[0].p;
    const dx = tgt.x - pos.x, dy = tgt.y - pos.y, dz = tgt.z - pos.z;
    const dist = Math.hypot(dx, dy, dz), step = mv.speed * dt;
    if (Math.hypot(dx, dz) > 0.02) mv.yaw = Math.atan2(dx, dz);
    if (dist <= step) {
      pos.copy(tgt);
      mv.lastRef = mv.path.shift()!.ref;
    } else pos.set(pos.x + (dx / dist) * step, pos.y + (dy / dist) * step, pos.z + (dz / dist) * step);
  }
  rt.root.rotation.y = lerpAngle(rt.root.rotation.y, mv.yaw, dt * 10);
  return mv.path.length === 0;
}

function tumble(e: Eject, dt: number, k: number) {
  const r = e.rt.root.rotation;
  r.x += e.spin.x * dt * k;
  r.y += e.spin.y * dt * k;
  r.z += e.spin.z * dt * k;
}

interface Body {
  by: number; rx: number; rz: number;
  arms: [number, number, number, number];
  legL: number; legR: number;
  lookX: number; lookY: number; lid: number; mouth: number; frown: boolean;
}

/** Apply a body pose (the shared tail of animateAgent: squash, limbs, blink, eyes, mouth). */
function body(rt: AgentRuntime, p: Body, dt: number) {
  const v = rt.av;
  v.poseG.rotation.set(0, 0, 0);
  v.poseG.position.set(0, 0, 0);
  let sy = 1;
  if (rt.squash > 0) {
    rt.squash = Math.max(0, rt.squash - dt * 2.8);
    sy = 1 + Math.sin((1 - rt.squash) * Math.PI * 2) * 0.18 * rt.squash;
  }
  v.bob.position.set(0, p.by, 0);
  v.bob.rotation.set(p.rx, 0, p.rz);
  v.bob.scale.set(1 / Math.sqrt(sy), sy, 1 / Math.sqrt(sy));
  const [L, R] = v.arms, [LL, LR] = v.legs;
  L.rotation.x = p.arms[0]; L.rotation.z = p.arms[1]; R.rotation.x = p.arms[2]; R.rotation.z = p.arms[3];
  LL.rotation.x += (p.legL - LL.rotation.x) * Math.min(1, dt * 14);
  LR.rotation.x += (p.legR - LR.rotation.x) * Math.min(1, dt * 14);
  let lid = p.lid;
  v.blinkT -= dt;
  if (v.blinkT <= 0) { v.blinking = 0.14; v.blinkT = 2 + Math.random() * 4; }
  if (v.blinking > 0) { v.blinking -= dt; if (lid < 2) lid = Math.PI; }
  for (const eye of v.eyes) {
    eye.piv.rotation.y += (Math.max(-0.7, Math.min(0.7, p.lookX)) - eye.piv.rotation.y) * Math.min(1, dt * 8);
    eye.piv.rotation.x += (-Math.max(-0.6, Math.min(0.6, p.lookY)) - eye.piv.rotation.x) * Math.min(1, dt * 8);
    eye.lid.rotation.x += (-Math.PI / 2 + lid - eye.lid.rotation.x) * Math.min(1, dt * 18);
  }
  const m = v.mouth;
  if (p.frown) { m.rotation.z = 0; m.scale.set(1, p.mouth, 1); m.position.y = m.userData.y - 0.08; }
  else { m.rotation.z = Math.PI; m.position.y = m.userData.y; m.scale.set(1, p.mouth, 1); }
}

/** Led along: a brisk walk with the head down and a sad face. */
function walkPose(rt: AgentRuntime, t: number, dt: number) {
  const s = Math.sin(t * 13);
  body(rt, {
    by: Math.abs(s) * 0.08, rx: 0.14, rz: s * 0.06,
    arms: [-0.1 - s * 0.45, -0.2, -0.1 + s * 0.45, 0.2], legL: s * 0.6, legR: -s * 0.6,
    lookX: 0, lookY: -0.3, lid: 1.2, mouth: 0.8, frown: true,
  }, dt);
}

/** Alarm in the Airlock: arms up, hopping, eyes wide, looking at the camera. */
const camLocal = new THREE.Vector3();
function panicPose(rt: AgentRuntime, t: number, dt: number, camera: THREE.Camera) {
  const v = rt.av;
  camLocal.copy(camera.position);
  v.root.parent?.worldToLocal(camLocal);
  camLocal.sub(v.root.position);
  const yaw = Math.atan2(camLocal.x, camLocal.z) - v.root.rotation.y;
  body(rt, {
    by: Math.abs(Math.sin(t * 9)) * 0.13, rx: -0.08, rz: Math.sin(t * 7) * 0.05,
    arms: [-2.8 + Math.sin(t * 18) * 0.3, 0.5, -2.8 + Math.cos(t * 18) * 0.3, -0.5], legL: 0, legR: 0,
    lookX: Math.atan2(Math.sin(yaw), Math.cos(yaw)) * 0.6, lookY: 0.2, lid: 0.05, mouth: 1.6, frown: false,
  }, dt);
}

/** Tumbling through space: arms and legs flailing. */
function flailPose(rt: AgentRuntime, t: number, dt: number) {
  body(rt, {
    by: 0, rx: 0, rz: 0,
    arms: [-2.2 + Math.sin(t * 20) * 0.6, 0.9, -2.2 + Math.cos(t * 17) * 0.6, -0.9],
    legL: Math.sin(t * 16) * 0.7, legR: -Math.sin(t * 16) * 0.7,
    lookX: Math.sin(t * 9) * 0.5, lookY: 0.3, lid: 0.05, mouth: 1.8, frown: false,
  }, dt);
}
