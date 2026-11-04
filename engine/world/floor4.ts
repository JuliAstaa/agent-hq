// Floor 4 "Meeting" (prd.md §7.9): three enclosed glass meeting rooms side by side along the back wall (frosted
// glass up to 2.2 with a clear band above, a sliding frosted door each; table, five seats with laptops, team screen,
// accent strip), a corridor from the lift, and the lift tube continuing up from floor 3. Not in the prototype.

import * as THREE from "three";
import { F3, F4 } from "../constants";
import type { Fonts } from "../scene/fonts";
import { boxAt, canvasTex, cyl, mesh, noLine, rbox, thin, type CanvasTex } from "../scene/kit";
import { DOOR_HALF, ROOM_FRONT_Z, ROOM_RIGHT_X, ROOM_WALLS, ROOM_XS, TABLE_HALF_X, TABLE_HALF_Z, TABLE_Z, type SeatPlace } from "../nav/places";
import { MEETING_ROOMS, SEATS_PER_ROOM } from "@/lib/meeting";
import { alienPlant } from "./props/alienPlant";
import { LIFT_GAP, LIFT_X, LIFT_Z } from "./floor3";
import { makeWall, roomLabel, type Build } from "./structure";

type BasicMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;

export interface MeetingSeatProp {
  place: SeatPlace;
  chair: THREE.Group;
  ring: BasicMesh;
  glow: BasicMesh;
  /** Laptop screen on the table in front of the seat: tinted by the sitter's status. */
  screen: BasicMesh;
}

export interface MeetingRoomProp {
  /** Team screen on the back wall (drawMeetingScreen). */
  screen: CanvasTex;
  /** Accent strip under the screen: the team color, dark while the room is empty. */
  strip: BasicMesh;
  seats: MeetingSeatProp[];
  /** Middle of the table top (world, without the island bob). */
  center: THREE.Vector3;
  /** Sliding frosted door in the front wall: `open` 0..1 (stepDoors), `x` its middle. */
  door: { leaf: THREE.Group; open: number; x: number };
}

/** A small task card that flies from the leader's seat to a new member's seat (0.6 s). */
export interface FlyCard {
  m: THREE.Mesh<THREE.BufferGeometry, THREE.MeshToonMaterial>;
  from: THREE.Vector3;
  to: THREE.Vector3;
  t: number;
}

export interface Floor4 {
  rooms: MeetingRoomProp[];
  sign: CanvasTex & { draw: () => void };
  cards: FlyCard[];
}

export const MEETING_SCREEN_W = 640, MEETING_SCREEN_H = 280;
/** Accent color of an empty room's strip and chairs. */
export const MEETING_IDLE = "#3a3360";
const CARD_SECONDS = 0.6;
/** Glass walls: frosted up to FROST above the floor, clear up to TOP (the back wall's trim). */
const FROST = 2.2, TOP = 4.4, PANE = 0.06;
/** How far the door leaf slides to open (its width plus a little). */
const DOOR_SLIDE = DOOR_HALF * 2 + 0.05;

export function buildFloor4(b: Build, g4: THREE.Group, tentacles: THREE.Group[], fonts: Fonts, seats: SeatPlace[]): Floor4 {
  const { M } = b;
  const { toon, flat } = b.kit;

  // slab with the lift hole (same cut as floor 3)
  for (const [x0, x1, z0, z1] of [[-13, 5.8, -8, 8.4], [7.8, 13, -8, 8.4], [5.8, 7.8, -8, 3.8], [5.8, 7.8, 5.8, 8.4]]) {
    boxAt(g4, x1 - x0, 0.4, z1 - z0, (x0 + x1) / 2, F4 - 0.4, (z0 + z1) / 2, M.slab, 0.04, false);
  }
  // Floor 3 had an open roof: its walls stop at F3 + 4.4. Fill the gap up to this slab in the floor-3 colors.
  {
    const y0 = F3 + 4.58, h = F4 - 0.4 - y0;
    makeWall(b, g4, "x", -7.8, -13, -4, y0, h, [], M.redWall, 0.4, false);
    makeWall(b, g4, "x", -7.8, -4, 4, y0, h, [], M.repWall, 0.4, false);
    makeWall(b, g4, "x", -7.8, 4, 13, y0, h, [], M.socWall, 0.4, false);
    makeWall(b, g4, "z", -12.8, -8, 8.4, y0, h, [], M.redWall, 0.4, false);
  }
  // carpet
  const V2 = (x: number, y: number) => new THREE.Vector2(x, y);
  const sh = new THREE.Shape([V2(-12.6, 7.6), V2(13, 7.6), V2(13, -8.4), V2(-12.6, -8.4)]);
  sh.holes.push(new THREE.Path([V2(5.8, -3.8), V2(5.8, -5.8), V2(7.8, -5.8), V2(7.8, -3.8)]));
  const tile = canvasTex(128, 128);
  {
    const c = tile.ctx;
    c.fillStyle = "#2f5d66"; c.fillRect(0, 0, 128, 128);
    c.fillStyle = "#356872"; c.fillRect(0, 0, 64, 64); c.fillRect(64, 64, 64, 64);
    c.strokeStyle = "rgba(190,255,240,.14)"; c.lineWidth = 2; c.strokeRect(1, 1, 126, 126);
  }
  tile.tex.wrapS = tile.tex.wrapT = THREE.RepeatWrapping;
  tile.tex.repeat.set(0.25, 0.25);
  const fl = mesh(new THREE.ShapeGeometry(sh), noLine(toon("#ffffff", { map: tile.tex })), false, true);
  fl.rotation.x = -Math.PI / 2; fl.position.y = F4 + 0.006; g4.add(fl);
  const rug = (x0: number, x1: number, z0: number, z1: number, c: string) => {
    const m = mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0), noLine(toon(c)), false, true);
    m.rotation.x = -Math.PI / 2; m.position.set((x0 + x1) / 2, F4 + 0.012, (z0 + z1) / 2); g4.add(m);
  };

  // walls: one color per room on the back wall, the left wall in room A's color with a window
  const roomWall = [toon("#f4bfd6"), toon("#bfe6d3"), toon("#ffd8a8")];
  const edges = [-13, ...ROOM_WALLS, 13];
  roomWall.forEach((mat, i) => makeWall(b, g4, "x", -7.8, edges[i], edges[i + 1], F4, 4.4, [], mat));
  makeWall(b, g4, "z", -12.8, -8, 8.4, F4, 4.4, [{ a0: -6.2, a1: -2.6, y0: F4 + 1.3, y1: F4 + 3.3 }], roomWall[0]);
  boxAt(g4, 26.4, 0.18, 0.56, 0, F4 + 4.4, -7.8, M.trim, 0.04);
  boxAt(g4, 0.56, 0.18, 16.4, -12.8, F4 + 4.4, 0.2, M.trim, 0.04);
  boxAt(g4, 26, 0.25, 0.48, 0, F4, -7.8, M.dark, 0.04);
  boxAt(g4, 0.48, 0.25, 16, -12.8, F4, 0.2, M.dark, 0.04);
  rug(-12.4, -4.5, -7.4, 0.8, "#6b4a8f");
  rug(-3.9, 3.9, -7.4, 0.8, "#2f7a63");
  rug(4.5, 12.8, -7.4, 0.8, "#9a5a3a");

  // Enclosed glass rooms like an ordinary office: frosted glass up to 2.2 (a pink safety band at eye level), clear
  // glass above it up to the trim. Seated agents stay visible from the camera over the frosted part.
  const frost = canvasTex(4, 256);
  {
    const c = frost.ctx;
    const grad = c.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, "rgba(236,244,255,0.82)");
    grad.addColorStop(1, "rgba(226,238,252,0.93)");
    c.fillStyle = grad; c.fillRect(0, 0, 4, 256);
    c.fillStyle = "rgba(255,255,255,0.95)"; c.fillRect(0, 0, 4, 4);
    c.fillStyle = "rgba(255,111,216,0.9)"; c.fillRect(0, 78, 4, 6); c.fillRect(0, 90, 4, 3);
  }
  // No outline on the panes: on a large transparent pane the outline hull shows through as a dark sheet. The trim
  // frames draw the cartoon edges instead.
  const frostM = noLine(toon("#ffffff", { map: frost.tex, transparent: true, depthWrite: false }));
  const clearM = noLine(toon("#bfe9ff", { transparent: true, opacity: 0.16, depthWrite: false }));
  const posts = new Map<string, [number, number]>();
  const pane = (axis: "x" | "z", c: number, a0: number, a1: number, y0: number, h: number, mat: THREE.Material) => {
    if (a1 - a0 < 0.01) return;
    const len = a1 - a0, mid = (a0 + a1) / 2;
    const m = mesh(axis === "x" ? new THREE.BoxGeometry(len, h, PANE) : new THREE.BoxGeometry(PANE, h, len), mat, false, false);
    m.position.set(axis === "x" ? mid : c, y0 + h / 2, axis === "x" ? c : mid);
    g4.add(m);
  };
  const rail = (axis: "x" | "z", c: number, a0: number, a1: number, y0: number, h: number) => {
    const len = a1 - a0, mid = (a0 + a1) / 2;
    boxAt(g4, axis === "x" ? len : 0.12, h, axis === "x" ? 0.12 : len, axis === "x" ? mid : c, y0, axis === "x" ? c : mid, M.trim, 0.03, false);
  };
  /** One glass wall from a0 to a1 along `axis` (x: at z = c, z: at x = c); `gap` leaves a door opening below FROST. */
  const glassWall = (axis: "x" | "z", c: number, a0: number, a1: number, gap?: [number, number]) => {
    const lower: [number, number][] = gap ? [[a0, gap[0]], [gap[1], a1]] : [[a0, a1]];
    for (const [s0, s1] of lower) {
      pane(axis, c, s0, s1, F4 + 0.12, FROST - 0.12, frostM);
      rail(axis, c, s0, s1, F4, 0.12);
    }
    pane(axis, c, a0, a1, F4 + FROST, TOP - FROST, clearM);
    rail(axis, c, a0, a1, F4 + FROST - 0.05, 0.1);
    rail(axis, c, a0, a1, F4 + TOP - 0.06, 0.12);
    // posts at the ends, at the door and about every 2.9 between them
    const at = new Set([a0, a1, ...(gap ?? [])]);
    const n = Math.max(1, Math.round((a1 - a0) / 2.9));
    for (let i = 1; i < n; i++) {
      const a = a0 + ((a1 - a0) * i) / n;
      if (!gap || a < gap[0] - 0.4 || a > gap[1] + 0.4) at.add(a);
    }
    for (const a of at) {
      const [x, z] = axis === "x" ? [a, c] : [c, a];
      posts.set(`${x.toFixed(2)},${z.toFixed(2)}`, [x, z]);
    }
  };
  const BACK = -7.6;
  const fronts = [-12.6, ...ROOM_WALLS, ROOM_RIGHT_X];
  ROOM_XS.forEach((cx, i) => glassWall("x", ROOM_FRONT_Z, fronts[i], fronts[i + 1], [cx - DOOR_HALF, cx + DOOR_HALF]));
  for (const x of [...ROOM_WALLS, ROOM_RIGHT_X]) glassWall("z", x, BACK, ROOM_FRONT_Z);
  for (const [x, z] of posts.values()) boxAt(g4, 0.14, TOP, 0.14, x, F4, z, M.trim, 0.03, false);

  // rooms: table, seats, laptops, screen, strip
  const rooms: MeetingRoomProp[] = ROOM_XS.map((cx, ri) => {
    const tableTop = toon(["#d9a066", "#c98a4b", "#e0b07a"][ri]);
    boxAt(g4, TABLE_HALF_X * 2, 0.14, TABLE_HALF_Z * 2, cx, F4 + 0.95, TABLE_Z, tableTop, 0.07);
    for (const dz of [-0.95, 0.95]) cyl(g4, 0.12, 0.32, 0.95, cx, F4, TABLE_Z + dz, M.dark, 14);
    // team screen above the head seat
    boxAt(g4, 4.9, 2.3, 0.16, cx, F4 + 1.75, -7.5, M.dark, 0.06);
    const screen = canvasTex(MEETING_SCREEN_W, MEETING_SCREEN_H);
    const sc = mesh(new THREE.PlaneGeometry(4.6, 2.0), noLine(flat("#ffffff", { map: screen.tex })), false, false);
    sc.position.set(cx, F4 + 2.9, -7.41); g4.add(sc);
    const strip = mesh(rbox(4.6, 0.12, 0.06, 0.02), flat(MEETING_IDLE)) as BasicMesh;
    strip.position.set(cx, F4 + 1.62, -7.42); g4.add(strip);
    const roomSeats = seats.filter((s) => s.roomIndex === ri).sort((p, q) => p.seat - q.seat).map((place) => buildSeat(b, g4, place));
    // sliding door: a frosted leaf on the corridor side of the front wall, slides left over the glass to open
    const door = new THREE.Group(); door.position.set(cx, F4, ROOM_FRONT_Z + 0.1); g4.add(door);
    const leaf = new THREE.Group(); door.add(leaf);
    const lp = mesh(new THREE.BoxGeometry(DOOR_HALF * 2, FROST - 0.1, 0.05), frostM, false, false);
    lp.position.y = 0.05 + (FROST - 0.1) / 2; leaf.add(lp);
    for (const sx of [-DOOR_HALF, DOOR_HALF]) boxAt(leaf, 0.07, FROST - 0.1, 0.08, sx, 0.05, 0, M.trim, 0.02, false);
    boxAt(leaf, 0.05, 0.6, 0.12, DOOR_HALF - 0.22, 0.8, 0, M.steel, 0.02, false);
    return { screen, strip, seats: roomSeats, center: new THREE.Vector3(cx, F4 + 1.1, TABLE_Z), door: { leaf, open: 0, x: cx } };
  });

  // lift: the glass tube from floor 3 continues up to a lid above this floor
  const glassM = thin(toon("#bfe9ff", { transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false }), 0.7);
  const tube = mesh(new THREE.CylinderGeometry(0.95, 0.95, 5.6, 32, 1, true, LIFT_GAP + 0.7, Math.PI * 2 - 1.4), glassM, false, false);
  tube.position.set(LIFT_X, F4, LIFT_Z); g4.add(tube);
  cyl(g4, 1.12, 1.12, 0.14, LIFT_X, F4 + 2.8, LIFT_Z, M.dark, 32);
  for (const y of [F4 + 0.05]) { // rings only at floor level (none floating under the lid)
    const r = mesh(new THREE.TorusGeometry(0.97, 0.05, 8, 40), noLine(flat("#ff6fd8")), false, false);
    r.rotation.x = Math.PI / 2; r.position.set(LIFT_X, y, LIFT_Z); g4.add(r);
  }

  // corridor: sign on the left wall, plants, labels
  const sign = canvasTex(360, 110) as Floor4["sign"];
  sign.draw = () => {
    const c = sign.ctx;
    c.fillStyle = "#1b1530"; c.fillRect(0, 0, 360, 110);
    c.font = `40px ${fonts.bungee}`; c.textAlign = "center";
    c.fillStyle = "#ff6fd8"; c.fillText("MEETING", 180, 50);
    c.fillStyle = "#7fe3d0"; c.font = `30px ${fonts.bungee}`; c.fillText("RUANG TIM", 180, 94);
    sign.tex.needsUpdate = true;
  };
  const sg = mesh(new THREE.PlaneGeometry(2.6, 0.8), noLine(flat("#ffffff", { map: sign.tex })), false, false);
  sg.position.set(-12.55, F4 + 2.7, 4.6); sg.rotation.y = Math.PI / 2; g4.add(sg);
  boxAt(g4, 0.08, 0.92, 2.72, -12.6, F4 + 2.24, 4.6, M.dark, 0.03);
  alienPlant(b, tentacles, g4, -12.0, F4, 7.3, 0.8);
  alienPlant(b, tentacles, g4, 12.2, F4, 7.3, 0.8);
  ROOM_XS.forEach((cx, i) => roomLabel(b, g4, MEETING_ROOMS[i].toUpperCase(), cx, F4 + 0.2, 1.8, 4));
  roomLabel(b, g4, "LIFT", LIFT_X, F4 + 0.2, LIFT_Z + 1.6, 4);

  // flying task cards (pool)
  const cards: FlyCard[] = [0, 1, 2].map(() => {
    const m = mesh(rbox(0.26, 0.02, 0.34, 0.01), toon("#fff6e3"), false, false) as FlyCard["m"];
    m.visible = false;
    g4.add(m);
    return { m, from: new THREE.Vector3(), to: new THREE.Vector3(), t: 1 };
  });

  if (rooms.some((r) => r.seats.length !== SEATS_PER_ROOM)) throw new Error("meeting seats: expected 5 per room");
  return { rooms, sign, cards };
}

/** Hover chair (like a desk chair) at the seat, plus a laptop on the table in front of it. */
function buildSeat(b: Build, g4: THREE.Group, place: SeatPlace): MeetingSeatProp {
  const { M } = b;
  const { toon, flat } = b.kit;
  const chair = new THREE.Group(); chair.position.copy(place.final); g4.add(chair);
  chair.add(mesh(new THREE.CylinderGeometry(0.58, 0.5, 0.14, 24), toon("#5d4f99")).translateY(0.58));
  const ring = mesh(new THREE.TorusGeometry(0.42, 0.05, 8, 28), noLine(flat(MEETING_IDLE)), false, false) as BasicMesh;
  ring.rotation.x = Math.PI / 2; ring.position.y = 0.36; chair.add(ring);
  const glow = mesh(new THREE.CircleGeometry(0.6, 24), noLine(flat(MEETING_IDLE, { transparent: true, opacity: 0 })), false, false) as BasicMesh;
  glow.rotation.x = -Math.PI / 2; glow.position.y = 0.012; chair.add(glow);
  // laptop: 0.75 in front of the seat, on the table, screen facing the sitter
  const f = new THREE.Vector3(Math.sin(place.face), 0, Math.cos(place.face));
  const lap = new THREE.Group(); lap.position.copy(place.final).addScaledVector(f, 0.75); lap.position.y = F4 + 1.09; lap.rotation.y = place.face; g4.add(lap);
  lap.add(mesh(rbox(0.52, 0.03, 0.36, 0.01), M.steel));
  const lid = new THREE.Group(); lid.position.set(0, 0.015, 0.17); lid.rotation.x = 0.35; lap.add(lid);
  lid.add(mesh(rbox(0.52, 0.34, 0.025, 0.01), M.dark).translateY(0.17));
  const screen = mesh(new THREE.PlaneGeometry(0.46, 0.28), noLine(flat("#150e2c")), false, false) as BasicMesh;
  // the lid leans away from the sitter; its screen faces back toward the seat (-z of the laptop)
  screen.position.set(0, 0.17, -0.014); screen.rotation.y = Math.PI; lid.add(screen);
  return { place, chair, ring, glow, screen };
}

/** Doors slide open while someone is at them (agent positions on floor 4, world-group coordinates). */
export function stepDoors(rooms: MeetingRoomProp[], at: THREE.Vector3[], dt: number) {
  for (const { door } of rooms) {
    const near = at.some((p) => Math.abs(p.y - F4) < 1 && Math.abs(p.x - door.x) < DOOR_HALF + 0.9 && Math.abs(p.z - ROOM_FRONT_Z) < 1.6);
    door.open += ((near ? 1 : 0) - door.open) * Math.min(1, dt * 7);
    door.leaf.position.x = -DOOR_SLIDE * door.open;
  }
}

/** Advance the flying cards (arc from the leader's seat to the new member's). */
export function stepCards(cards: FlyCard[], dt: number) {
  for (const c of cards) {
    if (c.t >= 1) continue;
    c.t = Math.min(1, c.t + dt / CARD_SECONDS);
    c.m.position.lerpVectors(c.from, c.to, c.t);
    c.m.position.y += Math.sin(c.t * Math.PI) * 0.9;
    c.m.rotation.y = c.t * Math.PI * 2;
    if (c.t >= 1) c.m.visible = false;
  }
}

/** Start a card from `from` to `to` (seat positions); skipped when all three are in the air. */
export function flyCard(cards: FlyCard[], from: THREE.Vector3, to: THREE.Vector3, color: string) {
  const c = cards.find((k) => k.t >= 1);
  if (!c) return;
  c.from.copy(from).setY(F4 + 1.2);
  c.to.copy(to).setY(F4 + 1.2);
  c.t = 0;
  c.m.material.color.set(color);
  c.m.position.copy(c.from);
  c.m.visible = true;
}
