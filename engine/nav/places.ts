// Places an agent can go: lounge spots, home desks, floor-3 stations (prd.md §9, §10).
// Every place is a chain hub -> via points -> final position, with a facing angle.
// Reservations (occ) are per engine instance: create fresh objects with createSpots()/createDeskPlaces().

import * as THREE from "three";
import { F2, F3, type Activity } from "../constants";
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
export type Place = SpotPlace | DeskPlace | StationPlace;

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
  spot("board", "Ruang Rapat", 2, "Kf2", [[-10.0, 5.0]], [-11.6, 6.3], -PI / 2, ["whiteboard"], "stand");
  spot("cardL", "Ruang Rapat", 2, "Kf2", [[-10.0, 5.0]], [-9.4, 6.4], PI / 2, ["cards"], "stool");
  spot("cardR", "Ruang Rapat", 2, "Kf2", [[-6.4, 5.0]], [-7.0, 6.4], -PI / 2, ["cards"], "stool");
  spot("readA", "Pojok Baca", 2, "Kf1", [[-4.4, 7.5], [-2.2, 7.5]], [-2.2, 6.85], 0, ["read"], "sit");
  spot("readB", "Pojok Baca", 2, "Kf1", [[-4.4, 7.5], [0.6, 7.5]], [0.6, 6.85], 0, ["read"], "sit");
  return out;
}

/** 12 home desks on floor 2: 3 rows x 4, slot index = row * 4 + column. */
export const DESK_ROWS = [
  { z: -4.6, hub: "K1", aisle: -6.6 },
  { z: -1.0, hub: "K2", aisle: -3.0 },
  { z: 2.6, hub: "K3", aisle: 0.6 },
];
export const DESK_XS = [-9.6, -6.0, -2.4, 1.2];

export interface DeskSlot {
  x: number;
  z: number;
  place: DeskPlace;
}

export function createDeskSlots(): DeskSlot[] {
  const out: DeskSlot[] = [];
  for (const r of DESK_ROWS) {
    for (const x of DESK_XS) {
      out.push({ x, z: r.z, place: { kind: "desk", room: "Meja kerja", floor: 2, hub: r.hub, via: [new THREE.Vector3(x, F2, r.aisle)], final: new THREE.Vector3(x, F2, r.z - 1.05), face: 0, occ: null } });
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
