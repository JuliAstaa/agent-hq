// Floor 4 "Meeting" (prd.md §7.9): three meeting rooms side by side along the back wall (table, five seats with
// laptops, team screen, accent strip), a corridor from the lift, and the lift tube continuing up from floor 3.
// Not in the prototype.

import * as THREE from "three";
import { F3, F4 } from "../constants";
import type { Fonts } from "../scene/fonts";
import { boxAt, canvasTex, cyl, mesh, noLine, rbox, thin, type CanvasTex } from "../scene/kit";
import { ROOM_WALLS, ROOM_XS, TABLE_HALF_X, TABLE_HALF_Z, TABLE_Z, type SeatPlace } from "../nav/places";
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

  // glass partitions between the rooms (low enough to see over from the camera)
  const glass = thin(toon("#bfe9ff", { transparent: true, opacity: 0.25, side: THREE.DoubleSide, depthWrite: false }), 0.7);
  const PZ0 = -7.6, PZ1 = 1.0, PH = 2.3;
  for (const x of ROOM_WALLS) {
    const pane = mesh(new THREE.BoxGeometry(0.06, PH - 0.2, PZ1 - PZ0), glass, false, false);
    pane.position.set(x, F4 + 0.1 + (PH - 0.2) / 2, (PZ0 + PZ1) / 2); g4.add(pane);
    boxAt(g4, 0.16, 0.12, PZ1 - PZ0 + 0.1, x, F4, (PZ0 + PZ1) / 2, M.trim, 0.03);
    boxAt(g4, 0.16, 0.12, PZ1 - PZ0 + 0.1, x, F4 + PH - 0.1, (PZ0 + PZ1) / 2, M.trim, 0.03);
    boxAt(g4, 0.18, PH, 0.18, x, F4, PZ1, M.trim, 0.03);
  }

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
    return { screen, strip, seats: roomSeats, center: new THREE.Vector3(cx, F4 + 1.1, TABLE_Z) };
  });

  // lift: the glass tube from floor 3 continues up to a lid above this floor
  const glassM = thin(toon("#bfe9ff", { transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false }), 0.7);
  const tube = mesh(new THREE.CylinderGeometry(0.95, 0.95, 5.6, 32, 1, true, LIFT_GAP + 0.7, Math.PI * 2 - 1.4), glassM, false, false);
  tube.position.set(LIFT_X, F4, LIFT_Z); g4.add(tube);
  cyl(g4, 1.12, 1.12, 0.14, LIFT_X, F4 + 2.8, LIFT_Z, M.dark, 32);
  for (const y of [F4 + 0.05, F4 + 2.7]) {
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
