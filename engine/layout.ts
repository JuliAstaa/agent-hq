// Single-floor terraced layout (plan-m1.md deviation 29). One island, three tiers that rise toward the back:
//   front  (T0, z 4.0..14.6):  Santai: lounge, pantry, lobby with the grand stairs, game room, nap area, terrace
//   middle (T1, z -8.0..4.0):  Kantor: 9 desks and the boards, Ruang Kreatif, Pojok Baca, garden
//   back   (T2, z -20.0..-8.0): Security (Red Team, VA, SOC), Meeting A-C, Ruang Server
// The outer walls run along the back (z -20) and the left (x -28.6); the front and the right side stay open toward
// the camera, like the old dollhouse floors. Pure constants: no mutable state.

import type { ZoneId } from "@/lib/zones";

/** Tier floor heights. */
export const T0 = 0;
export const T1 = 1.2;
export const T2 = 2.4;

/** Outer left wall (center line) and the island's open right edge. */
export const X_LEFT = -28.6;
export const X_RIGHT = 29.4;
/** Outer back wall (center line), the risers between the tiers, and the island's open front edge. */
export const Z_BACK = -20;
export const Z_RISER_B = -8;
export const Z_RISER_F = 4;
export const Z_FRONT = 14.6;

/** Walkways ("streets") along each tier. */
export const STREET_B = -9.8;
export const STREET_M = 3.0;
export const STREET_F = 10.6;

/** Back tier: Security from the left wall to x -2.8, Meeting from -2.8 to 18.0, Server from 18.0 to the edge. */
export const X_SEC_END = -2.8;
export const X_SERVER = 18.0;

export interface Stair {
  id: string;
  x: number;
  width: number;
  /** Riser line; the steps run from it toward the front (+z), on the lower tier. */
  riserZ: number;
  lo: number;
  hi: number;
}
/** Steps per stair and their depth (6 x 0.2 rise). */
export const STAIR_STEPS = 6;
export const STAIR_DEPTH = 2.0;
export const STAIRS: Stair[] = [
  { id: "SA", x: -11.8, width: 1.8, riserZ: Z_RISER_B, lo: T1, hi: T2 }, // Kantor -> Security
  { id: "SB", x: 4.4, width: 1.8, riserZ: Z_RISER_B, lo: T1, hi: T2 }, // -> Meeting
  { id: "SC", x: 23.2, width: 1.8, riserZ: Z_RISER_B, lo: T1, hi: T2 }, // -> Ruang Server
  { id: "FA", x: -14.6, width: 2.0, riserZ: Z_RISER_F, lo: T0, hi: T1 }, // Santai -> Kantor (desk column 3)
  { id: "FB", x: 4.4, width: 3.2, riserZ: Z_RISER_F, lo: T0, hi: T1 }, // grand stairs from the lobby
];

/** Which area a point (world x, z) belongs to. */
export function zoneAt(x: number, z: number): ZoneId {
  if (z < Z_RISER_B) return x < X_SEC_END ? "security" : x < X_SERVER ? "meeting" : "server";
  return z < Z_RISER_F ? "kantor" : "santai";
}

/** Tier height at a point (world x, z), ignoring the stairs. */
export const tierY = (z: number) => (z < Z_RISER_B ? T2 : z < Z_RISER_F ? T1 : T0);

type View = { pos: [number, number, number]; target: [number, number, number] };
/** Camera presets: the whole island (Semua) and one per area. Seen from the front right, like the old floors. */
export const VIEWS: Record<"all" | ZoneId, View> = {
  all: { pos: [39, 64, 74], target: [8, 0, -4] },
  santai: { pos: [12, 40, 52], target: [0, 0, 8] },
  kantor: { pos: [-2, 24, 22], target: [-15.5, 1.2, -2] },
  security: { pos: [-3.5, 27, 11], target: [-14.2, 2.4, -14] },
  meeting: { pos: [16, 25, 9], target: [7.8, 2.4, -14] },
  server: { pos: [33, 21, 4], target: [23.4, 2.4, -14.5] },
};
