// Back tier, middle: "Meeting" (prd.md §7.9, deviation 29): three enclosed meeting rooms side by side along the back
// wall (frosted glass walls 2.6 high in slim frames, a sliding frosted door each; table, five seats with laptops, team
// screen, accent strip), opening onto the back street. Not in the prototype. Was floor 4 until the single-floor layout;
// the rooms are 6.8 wide now (8.4 before) and room A got a glass wall of its own on the Security side.

import * as THREE from "three";
import { T2, X_SEC_END, X_SERVER, Z_BACK } from "../layout";
import type { Fonts } from "../scene/fonts";
import { boxAt, canvasTex, cyl, mesh, noLine, rbox, thin, type CanvasTex } from "../scene/kit";
import { DOOR_HALF, ROOM_BACK_Z, ROOM_FRONT_Z, ROOM_LEFT_X, ROOM_RIGHT_X, ROOM_WALLS, ROOM_XS, TABLE_HALF_X, TABLE_HALF_Z, TABLE_Z, type SeatPlace } from "../nav/places";
import { MEETING_ROOMS, SEATS_PER_ROOM } from "@/lib/meeting";
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
  screenMesh: THREE.Mesh;
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

export interface MeetingFloor {
  rooms: MeetingRoomProp[];
  sign: CanvasTex & { draw: () => void };
  cards: FlyCard[];
}

export const MEETING_SCREEN_W = 640, MEETING_SCREEN_H = 280;
/** Accent color of an empty room's strip and chairs. */
export const MEETING_IDLE = "#3a3360";
const CARD_SECONDS = 0.6;
/** Frosted glass walls WALL_H high (the camera sees the seated agents over them), door opening DOOR_H high. */
const WALL_H = 2.6, DOOR_H = 2.25, PANE = 0.05;
/** How far the door leaf slides to open (its width plus a little). */
const DOOR_SLIDE = DOOR_HALF * 2 + 0.05;

export function buildMeeting(b: Build, g4: THREE.Group, fonts: Fonts, seats: SeatPlace[]): MeetingFloor {
  const { M } = b;
  const { toon, flat } = b.kit;

  const rug = (x0: number, x1: number, z0: number, z1: number, c: string) => {
    const m = mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0), noLine(toon(c)), false, true);
    m.rotation.x = -Math.PI / 2; m.position.set((x0 + x1) / 2, T2 + 0.012, (z0 + z1) / 2); g4.add(m);
  };

  // back wall: one color per room (Security's wall ends at X_SEC_END, the server room's starts at X_SERVER)
  const roomWall = [toon("#f4bfd6"), toon("#bfe6d3"), toon("#ffd8a8")];
  const edges = [X_SEC_END, ...ROOM_WALLS, X_SERVER];
  roomWall.forEach((mat, i) => makeWall(b, g4, "x", Z_BACK, edges[i], edges[i + 1], T2, 4.4, [], mat));
  boxAt(g4, X_SERVER - X_SEC_END, 0.18, 0.56, (X_SEC_END + X_SERVER) / 2, T2 + 4.4, Z_BACK, M.trim, 0.04);
  boxAt(g4, X_SERVER - X_SEC_END, 0.25, 0.48, (X_SEC_END + X_SERVER) / 2, T2, Z_BACK, M.dark, 0.04);
  ROOM_XS.forEach((cx, i) => rug(cx - 3.1, cx + 3.1, ROOM_BACK_Z + 0.2, ROOM_FRONT_Z - 0.2, ["#6b4a8f", "#2f7a63", "#9a5a3a"][i]));

  // Enclosed rooms like an ordinary office: frosted glass walls 2.6 high in slim frames (no frame grid, no clear glass
  // above, so the team screens on the back wall stay in view). The film is dense, with three etched lines near the top.
  // The panes write depth: the outlines of chairs and tables behind them are hidden too, so the glass reads as frosted
  // instead of showing sharp furniture lines through it. Seated agents stay visible from the camera over the walls.
  const film = (lines: boolean) => {
    const t = canvasTex(4, 256);
    const c = t.ctx;
    const grad = c.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, "rgba(244,248,255,0.86)");
    grad.addColorStop(1, "rgba(236,243,252,0.94)");
    c.fillStyle = grad; c.fillRect(0, 0, 4, 256);
    c.fillStyle = "rgba(255,255,255,0.98)"; c.fillRect(0, 0, 4, 3);
    if (lines) {
      c.fillStyle = "rgba(196,218,246,0.6)";
      for (const y of [30, 40, 50]) c.fillRect(0, y, 4, 4);
    }
    return t.tex;
  };
  // No outline on the panes: on a large transparent pane the outline hull shows as a dark sheet. The frames draw the edges.
  const glassOpts = { transparent: true, depthWrite: true };
  const frostM = noLine(toon("#ffffff", { map: film(true), ...glassOpts }));
  const plainM = noLine(toon("#ffffff", { map: film(false), ...glassOpts }));
  const frameM = thin(toon("#f3efe6"), 0.55);
  const pane = (axis: "x" | "z", c: number, a0: number, a1: number, y0: number, h: number, mat: THREE.Material) => {
    if (a1 - a0 < 0.01) return;
    const len = a1 - a0, mid = (a0 + a1) / 2;
    const m = mesh(axis === "x" ? new THREE.BoxGeometry(len, h, PANE) : new THREE.BoxGeometry(PANE, h, len), mat, false, false);
    m.position.set(axis === "x" ? mid : c, y0 + h / 2, axis === "x" ? c : mid);
    g4.add(m);
  };
  const bar = (axis: "x" | "z", c: number, a0: number, a1: number, y0: number, h: number) => {
    const len = a1 - a0, mid = (a0 + a1) / 2;
    boxAt(g4, axis === "x" ? len : 0.09, h, axis === "x" ? 0.09 : len, axis === "x" ? mid : c, y0, axis === "x" ? c : mid, frameM, 0.02, false);
  };
  const posts = new Map<string, [number, number, number]>();
  const post = (x: number, z: number, h: number) => {
    const k = `${x.toFixed(2)},${z.toFixed(2)}`;
    posts.set(k, [x, z, Math.max(h, posts.get(k)?.[2] ?? 0)]);
  };
  /** One frosted wall from a0 to a1 along `axis` (x: at z = c, z: at x = c); `gap` leaves a door opening. */
  const glassWall = (axis: "x" | "z", c: number, a0: number, a1: number, gap?: [number, number]) => {
    const spans: [number, number][] = gap ? [[a0, gap[0]], [gap[1], a1]] : [[a0, a1]];
    for (const [s0, s1] of spans) {
      pane(axis, c, s0, s1, T2 + 0.07, WALL_H - 0.1, frostM);
      bar(axis, c, s0, s1, T2, 0.07); // floor channel (none across the door)
    }
    if (gap) {
      pane(axis, c, gap[0], gap[1], T2 + DOOR_H + 0.05, WALL_H - DOOR_H - 0.08, plainM); // above the door
      bar(axis, c, gap[0], gap[1], T2 + DOOR_H, 0.06); // door head
    }
    bar(axis, c, a0, a1, T2 + WALL_H - 0.04, 0.06); // top cap
    for (const a of [a0, a1, ...(gap ?? [])]) post(axis === "x" ? a : c, axis === "x" ? c : a, WALL_H);
  };
  const BACK = ROOM_BACK_Z;
  const fronts = [ROOM_LEFT_X, ...ROOM_WALLS, ROOM_RIGHT_X];
  ROOM_XS.forEach((cx, i) => glassWall("x", ROOM_FRONT_Z, fronts[i], fronts[i + 1], [cx - DOOR_HALF, cx + DOOR_HALF]));
  for (const x of fronts) glassWall("z", x, BACK, ROOM_FRONT_Z);
  for (const [x, z, h] of posts.values()) boxAt(g4, 0.09, h, 0.09, x, T2, z, frameM, 0.02, false);

  // rooms: table, seats, laptops, screen, strip
  const rooms: MeetingRoomProp[] = ROOM_XS.map((cx, ri) => {
    const tableTop = toon(["#d9a066", "#c98a4b", "#e0b07a"][ri]);
    boxAt(g4, TABLE_HALF_X * 2, 0.14, TABLE_HALF_Z * 2, cx, T2 + 0.95, TABLE_Z, tableTop, 0.07);
    for (const dz of [-0.95, 0.95]) cyl(g4, 0.12, 0.32, 0.95, cx, T2, TABLE_Z + dz, M.dark, 14);
    // team screen above the head seat
    boxAt(g4, 4.9, 2.3, 0.16, cx, T2 + 1.75, Z_BACK + 0.3, M.dark, 0.06);
    const screen = canvasTex(MEETING_SCREEN_W, MEETING_SCREEN_H);
    const sc = mesh(new THREE.PlaneGeometry(4.6, 2.0), noLine(flat("#ffffff", { map: screen.tex })), false, false);
    sc.position.set(cx, T2 + 2.9, Z_BACK + 0.39); g4.add(sc);
    const strip = mesh(rbox(4.6, 0.12, 0.06, 0.02), flat(MEETING_IDLE)) as BasicMesh;
    strip.position.set(cx, T2 + 1.62, Z_BACK + 0.38); g4.add(strip);
    const roomSeats = seats.filter((s) => s.roomIndex === ri).sort((p, q) => p.seat - q.seat).map((place) => buildSeat(b, g4, place));
    // sliding door: a frosted leaf on the corridor side of the front wall, slides left over the glass to open
    const door = new THREE.Group(); door.position.set(cx, T2, ROOM_FRONT_Z + 0.1); g4.add(door);
    const leaf = new THREE.Group(); door.add(leaf);
    const lh = DOOR_H - 0.06;
    const lp = mesh(new THREE.BoxGeometry(DOOR_HALF * 2, lh, 0.04), plainM, false, false);
    lp.position.y = 0.03 + lh / 2; leaf.add(lp);
    for (const sx of [-DOOR_HALF, DOOR_HALF]) boxAt(leaf, 0.06, lh, 0.07, sx, 0.03, 0, frameM, 0.02, false);
    boxAt(leaf, 0.05, 0.7, 0.1, DOOR_HALF - 0.2, 0.75, 0.04, M.dark, 0.02, false); // pull handle
    return { screen, screenMesh: sc, strip, seats: roomSeats, center: new THREE.Vector3(cx, T2 + 1.1, TABLE_Z), door: { leaf, open: 0, x: cx } };
  });

  // sign on a post at the left end of the street, beside the stairs from the office
  const sign = canvasTex(360, 110) as MeetingFloor["sign"];
  sign.draw = () => {
    const c = sign.ctx;
    c.fillStyle = "#1b1530"; c.fillRect(0, 0, 360, 110);
    c.font = `40px ${fonts.bungee}`; c.textAlign = "center";
    c.fillStyle = "#ff6fd8"; c.fillText("MEETING", 180, 50);
    c.fillStyle = "#7fe3d0"; c.font = `30px ${fonts.bungee}`; c.fillText("RUANG TIM", 180, 94);
    sign.tex.needsUpdate = true;
  };
  {
    const SX = ROOM_LEFT_X + 0.6, SZ = -8.75;
    cyl(g4, 0.05, 0.05, 2.0, SX, T2, SZ, M.dark, 8);
    boxAt(g4, 2.08, 0.72, 0.08, SX, T2 + 1.95, SZ - 0.05, M.dark, 0.03);
    const sg = mesh(new THREE.PlaneGeometry(1.96, 0.6), noLine(flat("#ffffff", { map: sign.tex })), false, false);
    sg.position.set(SX, T2 + 2.31, SZ); g4.add(sg);
  }
  ROOM_XS.forEach((cx, i) => roomLabel(b, g4, MEETING_ROOMS[i].toUpperCase(), cx, T2 + 0.2, ROOM_FRONT_Z + 0.8, "meeting"));

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
  const lap = new THREE.Group(); lap.position.copy(place.final).addScaledVector(f, 0.75); lap.position.y = T2 + 1.09; lap.rotation.y = place.face; g4.add(lap);
  lap.add(mesh(rbox(0.52, 0.03, 0.36, 0.01), M.steel));
  const lid = new THREE.Group(); lid.position.set(0, 0.015, 0.17); lid.rotation.x = 0.35; lap.add(lid);
  lid.add(mesh(rbox(0.52, 0.34, 0.025, 0.01), M.dark).translateY(0.17));
  const screen = mesh(new THREE.PlaneGeometry(0.46, 0.28), noLine(flat("#150e2c")), false, false) as BasicMesh;
  // the lid leans away from the sitter; its screen faces back toward the seat (-z of the laptop)
  screen.position.set(0, 0.17, -0.014); screen.rotation.y = Math.PI; lid.add(screen);
  return { place, chair, ring, glow, screen };
}

/** Doors slide open while someone is at them (agent positions on the back tier, world-group coordinates). */
export function stepDoors(rooms: MeetingRoomProp[], at: THREE.Vector3[], dt: number) {
  for (const { door } of rooms) {
    const near = at.some((p) => Math.abs(p.y - T2) < 1 && Math.abs(p.x - door.x) < DOOR_HALF + 0.9 && Math.abs(p.z - ROOM_FRONT_Z) < 1.6);
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
  c.from.copy(from).setY(T2 + 1.2);
  c.to.copy(to).setY(T2 + 1.2);
  c.t = 0;
  c.m.material.color.set(color);
  c.m.position.copy(c.from);
  c.m.visible = true;
}
