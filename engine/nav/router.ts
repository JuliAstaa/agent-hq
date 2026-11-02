// Route between places through the waypoint graph (port of chainOf/route in references/agent-hq.html).
// Redirect mid-walk: retrace to the last reached waypoint, then re-route.

import type * as THREE from "three";
import { N, shortest } from "./graph";
import type { Place } from "./places";

/** Where an agent last was: a graph node, or the c-th point of a place chain (0 = hub). */
export type Ref = { t: "node"; id: string } | { t: "chain"; place: Place; c: number };
export interface Waypoint {
  p: THREE.Vector3;
  ref: Ref;
}

export function chainOf(place: Place): Waypoint[] {
  const ch: Waypoint[] = [{ p: N[place.hub], ref: { t: "node", id: place.hub } }];
  place.via.forEach((p, i) => ch.push({ p, ref: { t: "chain", place, c: i + 1 } }));
  ch.push({ p: place.final, ref: { t: "chain", place, c: place.via.length + 1 } });
  return ch;
}

/** Ref of an agent standing at the final point of `place`. */
export const atPlace = (place: Place): Ref => ({ t: "chain", place, c: place.via.length + 1 });

export function route(ref: Ref, dest: Place): Waypoint[] {
  if (ref.t === "chain" && ref.place === dest) return chainOf(dest).slice(ref.c);
  const out: Waypoint[] = [];
  let start: string;
  if (ref.t === "node") {
    out.push({ p: N[ref.id], ref });
    start = ref.id;
  } else {
    const ch = chainOf(ref.place);
    for (let c = ref.c; c >= 0; c--) out.push(ch[c]);
    start = ref.place.hub;
  }
  const path = shortest(start, dest.hub);
  for (let i = 1; i < path.length; i++) out.push({ p: N[path[i]], ref: { t: "node", id: path[i] } });
  const dch = chainOf(dest);
  for (let c = 1; c < dch.length; c++) out.push(dch[c]);
  return out.filter((q, i) => i === 0 || q.p.distanceToSquared(out[i - 1].p) > 1e-6);
}
