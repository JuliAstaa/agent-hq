// Airlock (prd.md §7.10): kicked agents walk to it in the front right corner of the Santai tier, from anywhere.
import { describe, expect, it } from "vitest";
import { ADJ, N } from "@/engine/nav/graph";
import {
  AIRLOCK, AIRLOCK_NODE, createAirlockSpots, createBoardSlots, createDeskSlots, createSeats, createSpots, stationPlace,
  STATION_LAYOUT, type Place,
} from "@/engine/nav/places";
import { atPlace, route } from "@/engine/nav/router";
import { T0, zoneAt, Z_RISER_F } from "@/engine/layout";

const airlock = createAirlockSpots();
const everywhere: Place[] = [
  ...createSpots(), ...createDeskSlots().map((d) => d.place), ...STATION_LAYOUT.map((_, i) => stationPlace(i)),
  ...createBoardSlots(), ...createSeats(),
];

describe("Airlock (prd.md §7.10)", () => {
  it("three standing spots inside on the front tier, reached through the inner door from node AL next to the Teras", () => {
    expect(airlock).toHaveLength(3);
    expect(ADJ[AIRLOCK_NODE]).toEqual(["TE"]);
    expect(N[AIRLOCK_NODE].x).toBeLessThan(AIRLOCK.x0);
    expect(N[AIRLOCK_NODE].y).toBe(T0);
    expect(AIRLOCK.z0).toBeGreaterThan(Z_RISER_F); // in front of the riser to the office
    for (const s of airlock) {
      expect(s.kind).toBe("airlock");
      expect(s.zone).toBe("santai");
      expect(zoneAt(s.final.x, s.final.z)).toBe("santai");
      expect(s.via[0]).toMatchObject({ x: AIRLOCK.x0 + 0.6, y: T0, z: AIRLOCK.doorZ });
      expect(s.final.x).toBeGreaterThan(AIRLOCK.x0);
      expect(s.final.x).toBeLessThan(AIRLOCK.x1);
      expect(s.final.z).toBeGreaterThan(AIRLOCK.z0);
      expect(s.final.z).toBeLessThan(AIRLOCK.z1);
    }
  });

  it("every desk, station, spot, board and seat has a route to every Airlock spot", () => {
    for (const p of everywhere) {
      for (const s of airlock) expect(route(atPlace(p), s).at(-1)!.p.equals(s.final)).toBe(true);
    }
  });

  it("no route to the Airlock crosses its walls, the vending machines or the game room wall", () => {
    const pad = 0.25;
    const { x0, x1, z0, z1, doorZ, doorHalf } = AIRLOCK;
    const blocked = (x: number, z: number) =>
      (Math.abs(x - x0) < pad && z > z0 - pad && z < z1 + pad && Math.abs(z - doorZ) > doorHalf - 0.1) ? "inner wall"
        : (x > x0 - pad && x < x1 + pad && (Math.abs(z - z0) < pad || Math.abs(z - z1) < pad)) ? "back wall or glass"
        : (Math.abs(x - x1) < pad && z > z0 && z < z1) ? "hatch wall"
        : (x > 16.9 - pad && x < 19.5 + pad && z < 4.93 + pad) ? "vending machines"
        : (Math.abs(x - 16.0) < pad && z > 4.4 && z < 9.6) ? "game room wall"
        : "";
    const bad: string[] = [];
    for (const p of everywhere) {
      for (const s of airlock) {
        const r = route(atPlace(p), s);
        for (let i = 1; i < r.length; i++) {
          const a = r[i - 1].p, b = r[i].p;
          if (Math.abs(a.y - T0) > 0.05 || Math.abs(b.y - T0) > 0.05) continue;
          for (let k = 0; k <= 80; k++) {
            const x = a.x + ((b.x - a.x) * k) / 80, z = a.z + ((b.z - a.z) * k) / 80;
            const what = blocked(x, z);
            if (what && bad.length < 10) bad.push(`${what}: ${p.final.toArray()} -> ${s.final.toArray()} at (${x.toFixed(2)}, ${z.toFixed(2)})`);
          }
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
