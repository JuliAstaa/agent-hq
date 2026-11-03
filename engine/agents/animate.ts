// Per-frame agent animation (port of animateAgent in references/agent-hq.html, prd.md §10.4).

import * as THREE from "three";
import { F2, F3 } from "../constants";
import { V } from "../scene/kit";
import type { Desk } from "../world/props/desk";
import type { Station } from "../world/floor3";
import type { Avatar } from "./avatar";
import { floorOf, updateNav, type Mover, type NavCtx } from "./movement";
import { POSE } from "./poses";
import { STATUS } from "@/lib/events";
import type { Agent, FloorMode } from "@/lib/store";

export interface AgentRuntime extends Mover {
  av: Avatar;
  desk: Desk;
}

export interface AnimCtx {
  camera: THREE.Camera;
  selectedId: string | null;
  floorMode: FloorMode;
  nav: NavCtx;
  stations: Station[];
  coffeeNozzle: THREE.Vector3;
  spawnSmoke: (pos: THREE.Vector3, color?: string, size?: number, rise?: number) => void;
  drawPlate: (rt: AgentRuntime, a: Agent) => void;
}

const tmpV = new THREE.Vector3();
const camLocal = new THREE.Vector3();

export function animateAgent(ctx: AnimCtx, rt: AgentRuntime, a: Agent, t: number, dt: number) {
  const v = rt.av, st = a.status, mv = rt.mv;
  if (v.spawn !== undefined) {
    v.spawn = Math.min(1, v.spawn + dt * 2.2);
    const s = v.spawn;
    const e = 1 + 2.2 * Math.pow(s - 1, 3) + 1.2 * Math.pow(s - 1, 2);
    v.root.scale.setScalar(Math.max(0.01, e));
    if (s >= 1) {
      v.root.scale.setScalar(1);
      delete v.spawn;
    }
  }
  updateNav(ctx.nav, rt, a, dt);
  const col = STATUS[st].color;
  const mode = mv.mode, act = mode === "act" ? mv.activity : null;
  if (mode === "act") mv.actT += dt;
  const poseName = mode === "desk" ? "desk" : mode === "walk" ? "walk" : mv.dest.kind === "spot" ? mv.dest.pose : "stand";
  // pose group
  const pg = v.poseG;
  if (poseName === "lie") {
    pg.rotation.set(-Math.PI / 2, 0, 0);
    pg.position.set(0, 0.32 + v.depth, v.top / 2 - 0.1);
  } else {
    const P = POSE[poseName] || POSE.stand;
    pg.rotation.set(P.rx, 0, 0);
    pg.position.set(0, P.y, P.z);
  }
  // body motion
  let by = 0, bx = 0, rz = 0, rx = 0, sy = 1;
  const [L, R] = v.arms, [LL, LR] = v.legs;
  let legL = (POSE[poseName] || { leg: 0 }).leg, legR = legL;
  let lookX = 0, lookY = 0, lidOpen = 0.55, mouthK = 0.9, frown = false;
  const setArms = (lx: number, lz: number, rxa: number, rza: number) => {
    L.rotation.x = lx; L.rotation.z = lz; R.rotation.x = rxa; R.rotation.z = rza;
  };

  if (mode === "walk") {
    const f = mv.urgent ? 15 : 9.5, s = Math.sin(t * f);
    by = Math.abs(s) * 0.09; rz = s * 0.07; rx = mv.urgent ? 0.18 : 0.04;
    legL = s * 0.65; legR = -s * 0.65;
    setArms(-0.15 - s * 0.55, -0.2, -0.15 + s * 0.55, 0.2);
    lookX = 0; lookY = mv.urgent ? 0 : 0.05; lidOpen = mv.urgent ? 0.05 : 0.5;
    if (mv.carrying) { L.rotation.x = -1.05; L.rotation.z = 0.3; } // hold the task card out in front
  } else if (mode === "fetch") {
    // Task board (deviation 14): reach up for the card, then tuck it in and turn to go.
    const k = mv.fetchT;
    if (!mv.carrying) {
      setArms(-0.3, -0.2, -2.5 + Math.sin(k * 14) * 0.12, 0.25);
      lookY = 0.35; lookX = 0.05; lidOpen = 0.05; mouthK = 1.1;
    } else {
      setArms(-1.2, 0.3, -0.3, 0.2);
      lookY = -0.25; lookX = -0.2; mouthK = 1.4; by = Math.abs(Math.sin(k * 12)) * 0.05;
    }
  } else if (mode === "desk") {
    if (st === "working") {
      by = Math.abs(Math.sin(t * 7)) * 0.03; rx = 0.08;
      setArms(-1.15 + Math.sin(t * 16) * 0.18, -0.15, -1.15 + Math.sin(t * 16 + Math.PI) * 0.18, 0.15);
      // Desks and stations both put the monitor straight ahead (deviation 8).
      lookX = Math.sin(t * 0.9 + v.lookPh) * 0.35; lookY = -0.12;
    } else if (st === "thinking") {
      rz = Math.sin(t * 1.6) * 0.07; by = Math.sin(t * 1.6) * 0.02; setArms(-0.4, -0.15, -2.2, -0.55);
      lookX = Math.sin(t * 0.7 + v.lookPh) * 0.4; lookY = 0.45; mouthK = 0.3;
    } else if (st === "waiting") {
      by = Math.abs(Math.sin(t * 4.5)) * 0.16; setArms(-0.3, -0.2, -2.9, 0.35 + Math.sin(t * 9) * 0.35); lidOpen = 0.05; mouthK = 1.4;
    } else if (st === "idle") {
      sy = 1 + Math.sin(t * 1.4) * 0.025; rx = -0.12; setArms(-0.25, -0.25, -0.25, 0.25); lidOpen = 1.4; mouthK = 0.45;
      lookX = Math.sin(t * 0.5 + v.lookPh) * 0.5;
    } else if (st === "error") {
      bx = Math.sin(t * 45) * 0.035; setArms(-2.6 + Math.sin(t * 20) * 0.2, 0.4, -2.6 + Math.cos(t * 20) * 0.2, -0.4);
      lidOpen = 0.05; frown = true; lookX = Math.sin(t * 30) * 0.3;
    } else {
      by = -0.08; rx = 0.25; setArms(0.1, -0.25, 0.1, 0.25); lidOpen = Math.PI; frown = true; mouthK = 0.25;
    }
    if (st === "waiting" || st === "error" || a.id === ctx.selectedId) {
      camLocal.copy(ctx.camera.position); v.root.worldToLocal(camLocal); camLocal.sub(tmpV.set(0, v.cy + 0.2, 0)).normalize();
      lookX = Math.atan2(camLocal.x, camLocal.z) * 0.6 + (st === "error" ? Math.sin(t * 30) * 0.3 : 0);
      lookY = Math.asin(Math.max(-1, Math.min(1, camLocal.y))) * 0.6;
    }
  } else {
    // ---- idle activities ----
    const ph = v.lookPh;
    switch (act) {
      case "tv": {
        setArms(-0.35, 0.3, -0.35, -0.3); lookY = 0.08; lookX = Math.sin(t * 0.3 + ph) * 0.08;
        const laugh = Math.sin(t * 0.8 + ph) > 0.85;
        if (laugh) { by = Math.abs(Math.sin(t * 18)) * 0.05; mouthK = 1.7; lidOpen = 1.2; setArms(-0.9 + Math.sin(t * 18) * 0.2, 0.4, -0.9 - Math.sin(t * 18) * 0.2, -0.4); }
        break;
      }
      case "phone":
      case "lie_phone": {
        const recl = act === "lie_phone";
        setArms(recl ? -2.0 : -1.25, 0.5, (recl ? -2.0 : -1.25) + Math.sin(t * 14) * 0.05, -0.5);
        lookY = recl ? 0.2 : -0.45; lookX = 0; mouthK = 0.5 + (Math.sin(t * 0.6 + ph) > 0.7 ? 0.9 : 0);
        v.P.phone.position.set(0, recl ? v.cy + 0.32 : v.cy - 0.05, v.front + (recl ? 0.42 : 0.3));
        v.P.phone.rotation.x = recl ? 1.15 : 0.5;
        v.P.phoneScreen.material.color.set(Math.floor(t * 0.7 + ph) % 3 === 0 ? "#ffd9a8" : "#7bdff2");
        if (poseName === "lie") { setArms(-2.6, 0.45, -2.6, -0.45); v.P.phone.position.set(0, v.cy + 0.15, v.front + 0.5); v.P.phone.rotation.x = 1.35; lookY = 0.35; }
        break;
      }
      case "nap": {
        sy = 1 + Math.sin(t * 1.2) * 0.04; setArms(-0.1, -0.3, -0.1, 0.3); lidOpen = Math.PI; mouthK = 0.25;
        if (Math.random() < dt * 0.6) ctx.spawnSmoke(v.root.position.clone().add(V(0, 0.9 + v.depth * 2, 0)), "#e6f6ff", 0.5, 0.6);
        break;
      }
      case "coffee": {
        const brewing = mv.actT < 5;
        if (brewing) {
          setArms(-1.4 + Math.sin(t * 6) * 0.08, 0.25, -1.5, -0.25); lookY = -0.3; lookX = 0.15;
          if (Math.random() < dt * 3) ctx.spawnSmoke(ctx.coffeeNozzle, "#ffffff", 0.45, 0.7);
        } else {
          mv.hasMug = true;
          const sip = Math.sin(t * 0.9 + ph) > 0.55;
          setArms(-0.4, -0.2, sip ? -2.25 : -1.0, -0.15); lidOpen = sip ? 1.4 : 0.55; mouthK = sip ? 0.2 : 1.0; lookX = Math.sin(t * 0.4 + ph) * 0.4;
        }
        break;
      }
      case "sip": {
        const sip = Math.sin(t * 0.9 + ph) > 0.55;
        setArms(-1.05, 0.15, sip ? -2.25 : -1.0, -0.15); lidOpen = sip ? 1.4 : 0.55; mouthK = sip ? 0.2 : 1.0; lookX = Math.sin(t * 0.35 + ph) * 0.5; lookY = 0.05;
        break;
      }
      case "fridge":
        setArms(-1.5 + Math.sin(t * 3) * 0.1, 0.2, -1.6, -0.2); lookX = Math.sin(t * 1.2) * 0.5; lookY = Math.sin(t * 0.9) * 0.3; mouthK = 1.2; lidOpen = 0.05; by = Math.abs(Math.sin(t * 1.5)) * 0.03;
        break;
      case "arcade":
        setArms(-1.25 + Math.sin(t * 24) * 0.12, 0.2, -1.25 + Math.cos(t * 21) * 0.12, -0.2); lookY = 0.05; lookX = Math.sin(t * 3) * 0.1; lidOpen = 0.05; mouthK = 1.3; by = Math.abs(Math.sin(t * 4)) * 0.03; rz = Math.sin(t * 2.3) * 0.05;
        break;
      case "pingpong": {
        const p = (t * 0.8 + ph) % 1, sw = Math.max(0, Math.cos(p * Math.PI * 2));
        setArms(-0.6, -0.2, -0.9 - 0.8 * sw, 0.35); lookX = -0.15; lookY = 0.05 + (p < 0.5 ? 0 : 0.05); lidOpen = 0.05; mouthK = 1.0;
        legL = Math.sin(t * 5) * 0.15; legR = -legL; by = Math.abs(Math.sin(t * 5)) * 0.04;
        break;
      }
      case "gaze":
        setArms(0.45, 0.35, 0.45, -0.35); lookY = 0.35 + Math.sin(t * 0.4 + ph) * 0.1; lookX = Math.sin(t * 0.25 + ph) * 0.35; rz = Math.sin(t * 0.6 + ph) * 0.05; lidOpen = 0.9; mouthK = 0.35;
        break;
      case "whiteboard":
        setArms(-0.3, -0.2, -2.3 + Math.sin(t * 5) * 0.25, 0.15 + Math.cos(t * 5) * 0.2); lookY = 0.15; lookX = 0.1 + Math.sin(t * 5) * 0.05; mouthK = 0.6;
        break;
      case "cards":
        setArms(-1.15, 0.35, -1.15, -0.35); lookY = -0.3; lookX = Math.sin(t * 0.5 + ph) > 0.6 ? 0.6 : 0; mouthK = 0.7;
        if (Math.sin(t * 0.7 + ph) > 0.93) { by = 0.12; mouthK = 1.6; }
        break;
      case "read":
        setArms(-1.15, 0.35, -1.15 + (Math.sin(t * 0.6 + ph) > 0.92 ? -0.4 : 0), -0.35); lookY = -0.4; lookX = Math.sin(t * 1.8) * 0.25; lidOpen = 0.9; mouthK = 0.4;
        break;
      default:
        setArms(-0.3, -0.2, -0.3, 0.2);
    }
  }
  if (rt.squash > 0) {
    rt.squash = Math.max(0, rt.squash - dt * 2.8);
    const p = 1 - rt.squash;
    sy *= 1 + Math.sin(p * Math.PI * 2) * 0.18 * rt.squash;
  }
  v.bob.position.set(bx, by, 0);
  v.bob.rotation.set(rx, 0, rz);
  v.bob.scale.set(1 / Math.sqrt(sy), sy, 1 / Math.sqrt(sy));
  LL.rotation.x += (legL - LL.rotation.x) * Math.min(1, dt * 14);
  LR.rotation.x += (legR - LR.rotation.x) * Math.min(1, dt * 14);
  // props
  const P = v.P;
  P.phone.visible = act === "phone" || act === "lie_phone";
  P.book.visible = act === "read";
  P.cards.visible = act === "cards";
  P.paddle.visible = act === "pingpong";
  P.taskCard.visible = mv.carrying;
  P.taskCard.rotation.x = -L.rotation.x * 0.6;
  P.mug.visible = mv.hasMug && (mode === "walk" || ["coffee", "sip", "tv", "gaze"].includes(act as string)) && !(act === "coffee" && mv.actT < 5);
  P.mug.rotation.x = -R.rotation.x;
  // blink + eyes
  v.blinkT -= dt;
  if (v.blinkT <= 0) { v.blinking = 0.14; v.blinkT = 2 + Math.random() * 4; }
  if (v.blinking > 0) { v.blinking -= dt; if (lidOpen < 2) lidOpen = Math.PI; }
  for (const e of v.eyes) {
    e.piv.rotation.y += (Math.max(-0.7, Math.min(0.7, lookX)) - e.piv.rotation.y) * Math.min(1, dt * 8);
    e.piv.rotation.x += (-Math.max(-0.6, Math.min(0.6, lookY)) - e.piv.rotation.x) * Math.min(1, dt * 8);
    e.lid.rotation.x += (-Math.PI / 2 + lidOpen - e.lid.rotation.x) * Math.min(1, dt * 18);
  }
  const m = v.mouth;
  if (frown) { m.rotation.z = 0; m.scale.set(1, mouthK, 1); m.position.y = m.userData.y - 0.08; }
  else { m.rotation.z = Math.PI; m.position.y = m.userData.y; m.scale.set(1, mouthK, 1); }
  // antenna bulb
  let on = 1;
  if (st === "thinking") on = Math.sin(t * 10) > 0 ? 1 : 0.35;
  if (st === "error") on = Math.sin(t * 14) > 0 ? 1 : 0.2;
  if (st === "waiting") on = 0.6 + 0.4 * Math.sin(t * 6);
  v.bulbMat.color.set(st === "offline" ? "#4a4560" : col).multiplyScalar(on);
  // desk
  const d = rt.desk;
  d.strip.material.color.set(col);
  d.ring.material.color.set(st === "offline" ? "#4a4560" : col);
  d.glow.material.color.set(col);
  d.glow.material.opacity = st === "offline" ? 0 : 0.25 + 0.15 * Math.sin(t * 3);
  d.chair.position.y = st === "offline" ? -0.12 : Math.sin(t * 2 + v.lookPh) * 0.03;
  if (mode === "desk") {
    if (mv.dest.kind === "station") {
      const sc = ctx.stations[mv.dest.index].chair;
      sc.position.y = st === "offline" ? -0.12 : Math.sin(t * 2 + v.lookPh) * 0.03;
      v.root.position.y = F3 + sc.position.y;
    } else v.root.position.y = F2 + d.chair.position.y;
  }
  if (d.plateName !== a.name) ctx.drawPlate(rt, a);
  if (st === "error" && mode === "desk") {
    v.smokeT -= dt;
    if (v.smokeT <= 0) { v.smokeT = 0.35; ctx.spawnSmoke(v.root.position.clone().add(tmpV.set(0, v.top + 0.15, 0))); }
  }
  // visibility per floor
  const fm = ctx.floorMode;
  const fl = floorOf(rt);
  const vis = !((fm === "1" || fm === "2") && fl > Number(fm));
  v.root.visible = vis;
  v.label.visible = vis && !(fm === "3" && fl < 3);
  const badge = (fm === "all" || fm === "3") && fl < 3;
  v.el.classList.toggle("f1", badge);
  if (badge && v.badgeFloor !== fl) {
    v.badgeFloor = fl;
    (v.el.querySelector(".fl") as HTMLElement).textContent = "Lt." + fl;
  }
  v.el.style.opacity = st === "offline" ? "0.55" : "1";
}
