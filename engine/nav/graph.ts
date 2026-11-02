// Waypoint graph per floor plus vertical links (stairs F1->F2, lift F2->F3) and Dijkstra (prd.md §10.3).
// Pure module data: node vectors are never mutated.

import * as THREE from "three";
import { F2, F3 } from "../constants";

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

node("H1", 1.0, 0, 2.6); node("LH", -4.6, 0, -1.2); node("PH", 1.0, 0, -1.6); node("GH", 7.2, 0, -1.6); node("NH", -7.4, 0, 2.2);
node("L1a", 8.4, 0, 7.4); node("Land1", 11.25, 0, 7.4); node("SB", 11.25, 0.15, 6.7); node("ST", 11.25, F2 + 0.15, -0.3);
node("Top2", 11.25, F2, -1.4); node("HL", 7.2, F2, 0.0);
node("K1", 3.6, F2, -6.6); node("K2", 3.6, F2, -3.0); node("K3", 3.6, F2, 0.6); node("K4", 3.6, F2, 4.0);
node("Kf1", -4.4, F2, 4.0); node("Kf2", -9.0, F2, 4.0);
node("Lift2a", 5.4, F2, 4.0); node("Lift2", 6.8, F2, 4.8); node("Lift3", 6.8, F3, 4.8); node("X3", 5.4, F3, 4.0);
node("RPH", 0, F3, 2.2); node("RH", -4.9, F3, 2.2); node("BH", 8.3, F3, 2.4);
(
  [
    ["H1", "LH"], ["H1", "PH"], ["H1", "GH"], ["H1", "NH"], ["H1", "L1a"], ["LH", "PH"], ["LH", "NH"], ["PH", "GH"],
    ["L1a", "Land1"], ["Land1", "SB"], ["SB", "ST"], ["ST", "Top2"], ["Top2", "HL"], ["HL", "K3"],
    ["K1", "K2"], ["K2", "K3"], ["K3", "K4"], ["K4", "Kf1"], ["Kf1", "Kf2"],
    ["K4", "Lift2a"], ["HL", "Lift2a"], ["Lift2a", "Lift2"], ["Lift2", "Lift3"], ["Lift3", "X3"], ["X3", "BH"], ["X3", "RPH"], ["RPH", "RH"],
  ] as const
).forEach(([a, b]) => link(a, b));

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
