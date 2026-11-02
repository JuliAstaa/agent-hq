// Where an agent goes and how it walks there (prd.md §10.1, §10.3).
// Port of pickSpot/reserve/placeAt/workTarget/goTo/startActivity/arrive/updateNav/floorOf/locText.
// Works on a plain Object3D + movement state, so it can be unit-tested without WebGL.

import type * as THREE from "three";
import { ACT_LABEL, IDLE_LEAVE_DELAY, type Activity } from "../constants";
import { lerpAngle, pick, rand } from "../scene/kit";
import { atPlace, route, type Ref, type Waypoint } from "../nav/router";
import type { DeskPlace, Place, SpotPlace, StationPlace } from "../nav/places";
import { DEPTS, type Dept } from "@/lib/teams";
import type { Status } from "@/lib/events";

export interface Movement {
  mode: "desk" | "walk" | "act";
  dest: Place;
  path: Waypoint[];
  lastRef: Ref;
  yaw: number;
  speed: number;
  idleSince: number | null;
  switchAt: number;
  activity: Activity | null;
  actT: number;
  hasMug: boolean;
  urgent: boolean;
}

export interface Mover {
  id: string;
  root: THREE.Object3D;
  mv: Movement;
  home: DeskPlace;
  /** Squash-and-stretch amount (animation). */
  squash: number;
}

export interface NavAgent {
  status: Status;
  dept: Dept | null;
}

export interface NavCtx {
  spots: SpotPlace[];
  stations: StationPlace[];
  /** Simulation time in seconds. */
  now: () => number;
  /** Movement log line ("move" level). */
  log: (id: string, message: string) => void;
  /** Bubble / roster location needs a refresh. */
  changed: (m: Mover) => void;
}

export function newMovement(home: DeskPlace): Movement {
  return { mode: "desk", dest: home, path: [], lastRef: atPlace(home), yaw: 0, speed: 2.4, idleSince: null, switchAt: 0, activity: null, actT: 0, hasMug: false, urgent: false };
}

export function pickSpot(ctx: NavCtx, m: Mover): SpotPlace | null {
  const cur = m.mv.dest;
  const free = ctx.spots.filter((s) => (!s.occ || s.occ === m.id) && s !== cur);
  return free.length ? pick(free) : null;
}

export function reserve(m: Mover, dest: Place) {
  const mv = m.mv;
  if (mv.dest.kind !== "desk" && mv.dest.occ === m.id) mv.dest.occ = null;
  if (dest.kind !== "desk") dest.occ = m.id;
  mv.dest = dest;
}

export function startActivity(ctx: NavCtx, m: Mover) {
  const mv = m.mv;
  const dest = mv.dest as SpotPlace;
  mv.mode = "act";
  mv.activity = pick(dest.types);
  mv.actT = 0;
  mv.switchAt = ctx.now() + rand(30, 60);
  if (mv.activity === "sip") mv.hasMug = true;
  ctx.changed(m);
}

/** Teleport (used for snapshot placement on connect). */
export function placeAt(ctx: NavCtx, m: Mover, sp: Place) {
  const mv = m.mv;
  reserve(m, sp);
  mv.path = [];
  mv.lastRef = atPlace(sp);
  m.root.position.copy(sp.final);
  mv.yaw = sp.face;
  m.root.rotation.y = sp.face;
  if (sp.kind === "spot") startActivity(ctx, m);
  else {
    mv.mode = "desk";
    mv.activity = null;
    ctx.changed(m);
  }
}

/** Team station if the team is known and one is free (or already mine), else the home desk. */
export function workTarget(ctx: NavCtx, m: Mover, a: NavAgent): Place {
  if (a.status === "offline" || !a.dept) return m.home;
  const mine = ctx.stations.find((s) => s.dept === a.dept && s.occ === m.id);
  if (mine) return mine;
  const free = ctx.stations.find((s) => s.dept === a.dept && !s.occ);
  return free ?? m.home;
}

export function goTo(ctx: NavCtx, m: Mover, dest: Place, urgent = false) {
  const mv = m.mv;
  reserve(m, dest);
  mv.path = route(mv.lastRef, dest);
  mv.urgent = urgent;
  mv.speed = urgent ? 4.6 : 2.3;
  mv.mode = "walk";
  mv.activity = null;
  const where = dest.kind === "desk" ? "balik ke meja" : dest.kind === "station" ? `ke ${dest.room} (Lt.3)` : `jalan ke ${dest.room} (Lt.${dest.floor})`;
  ctx.log(m.id, urgent ? `Buru-buru ${where}` : `Jalan santai, ${where.replace("jalan ke ", "ke ")}`);
  ctx.changed(m);
}

export function arrive(ctx: NavCtx, m: Mover) {
  const mv = m.mv;
  if (mv.dest.kind !== "spot") {
    mv.mode = "desk";
    mv.activity = null;
    mv.hasMug = false;
  } else startActivity(ctx, m);
  mv.yaw = mv.dest.face;
  m.squash = 0.5;
  ctx.changed(m);
}

export function updateNav(ctx: NavCtx, m: Mover, a: NavAgent, dt: number) {
  const mv = m.mv;
  const now = ctx.now();
  if (a.status === "idle") {
    if (mv.idleSince === null) mv.idleSince = now;
    if (mv.mode === "desk" && now - mv.idleSince > IDLE_LEAVE_DELAY) {
      const sp = pickSpot(ctx, m);
      if (sp) goTo(ctx, m, sp);
      else mv.idleSince = now + 10;
    } else if (mv.mode === "act" && now > mv.switchAt) {
      if (Math.random() < 0.6) {
        const sp = pickSpot(ctx, m);
        if (sp) goTo(ctx, m, sp);
      }
      mv.switchAt = now + rand(30, 60);
    }
  } else {
    mv.idleSince = null;
    const tgt = workTarget(ctx, m, a);
    if (mv.dest !== tgt) goTo(ctx, m, tgt, true);
  }
  if (mv.path.length) {
    mv.mode = "walk";
    const pos = m.root.position;
    const tgt = mv.path[0].p;
    const dx = tgt.x - pos.x, dy = tgt.y - pos.y, dz = tgt.z - pos.z;
    const dist = Math.hypot(dx, dy, dz), step = mv.speed * dt;
    if (Math.hypot(dx, dz) > 0.02) mv.yaw = Math.atan2(dx, dz);
    if (dist <= step) {
      pos.copy(tgt);
      mv.lastRef = mv.path.shift()!.ref;
      if (!mv.path.length) arrive(ctx, m);
    } else pos.set(pos.x + (dx / dist) * step, pos.y + (dy / dist) * step, pos.z + (dz / dist) * step);
  }
  m.root.rotation.y = lerpAngle(m.root.rotation.y, mv.yaw, dt * 10);
}

/** Release every place this agent holds (called when the agent is removed). */
export function releasePlaces(m: Mover) {
  // PROTOTYPE PARITY: references/agent-hq.html removeAgent() only frees spots, so a removed agent
  // keeps its floor-3 station reserved. Fix (free stations too) is proposed in plan-m1.md, pending approval.
  const d = m.mv.dest;
  if (d.kind === "spot" && d.occ === m.id) d.occ = null;
}

export function floorOf(m: { root: THREE.Object3D } | null): number {
  if (!m) return 2;
  const y = m.root.position.y;
  return y > 8.4 ? 3 : y > 2.8 ? 2 : 1;
}

export function locText(m: Mover | null): { where: string; what: string } {
  if (!m) return { where: "Tanpa meja", what: "" };
  const mv = m.mv;
  const fl = `Lt.${floorOf(m)}`;
  if (mv.mode === "desk") {
    return mv.dest.kind === "station" ? { where: `${mv.dest.room} · ${fl}`, what: DEPTS[mv.dest.dept].label } : { where: `Meja kerja · ${fl}`, what: "" };
  }
  if (mv.mode === "walk") return { where: fl, what: mv.dest.kind === "desk" ? "jalan balik ke meja" : `jalan ke ${mv.dest.room}` };
  return { where: `${mv.dest.room} · ${fl}`, what: (mv.activity && ACT_LABEL[mv.activity]) || "santai" };
}
