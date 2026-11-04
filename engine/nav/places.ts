// Places an agent can go: lounge spots, home desks, floor-3 stations (prd.md §9, §10).
// Every place is a chain hub -> via points -> final position, with a facing angle.
// Reservations (occ) are per engine instance: create fresh objects with createSpots()/createDeskPlaces().

import * as THREE from "three";
import { F2, F3, F4, type Activity } from "../constants";
import { MEETING_ROOMS, SEATS_PER_ROOM } from "@/lib/meeting";
import type { Dept } from "@/lib/teams";
import { DEPTS } from "@/lib/teams";

export type PoseName = "desk" | "walk" | "stand" | "sit" | "stool" | "recline" | "lie";

interface PlaceBase {
  room: string;
  floor: number;
  hub: string;
  via: THREE.Vector3[];
  final: THREE.Vector3;
  face: number;
  /** Reserving agent id (spots and stations; desks are owned through the slot). */
  occ: string | null;
}
export interface SpotPlace extends PlaceBase {
  kind: "spot";
  id: string;
  types: Activity[];
  pose: PoseName;
}
export interface DeskPlace extends PlaceBase {
  kind: "desk";
}
export interface StationPlace extends PlaceBase {
  kind: "station";
  dept: Dept;
  /** Index among all stations (0..10), for tests and debug. */
  index: number;
}
/** A spot in front of the task board where an agent picks up a new task card (deviation 14). */
export interface BoardPlace extends PlaceBase {
  kind: "board";
  /** Slot index 0..2, matching the card pinned in front of it. */
  index: number;
}
/** Meeting floor seat (prd.md §7.9). Assigned by the store (Agent.meeting), not picked by the engine. */
export interface SeatPlace extends PlaceBase {
  kind: "seat";
  /** Room 0..2 (Meeting A, B, C) and seat 0..4 (0 = head seat). */
  roomIndex: number;
  seat: number;
  /** roomIndex * SEATS_PER_ROOM + seat. */
  index: number;
}
export type Place = SpotPlace | DeskPlace | StationPlace | BoardPlace | SeatPlace;

const PI = Math.PI;
type XZ = [number, number];

export function createSpots(): SpotPlace[] {
  const out: SpotPlace[] = [];
  const spot = (id: string, room: string, floor: 1 | 2, hub: string, via: XZ[], final: XZ, face: number, types: Activity[], pose: PoseName) => {
    const y = floor === 2 ? F2 : 0;
    out.push({ kind: "spot", id, room, floor, hub, via: via.map((p) => new THREE.Vector3(p[0], y, p[1])), final: new THREE.Vector3(final[0], y, final[1]), face, types, pose, occ: null });
  };
  // Lt.1 - lounge
  for (const x of [-9.3, -8.0, -6.7]) spot("sofa" + x, "Lounge", 1, "LH", [[-4.6, -4.65], [x, -4.65]], [x, -3.75], PI, ["tv", "tv", "phone"], "sit");
  spot("beanL", "Lounge", 1, "LH", [[-4.6, -4.65], [-11.4, -4.65]], [-11.6, -6.2], 1.92, ["lie_phone"], "recline");
  spot("beanR", "Lounge", 1, "LH", [[-4.6, -4.65]], [-4.4, -6.3], -1.89, ["lie_phone"], "recline");
  // pantry
  spot("coffee", "Pantry", 1, "PH", [[2.9, -2.8], [2.9, -5.4], [1.4, -5.4]], [1.4, -6.1], PI, ["coffee"], "stand");
  spot("fridge", "Pantry", 1, "PH", [[2.9, -2.8], [2.9, -5.0]], [4.2, -5.6], PI, ["fridge"], "stand");
  spot("stoolL", "Pantry", 1, "PH", [[-1.8, -2.8], [-1.8, -4.3]], [-0.55, -4.3], PI / 2, ["sip"], "stool");
  spot("stoolR", "Pantry", 1, "PH", [[2.9, -2.8], [2.9, -4.3]], [1.95, -4.3], -PI / 2, ["sip"], "stool");
  // game room
  spot("arcade", "Game Room", 1, "GH", [[6.6, -3.4]], [6.6, -5.85], PI, ["arcade"], "stand");
  spot("ping", "Game Room", 1, "GH", [[7.6, -3.4]], [7.6, -5.0], PI / 2, ["pingpong"], "stand");
  // rebahan
  spot("futonA", "Ruang Rebahan", 1, "NH", [[-11.6, 2.2]], [-11.6, 4.65], 0, ["nap", "nap", "lie_phone"], "lie");
  spot("futonB", "Ruang Rebahan", 1, "NH", [[-9.3, 2.2]], [-9.3, 4.65], 0, ["nap", "lie_phone"], "lie");
  // Lt.2
  spot("winA", "Jendela", 2, "Top2", [[10.4, -5.6]], [10.4, -6.95], PI, ["gaze"], "stand");
  spot("winB", "Jendela", 2, "Top2", [[12.1, -5.6]], [12.1, -6.95], PI, ["gaze"], "stand");
  // "Ruang Rapat" in the prototype, renamed for the meeting floor (deviation 24).
  spot("board", "Ruang Kreatif", 2, "Kf2", [[-10.0, 5.0]], [-11.6, 6.3], -PI / 2, ["whiteboard"], "stand");
  spot("cardL", "Ruang Kreatif", 2, "Kf2", [[-10.0, 5.0]], [-9.4, 6.4], PI / 2, ["cards"], "stool");
  spot("cardR", "Ruang Kreatif", 2, "Kf2", [[-6.4, 5.0]], [-7.0, 6.4], -PI / 2, ["cards"], "stool");
  spot("readA", "Pojok Baca", 2, "Kf1", [[-4.4, 7.5], [-2.2, 7.5]], [-2.2, 6.85], 0, ["read"], "sit");
  spot("readB", "Pojok Baca", 2, "Kf1", [[-4.4, 7.5], [0.6, 7.5]], [0.6, 6.85], 0, ["read"], "sit");
  return out;
}

/** 9 home desks on floor 2: 3 rows x 3, slot index = row * 3 + column. */
// Deviation 8 (plan-m1.md): like the floor-3 stations, the chair is on the front side (+z) and the agent faces
// the back wall, looking at a monitor that faces it (and the camera). Rows moved back 0.8 so the aisle in front
// of each row (K2, K3, K4) clears the chairs.
export const DESK_ROWS = [
  { z: -5.4, aisle: -3.0 },
  { z: -1.8, aisle: 0.6 },
  { z: 1.8, aisle: 4.0 },
];
// Deviation 17 (plan-m1.md): 9 desks (3 x 3) instead of 12. The outer columns stay where they were (the task-board
// walkway and the aisles are unchanged); the middle column sits halfway between them.
export const DESK_XS = [-9.6, -4.2, 1.2];
/** Walkways through the gaps between desk columns (deviation 18). */
export const DESK_GAPS = [-6.9, -1.5];

/**
 * Office grid node on floor 2 (deviation 18): aisle z (one of DESK_ROWS[].aisle) x column. The graph links them along
 * each aisle and across aisles through the desk gaps and the left wall walkway (BOARD_X), so an agent walks the
 * short way between the task board and any desk instead of detouring via the right-hand K column.
 */
export const officeNode = (aisle: number, x: number) => `O${aisle}:${x}`;

export interface DeskSlot {
  x: number;
  z: number;
  place: DeskPlace;
}

export function createDeskSlots(): DeskSlot[] {
  const out: DeskSlot[] = [];
  for (const r of DESK_ROWS) {
    for (const x of DESK_XS) {
      // hub: the desk's own spot on its aisle, then straight to the chair
      out.push({ x, z: r.z, place: { kind: "desk", room: "Meja kerja", floor: 2, hub: officeNode(r.aisle, x), via: [], final: new THREE.Vector3(x, F2, r.z + 1.05), face: Math.PI, occ: null } });
    }
  }
  return out;
}

/** Floor-3 station layout: [dept, x, z, hub, aisleX, aisleZ] in build order. */
export const STATION_LAYOUT: [Dept, number, number, string, number, number][] = [
  ...[-5.2, -1.6].flatMap((z) => [-10.6, -7.0].map((x) => ["red", x, z, "RH", -4.9, z + 2.1] as [Dept, number, number, string, number, number])),
  ...[-1.8, 1.8].map((x) => ["report", x, -5.2, "RPH", 0, -3.1] as [Dept, number, number, string, number, number]),
  ["report", -1.8, -1.6, "RPH", -1.8, 0.5],
  ...[-4.6, -1.0].flatMap((z) => [6.4, 10.2].map((x) => ["blue", x, z, "BH", 8.3, z + 2.1] as [Dept, number, number, string, number, number])),
];

export function stationPlace(index: number): StationPlace {
  const [dept, x, z, hub, aisleX, aisleZ] = STATION_LAYOUT[index];
  return {
    kind: "station", dept, index, room: DEPTS[dept].room, floor: 3, hub,
    via: [new THREE.Vector3(aisleX, F3, aisleZ), new THREE.Vector3(x, F3, aisleZ)],
    final: new THREE.Vector3(x, F3, z + 1.05), face: Math.PI, occ: null,
  };
}

/**
 * Task board ("PAPAN TUGAS", floor 2 left wall, deviation 14): three standing spots side by side in front of it.
 * Hub: the left wall walkway on the middle aisle (deviation 18), then straight down the gap between the wall and the
 * first desk column (x -11.75 keeps clear of both).
 */
export const BOARD_X = -11.75;
export const BOARD_SLOTS_Z = [0.95, 1.7, 2.45];

export function createBoardSlots(): BoardPlace[] {
  return BOARD_SLOTS_Z.map((z, index) => ({
    kind: "board", index, room: "Papan Tugas", floor: 2, hub: officeNode(DESK_ROWS[1].aisle, BOARD_X),
    via: [], final: new THREE.Vector3(BOARD_X, F2, z), face: -PI / 2, occ: null,
  }));
}

/* ---------------- floor 4: meeting rooms (prd.md §7.9) ---------------- */

/** Room centers along x (Meeting A, B, C). Rooms run from the back wall (z -7.6) to the corridor (z 1.0). */
export const ROOM_XS = [-8.4, 0, 8.6];
/** Room walls between the rooms (glass partitions), x. */
export const ROOM_WALLS = [-4.2, 4.2];
/** Table center z, half sizes. Seats sit 0.4 from its edge, like a desk chair. */
export const TABLE_Z = -3.6;
export const TABLE_HALF_X = 0.9;
export const TABLE_HALF_Z = 1.6;
/** Corridor walkway in front of the rooms (graph nodes M0..M2) and the lanes beside / behind each table. */
export const CORRIDOR_Z = 2.6;
const LANE_X = 2.3, ENTRY_Z = -0.8, BACK_Z = -6.7;
/** Seat 0 at the back facing the camera, then left front/back and right front/back facing the table. */
export const SEAT_LAYOUT: { dx: number; z: number; face: number }[] = [
  { dx: 0, z: TABLE_Z - TABLE_HALF_Z - 0.4, face: 0 },
  { dx: -(TABLE_HALF_X + 0.4), z: TABLE_Z + 0.8, face: PI / 2 },
  { dx: -(TABLE_HALF_X + 0.4), z: TABLE_Z - 0.8, face: PI / 2 },
  { dx: TABLE_HALF_X + 0.4, z: TABLE_Z + 0.8, face: -PI / 2 },
  { dx: TABLE_HALF_X + 0.4, z: TABLE_Z - 0.8, face: -PI / 2 },
];
export const roomNode = (room: number) => `M${room}`;

/** All 15 seats, index = room * 5 + seat. Paths keep to the lanes beside the table, never across it. */
export function createSeats(): SeatPlace[] {
  const out: SeatPlace[] = [];
  ROOM_XS.forEach((cx, roomIndex) => {
    SEAT_LAYOUT.slice(0, SEATS_PER_ROOM).forEach((s, seat) => {
      const side = seat === 0 ? -1 : Math.sign(s.dx);
      const lane = cx + side * LANE_X;
      const via = seat === 0
        ? [[lane, ENTRY_Z], [lane, BACK_Z], [cx, BACK_Z]]
        : [[lane, ENTRY_Z], [lane, s.z]];
      out.push({
        kind: "seat", roomIndex, seat, index: roomIndex * SEATS_PER_ROOM + seat, room: MEETING_ROOMS[roomIndex], floor: 4,
        hub: roomNode(roomIndex), via: via.map(([x, z]) => new THREE.Vector3(x, F4, z)),
        final: new THREE.Vector3(cx + s.dx, F4, s.z), face: s.face, occ: null,
      });
    });
  });
  return out;
}
