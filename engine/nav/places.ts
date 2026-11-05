// Places an agent can go: lounge spots, home desks, team stations, the task board, meeting seats (prd.md §9, §10).
// Every place is a chain hub -> via points -> final position, with a facing angle. Single-floor terraced layout
// (deviation 29, engine/layout.ts): all coordinates are world coordinates.
// Reservations (occ) are per engine instance: create fresh objects with createSpots()/createDeskSlots().

import * as THREE from "three";
import { type Activity } from "../constants";
import { STREET_B, STREET_M, T0, T1, T2 } from "../layout";
import { MEETING_ROOMS, SEATS_PER_ROOM } from "@/lib/meeting";
import type { Dept } from "@/lib/teams";
import { DEPTS } from "@/lib/teams";
import type { ZoneId } from "@/lib/zones";

export type PoseName = "desk" | "walk" | "stand" | "sit" | "stool" | "recline" | "lie";

interface PlaceBase {
  room: string;
  zone: ZoneId;
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
  /** Index among all stations (0..13), for tests and debug. */
  index: number;
}
/** A spot in front of the task board where an agent picks up a new task card (deviation 14). */
export interface BoardPlace extends PlaceBase {
  kind: "board";
  /** Slot index 0..2, matching the card pinned in front of it. */
  index: number;
}
/** Meeting seat (prd.md §7.9). Assigned by the store (Agent.meeting), not picked by the engine. */
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
  const spot = (id: string, room: string, zone: ZoneId, y: number, hub: string, via: XZ[], final: XZ, face: number, types: Activity[], pose: PoseName) => {
    out.push({ kind: "spot", id, room, zone, hub, via: via.map((p) => new THREE.Vector3(p[0], y, p[1])), final: new THREE.Vector3(final[0], y, final[1]), face, types, pose, occ: null });
  };
  // Front tier (Santai). Hubs sit on the front street (z 10.6).
  // lounge: sofa facing the TV, beanbags either side
  for (const x of [-24.9, -23.6, -22.3]) spot("sofa" + x, "Lounge", "santai", T0, "LH", [[-20.2, 7.35], [x, 7.35]], [x, 8.25], PI, ["tv", "tv", "phone"], "sit");
  spot("beanL", "Lounge", "santai", T0, "LH", [[-20.2, 7.35], [-27.0, 7.35]], [-27.2, 5.8], 1.92, ["lie_phone"], "recline");
  spot("beanR", "Lounge", "santai", T0, "LH", [[-20.2, 7.35]], [-20.0, 5.7], -1.89, ["lie_phone"], "recline");
  // pantry
  spot("coffee", "Pantry", "santai", T0, "PH", [[-6.7, 9.2], [-6.7, 6.6], [-8.2, 6.6]], [-8.2, 5.9], PI, ["coffee"], "stand");
  spot("fridge", "Pantry", "santai", T0, "PH", [[-6.7, 9.2], [-6.7, 7.0]], [-5.4, 6.4], PI, ["fridge"], "stand");
  spot("stoolL", "Pantry", "santai", T0, "PH", [[-11.4, 9.2], [-11.4, 7.7]], [-10.15, 7.7], PI / 2, ["sip"], "stool");
  spot("stoolR", "Pantry", "santai", T0, "PH", [[-6.7, 9.2], [-6.7, 7.7]], [-7.65, 7.7], -PI / 2, ["sip"], "stool");
  // game room
  spot("arcade", "Game Room", "santai", T0, "GH", [[9.6, 8.6]], [9.6, 6.15], PI, ["arcade"], "stand");
  spot("ping", "Game Room", "santai", T0, "GH", [[10.6, 8.6]], [10.6, 7.0], PI / 2, ["pingpong"], "stand");
  // nap area (in front of the lounge, pillows toward the street)
  spot("futonA", "Ruang Rebahan", "santai", T0, "NH", [[-26.6, 10.6]], [-26.6, 13.05], 0, ["nap", "nap", "lie_phone"], "lie");
  spot("futonB", "Ruang Rebahan", "santai", T0, "NH", [[-24.3, 10.6]], [-24.3, 13.05], 0, ["nap", "lie_phone"], "lie");
  // lobby benches either side of the floor emblem, facing the camera
  spot("benchA", "Lobby", "santai", T0, "H1", [[-0.6, 11.5]], [-0.6, 12.6], 0, ["park"], "sit");
  spot("benchB", "Lobby", "santai", T0, "GH", [[9.4, 11.5]], [9.4, 12.6], 0, ["park"], "sit");
  // terrace on the front-right corner, looking out at the moons (was "Jendela" on floor 2)
  spot("terasA", "Teras", "santai", T0, "TE", [[26.2, 11.2]], [27.6, 11.2], PI / 2, ["gaze"], "stand");
  spot("terasB", "Teras", "santai", T0, "TE", [[26.2, 13.8]], [27.6, 13.8], PI / 2, ["gaze"], "stand");
  // Middle tier (Kantor). Hubs sit on the middle street (z 3.0).
  // "Ruang Rapat" in the prototype, renamed for the meeting rooms (deviation 24).
  spot("board", "Ruang Kreatif", "kantor", T1, "MK", [[-10.2, 1.4]], [-10.2, -2.1], -PI / 2, ["whiteboard"], "stand");
  spot("cardL", "Ruang Kreatif", "kantor", T1, "MK", [[-8.0, 1.4]], [-8.0, -2.0], PI / 2, ["cards"], "stool");
  spot("cardR", "Ruang Kreatif", "kantor", T1, "MK", [[-5.6, 1.4]], [-5.6, -2.0], -PI / 2, ["cards"], "stool");
  spot("readA", "Pojok Baca", "kantor", T1, "MB", [[-2.4, -0.8]], [-2.4, -2.2], 0, ["read"], "sit");
  spot("readB", "Pojok Baca", "kantor", T1, "MB", [[0.4, -0.8]], [0.4, -2.2], 0, ["read"], "sit");
  // garden benches facing the camera, the pond behind them
  spot("parkA", "Taman", "kantor", T1, "MT", [[10.0, 0.4]], [10.0, -0.75], 0, ["park"], "sit");
  spot("parkB", "Taman", "kantor", T1, "MT", [[16.0, 0.4]], [16.0, -0.75], 0, ["park"], "sit");
  return out;
}

/** 9 home desks on the middle tier: 3 rows x 3, slot index = row * 3 + column. */
// Deviation 8 (plan-m1.md): like the team stations, the chair is on the front side (+z) and the agent faces the back,
// looking at a monitor that faces it (and the camera). Each row has its aisle in front of it; the front aisle is the
// middle tier's street.
export const DESK_ROWS = [
  { z: -6.4, aisle: -4.0 },
  { z: -2.8, aisle: -0.4 },
  { z: 0.8, aisle: STREET_M },
];
// Deviation 17 (plan-m1.md): 9 desks (3 x 3) instead of 12.
export const DESK_XS = [-25.4, -20.0, -14.6];
/** Walkways through the gaps between desk columns (deviation 18). */
export const DESK_GAPS = [-22.7, -17.3];
/** Right-hand walkway of the office (the "K" column), up to the stairs to Security. */
export const OFFICE_RIGHT_X = -12.2;

/**
 * Office grid node (deviation 18): aisle z (one of DESK_ROWS[].aisle) x column. The graph links them along each
 * aisle and across aisles through the desk gaps and the left wall walkway (BOARD_X), so an agent walks the short way
 * between the task board and any desk.
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
      out.push({ x, z: r.z, place: { kind: "desk", room: "Meja kerja", zone: "kantor", hub: officeNode(r.aisle, x), via: [], final: new THREE.Vector3(x, T1, r.z + 1.05), face: PI, occ: null } });
    }
  }
  return out;
}

/** Team station layout: [dept, x, z, hub, aisleX, aisleZ] in build order (y: back tier). Security's stations keep the
 *  floor-3 arrangement; the DevOps ("ops") stations stand in the server room. */
export type StationRow = [Dept, number, number, string, number, number];
export const STATION_LAYOUT: StationRow[] = [
  ...[-17.4, -13.8].flatMap((z) => [-26.4, -22.8].map((x): StationRow => ["red", x, z, "RH", -20.7, z + 2.1])),
  ...[-17.6, -14.0].map((x): StationRow => ["report", x, -17.4, "RPH", -15.8, -15.3]),
  ["report", -17.6, -13.8, "RPH", -17.6, -11.7],
  ...[-16.8, -13.2].flatMap((z) => [-9.4, -5.6].map((x): StationRow => ["blue", x, z, "BH", -7.5, z + 2.1])),
  ...[20.2, 23.2, 26.2].map((x): StationRow => ["ops", x, -14.0, "SD", 23.2, -11.7]),
];

export function stationPlace(index: number): StationPlace {
  const [dept, x, z, hub, aisleX, aisleZ] = STATION_LAYOUT[index];
  return {
    kind: "station", dept, index, room: DEPTS[dept].room, zone: dept === "ops" ? "server" : "security", hub,
    via: [new THREE.Vector3(aisleX, T2, aisleZ), new THREE.Vector3(x, T2, aisleZ)],
    final: new THREE.Vector3(x, T2, z + 1.05), face: PI, occ: null,
  };
}

/**
 * Task board ("PAPAN TUGAS", Kantor left wall, deviation 14): three standing spots side by side in front of it.
 * Hub: the left wall walkway on the middle aisle (deviation 18), then straight down between the wall and the first
 * desk column (x -27.55 keeps clear of both).
 */
export const BOARD_X = -27.55;
/** Board center on the left wall, and the standing spots in front of its three cards. */
export const BOARD_Z = 1.75;
export const BOARD_SLOTS_Z = [1.0, 1.75, 2.5];

export function createBoardSlots(): BoardPlace[] {
  return BOARD_SLOTS_Z.map((z, index) => ({
    kind: "board", index, room: "Papan Tugas", zone: "kantor", hub: officeNode(DESK_ROWS[1].aisle, BOARD_X),
    via: [], final: new THREE.Vector3(BOARD_X, T1, z), face: -PI / 2, occ: null,
  }));
}

/* ---------------- back tier: meeting rooms (prd.md §7.9) ---------------- */

/** Room centers along x (Meeting A, B, C). Rooms run from the back wall to the glass front (z ROOM_FRONT_Z). */
export const ROOM_XS = [1.0, 7.8, 14.6];
/** Glass walls between the rooms, x. */
export const ROOM_WALLS = [4.4, 11.2];
/** Enclosed glass rooms: the outer side walls (x), the back (inner face of the back wall), the front wall on the
 *  street (z), and the sliding door in the middle of each front wall (half width). */
export const ROOM_LEFT_X = -2.4;
export const ROOM_RIGHT_X = 18.0;
export const ROOM_BACK_Z = -19.8;
export const ROOM_FRONT_Z = -11.2;
export const DOOR_HALF = 0.75;
/** Table center z, half sizes. Seats sit 0.4 from its edge, like a desk chair. */
export const TABLE_Z = -15.8;
export const TABLE_HALF_X = 0.9;
export const TABLE_HALF_Z = 1.6;
/** Walkway in front of the rooms (graph nodes M0..M2 on the back street) and the lanes beside / behind each table. */
export const CORRIDOR_Z = STREET_B;
const LANE_X = 2.3, ENTRY_Z = TABLE_Z + 2.8, BACK_Z = ROOM_BACK_Z + 0.9;
/** Just inside the door: every way in and out of a room goes through its door. */
const DOOR_IN_Z = ROOM_FRONT_Z - 0.7;
/** Seat 0 at the back facing the camera, then left front/back and right front/back facing the table. */
export const SEAT_LAYOUT: { dx: number; z: number; face: number }[] = [
  { dx: 0, z: TABLE_Z - TABLE_HALF_Z - 0.4, face: 0 },
  { dx: -(TABLE_HALF_X + 0.4), z: TABLE_Z + 0.8, face: PI / 2 },
  { dx: -(TABLE_HALF_X + 0.4), z: TABLE_Z - 0.8, face: PI / 2 },
  { dx: TABLE_HALF_X + 0.4, z: TABLE_Z + 0.8, face: -PI / 2 },
  { dx: TABLE_HALF_X + 0.4, z: TABLE_Z - 0.8, face: -PI / 2 },
];
export const roomNode = (room: number) => `M${room}`;

/** All 15 seats, index = room * 5 + seat. Paths go through the room's door, then keep to the lanes beside the
 *  table, never across it. */
export function createSeats(): SeatPlace[] {
  const out: SeatPlace[] = [];
  ROOM_XS.forEach((cx, roomIndex) => {
    SEAT_LAYOUT.slice(0, SEATS_PER_ROOM).forEach((s, seat) => {
      const side = seat === 0 ? -1 : Math.sign(s.dx);
      const lane = cx + side * LANE_X;
      const via = seat === 0
        ? [[cx, DOOR_IN_Z], [lane, ENTRY_Z], [lane, BACK_Z], [cx, BACK_Z]]
        : [[cx, DOOR_IN_Z], [lane, ENTRY_Z], [lane, s.z]];
      out.push({
        kind: "seat", roomIndex, seat, index: roomIndex * SEATS_PER_ROOM + seat, room: MEETING_ROOMS[roomIndex], zone: "meeting",
        hub: roomNode(roomIndex), via: via.map(([x, z]) => new THREE.Vector3(x, T2, z)),
        final: new THREE.Vector3(cx + s.dx, T2, s.z), face: s.face, occ: null,
      });
    });
  });
  return out;
}

/* ---------------- back tier: server room ---------------- */

/** Server room: glass front (z) with the door at x SERVER_DOOR_X, rack rows (z), and the DevOps stations above. */
export const SERVER_FRONT_Z = -11.0;
export const SERVER_DOOR_X = 23.2;
export const RACK_FRONT_Z = -16.4;
export const RACK_BACK_Z = -19.0;
