// Waypoint graph of the terraced single-floor office (deviation 29) and Dijkstra (prd.md §10.3).
// Each tier has a street along it; stairs climb the risers between the tiers; the office keeps its walkway grid
// (deviation 18). Pure module data: node vectors are never mutated.

import * as THREE from "three";
import { STAIRS, STAIR_DEPTH, STREET_B, STREET_F, STREET_M, T0, T1, T2 } from "../layout";
import { BOARD_X, DESK_GAPS, DESK_ROWS, DESK_XS, OFFICE_RIGHT_X, officeNode, ROOM_XS, roomNode, SERVER_DOOR_X } from "./places";

export const N: Record<string, THREE.Vector3> = {};
export const ADJ: Record<string, string[]> = {};

function node(id: string, x: number, y: number, z: number) {
  N[id] = new THREE.Vector3(x, y, z);
  ADJ[id] = [];
}
function link(a: string, b: string) {
  ADJ[a].push(b);
  ADJ[b].push(a);
}
/** Link a row of nodes in order of x. */
function chain(ids: string[]) {
  const s = [...ids].sort((p, q) => N[p].x - N[q].x);
  for (let i = 1; i < s.length; i++) link(s[i - 1], s[i]);
}

/* Front tier (Santai): the street in front of the lounge, pantry and game room; hubs of the rooms on it. */
const front: [string, number][] = [["NH", -22.4], ["LH", -20.2], ["FA:s", -14.6], ["PH", -8.6], ["H1", 4.4], ["GH", 10.2], ["TE", 24.0]];
for (const [id, x] of front) node(id, x, T0, STREET_F);
chain(front.map(([id]) => id));

/* Middle tier (Kantor). Office grid (deviation 18): each aisle is a row of nodes from the left wall walkway (BOARD_X,
   back and middle aisles) through every desk column and desk gap to the right-hand walkway (K2, K3, K4). The front
   aisle is the street of the middle tier: it runs on past Ruang Kreatif, Pojok Baca and the garden. */
const [A, B, C] = DESK_ROWS.map((r) => r.aisle);
const right: Record<number, string> = { [A]: "K2", [B]: "K3", [C]: "K4" };
for (const z of [A, B, C]) node(right[z], OFFICE_RIGHT_X, T1, z);
const mid: [string, number][] = [["MK", -7.6], ["MB", -1.2], ["SB:m", 4.4], ["MT", 13.0], ["SC:m", 23.2]];
for (const [id, x] of mid) node(id, x, T1, STREET_M);
for (const z of [A, B, C]) {
  const ids: string[] = [];
  for (const x of [...DESK_XS, ...DESK_GAPS, ...(z === C ? [] : [BOARD_X])]) {
    node(officeNode(z, x), x, T1, z);
    ids.push(officeNode(z, x));
  }
  ids.push(right[z]);
  if (z === C) ids.push(...mid.map(([id]) => id));
  chain(ids);
}
link("K2", "K3");
link("K3", "K4");
for (const x of DESK_GAPS) {
  link(officeNode(A, x), officeNode(B, x));
  link(officeNode(B, x), officeNode(C, x));
}
link(officeNode(A, BOARD_X), officeNode(B, BOARD_X));
// In front of the task board: the left walkway continues to the street, then meets the front aisle at the first desk
// column.
node("BoardFront", BOARD_X, T1, STREET_M);
link(officeNode(B, BOARD_X), "BoardFront");
link("BoardFront", officeNode(C, DESK_XS[0]));

/* Back tier: one street past the Security rooms, the three meeting room doors and the server room door. */
const back: [string, number][] = [["RH", -20.7], ["RPH", -15.8], ["SA:s", -11.8], ["BH", -7.5], ...ROOM_XS.map((x, i): [string, number] => [roomNode(i), x]), ["SB:s", 4.4], ["SD", SERVER_DOOR_X]];
for (const [id, x] of back) node(id, x, T2, STREET_B);
chain(back.map(([id]) => id));

/* Stairs: bottom (on the lower tier, just in front of the first step) and top (just over the riser), each linked to
   the street or walkway it serves. */
const stairEnds: Record<string, [string, string]> = {
  SA: ["K2", "SA:s"],
  SB: ["SB:m", "SB:s"],
  SC: ["SC:m", "SD"],
  FA: ["FA:s", officeNode(C, DESK_XS[2])],
  FB: ["H1", "SB:m"],
};
for (const s of STAIRS) {
  const lo = `${s.id}:0`, hi = `${s.id}:1`;
  node(lo, s.x, s.lo, s.riserZ + STAIR_DEPTH + 0.3);
  node(hi, s.x, s.hi, s.riserZ - 0.1);
  link(lo, hi);
  const [below, above] = stairEnds[s.id];
  link(below, lo);
  link(hi, above);
}

/** Dijkstra shortest path between two node ids. Unreachable -> [a]. */
export function shortest(a: string, b: string): string[] {
  if (a === b) return [a];
  const dist: Record<string, number> = { [a]: 0 };
  const prev: Record<string, string> = {};
  const open = new Set([a]);
  while (open.size) {
    let u: string | null = null;
    for (const n of open) if (u === null || dist[n] < dist[u]) u = n;
    open.delete(u!);
    if (u === b) break;
    for (const v of ADJ[u!]) {
      const d = dist[u!] + N[u!].distanceTo(N[v]);
      if (dist[v] === undefined || d < dist[v]) {
        dist[v] = d;
        prev[v] = u!;
        open.add(v);
      }
    }
  }
  const path = [b];
  let c = b;
  while (c !== a) {
    c = prev[c];
    if (c === undefined) return [a];
    path.unshift(c);
  }
  return path;
}
