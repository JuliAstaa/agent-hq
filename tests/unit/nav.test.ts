import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { ADJ, N, shortest } from "@/engine/nav/graph";
import { createBoardSlots, createDeskSlots, createSpots, stationPlace, STATION_LAYOUT, type Place } from "@/engine/nav/places";
import { atPlace, chainOf, route, type Waypoint } from "@/engine/nav/router";
import { FETCH_DONE, FETCH_GRAB, locText, newMovement, pickSpot, placeAt, releasePlaces, updateNav, workTarget, zoneOf, type Mover, type NavAgent, type NavCtx } from "@/engine/agents/movement";
import { STAIRS, T0, T1, T2, zoneAt } from "@/engine/layout";
import type { Dept } from "@/lib/teams";
import { ZONE_LABEL } from "@/lib/zones";

describe("waypoint graph", () => {
  it("links are symmetric and every node is reachable from the lobby", () => {
    for (const [a, list] of Object.entries(ADJ)) for (const b of list) expect(ADJ[b]).toContain(a);
    for (const id of Object.keys(N)) expect(shortest("H1", id).at(-1)).toBe(id);
  });
  it("pantry -> Red Team climbs both risers: the stairs beside the lounge, then the stairs to Security (deviation 29)", () => {
    const p = shortest("PH", "RH");
    expect(p[0]).toBe("PH");
    expect(p.at(-1)).toBe("RH");
    const at = (id: string) => p.indexOf(id);
    for (const id of ["FA:0", "FA:1", "SA:0", "SA:1"]) expect(at(id)).toBeGreaterThan(0);
    expect(at("FA:0")).toBeLessThan(at("FA:1"));
    expect(at("FA:1")).toBeLessThan(at("SA:0"));
    expect(at("SA:0")).toBeLessThan(at("SA:1"));
  });
  it("graph nodes stand on a tier, except the stair ends", () => {
    for (const [id, v] of Object.entries(N)) {
      const stair = /^(SA|SB|SC|FA|FB):[01]$/.test(id);
      if (!stair) expect([T0, T1, T2], id).toContain(v.y);
    }
    for (const s of STAIRS) expect([N[`${s.id}:0`].y, N[`${s.id}:1`].y]).toEqual([s.lo, s.hi]);
  });
  it("same node", () => {
    expect(shortest("K2", "K2")).toEqual(["K2"]);
  });
});

describe("router", () => {
  const spots = createSpots();
  const desks = createDeskSlots();
  const stations = STATION_LAYOUT.map((_, i) => stationPlace(i));
  const all: Place[] = [...spots, ...desks.map((d) => d.place), ...stations, ...createBoardSlots()];

  it("every place is reachable from every desk, ending at its final point", () => {
    for (const d of desks) {
      for (const dest of all) {
        const r = route(atPlace(d.place), dest);
        expect(r.at(-1)!.p.equals(dest.final)).toBe(true);
        for (let i = 1; i < r.length; i++) expect(r[i].p.distanceToSquared(r[i - 1].p)).toBeGreaterThan(1e-6);
      }
    }
  });

  it("desk -> coffee: retrace the aisle, down the stairs beside the lounge, enter the pantry chain", () => {
    const desk = desks[0].place;
    const coffee = spots.find((s) => s.id === "coffee")!;
    const r = route(atPlace(desk), coffee);
    expect(r[0].p.equals(desk.final)).toBe(true);
    expect(r[1].p.equals(N[desk.hub])).toBe(true); // the desk's own spot on its aisle (deviation 18)
    const ids = r.filter((w) => w.ref.t === "node").map((w) => (w.ref as { id: string }).id);
    expect(ids[0]).toBe(desk.hub);
    expect(ids.slice(-4)).toEqual(["FA:1", "FA:0", "FA:s", "PH"]);
    expect(r.slice(-4).map((w) => w.p.toArray())).toEqual(chainOf(coffee).slice(1).map((w) => w.p.toArray()));
    expect(r[0].p.y).toBe(T1);
    expect(r.at(-1)!.p.y).toBe(T0);
  });

  it("heights only change on the stairs (deviation 29)", () => {
    const stairEnd = (w: Waypoint) => w.ref.t === "node" && /^(SA|SB|SC|FA|FB):[01]$/.test(w.ref.id);
    const sample = [...all.filter((_, i) => i % 3 === 0), ...desks.map((d) => d.place)];
    for (const a of sample) {
      for (const b of sample) {
        if (a === b) continue;
        const r = route(atPlace(a), b);
        for (let i = 1; i < r.length; i++) {
          if (Math.abs(r[i].p.y - r[i - 1].p.y) < 1e-6) continue;
          expect(stairEnd(r[i - 1]) && stairEnd(r[i]), `${a.final.toArray()} -> ${b.final.toArray()} step ${i}`).toBe(true);
        }
      }
    }
  });

  it("every place lies in the area it names, at the height of that tier", () => {
    for (const p of all) {
      expect(zoneAt(p.final.x, p.final.z), `${p.kind} ${p.room}`).toBe(p.zone);
      expect(p.final.y).toBe(p.zone === "santai" ? T0 : p.zone === "kantor" ? T1 : T2);
    }
  });

  // Deviation 18: the floor-2 office is a walkway grid, so trips between the task board and desks take the short way.
  const pathLength = (r: { p: THREE.Vector3 }[]) => r.reduce((s, w, i) => (i ? s + w.p.distanceTo(r[i - 1].p) : 0), 0);
  const boards = createBoardSlots();
  const office: Place[] = [...desks.map((d) => d.place), ...boards];

  it("task board <-> desks and desk <-> desk take a short way (no detour via the right-hand column)", () => {
    for (const a of office) {
      for (const b of office) {
        if (a === b) continue;
        const r = route(atPlace(a), b);
        const manhattan = Math.abs(a.final.x - b.final.x) + Math.abs(a.final.z - b.final.z);
        expect(pathLength(r), `${a.kind} ${a.final.toArray()} -> ${b.kind} ${b.final.toArray()}`).toBeLessThanOrEqual(manhattan * 1.25 + 8); // walking around one desk is fine; the old detour added 25+
      }
    }
    // the case that used to run ~34 units: board -> back-row desk next to it
    expect(pathLength(route(atPlace(boards[0]), desks[0].place))).toBeLessThan(9);
  });

  it("no floor-2 route cuts through a desk", () => {
    const pad = 0.3; // agent clearance around the desk top (2.7 x 1.35)
    const inDesk = (x: number, z: number) => desks.some((d) => Math.abs(x - d.x) < 1.35 + pad && Math.abs(z - d.z) < 0.675 + pad);
    const lt2 = [...office, ...spots.filter((s) => s.zone === "kantor")];
    for (const a of lt2) {
      for (const b of lt2) {
        if (a === b) continue;
        const r = route(atPlace(a), b);
        for (let i = 1; i < r.length; i++) {
          const p = r[i - 1].p, q = r[i].p;
          if (Math.abs(p.y - T1) > 0.3 || Math.abs(q.y - T1) > 0.3) continue;
          for (let k = 0; k <= 20; k++) {
            const x = p.x + ((q.x - p.x) * k) / 20, z = p.z + ((q.z - p.z) * k) / 20;
            expect(inDesk(x, z), `${a.final.toArray()} -> ${b.final.toArray()} at (${x.toFixed(2)}, ${z.toFixed(2)})`).toBe(false);
          }
        }
      }
    }
  });

  it("redirect mid-walk retraces to the last reached waypoint", () => {
    const desk = desks[5].place;
    const fridge = spots.find((s) => s.id === "fridge")!;
    const r1 = route(atPlace(desk), fridge);
    const reached = r1[4]; // somewhere on the way
    const back = route(reached.ref, desk);
    expect(back[0].p.equals(reached.p)).toBe(true);
    expect(back.at(-1)!.p.equals(desk.final)).toBe(true);
  });

  it("partway into the destination chain, only the rest of the chain remains", () => {
    const coffee = spots.find((s) => s.id === "coffee")!;
    const r = route({ t: "chain", place: coffee, c: 2 }, coffee);
    expect(r.map((w) => w.p.toArray())).toEqual([coffee.via[1].toArray(), coffee.via[2].toArray(), coffee.final.toArray()]);
  });

  it("stations are on the back tier and face the back wall; DevOps stations are in the server room", () => {
    expect(stations).toHaveLength(14);
    expect(stations.filter((s) => s.dept === "red")).toHaveLength(4);
    expect(stations.filter((s) => s.dept === "report")).toHaveLength(3);
    expect(stations.filter((s) => s.dept === "blue")).toHaveLength(4);
    expect(stations.filter((s) => s.dept === "ops")).toHaveLength(3);
    for (const s of stations) {
      expect(s.final.y).toBe(T2);
      expect(s.face).toBe(Math.PI);
      expect(s.zone).toBe(s.dept === "ops" ? "server" : "security");
    }
  });
});

/* ---------------- movement ---------------- */

function setup() {
  const logs: string[] = [];
  let now = 0;
  const ctx: NavCtx = {
    spots: createSpots(),
    stations: STATION_LAYOUT.map((_, i) => stationPlace(i)),
    boards: createBoardSlots(),
    now: () => now,
    log: (id, m) => logs.push(`${id}: ${m}`),
    changed: () => {},
  };
  const desks = createDeskSlots();
  const mk = (id: string, slot = 0): Mover => {
    const home = desks[slot].place;
    const root = new THREE.Object3D();
    root.position.copy(home.final);
    return { id, root, home, mv: newMovement(home), squash: 0 };
  };
  const run = (m: Mover, a: NavAgent, seconds: number, dt = 0.05) => {
    for (let t = 0; t < seconds; t += dt) {
      now += dt;
      updateNav(ctx, m, a, dt);
    }
  };
  return { ctx, logs, mk, run };
}

describe("agent behavior (prd.md §10)", () => {
  it("an agent spawned at its desk faces the monitor (desk face PI), and keeps facing it while working", () => {
    const { mk, run } = setup();
    for (const slot of [0, 4, 8]) {
      const m = mk(`seat${slot}`, slot);
      expect(m.home.face).toBe(Math.PI);
      expect(m.mv.yaw).toBe(Math.PI);
      run(m, { status: "working", dept: null }, 1);
      expect(m.mv.mode).toBe("desk");
      expect(Math.abs(Math.cos(m.root.rotation.y) - Math.cos(Math.PI))).toBeLessThan(1e-3);
    }
  });

  it("idle >= 3 s at the desk: strolls to a free lounge spot and starts an activity", () => {
    const { logs, mk, run } = setup();
    const m = mk("zorp");
    const a: NavAgent = { status: "idle", dept: null };
    run(m, a, 2.9);
    expect(m.mv.mode).toBe("desk");
    run(m, a, 0.3);
    expect(m.mv.mode).toBe("walk");
    expect(m.mv.urgent).toBe(false);
    expect(m.mv.speed).toBe(2.3);
    const dest = m.mv.dest;
    expect(dest.kind).toBe("spot");
    expect(dest.occ).toBe("zorp");
    expect(logs.at(-1)).toMatch(/^zorp: Jalan santai, ke [^(]+$/);
    run(m, a, 40);
    expect(m.mv.mode).toBe("act");
    expect(m.root.position.distanceTo(dest.final)).toBeLessThan(1e-6);
    if (dest.kind === "spot") expect(dest.types).toContain(m.mv.activity);
    expect(locText(m).where).toBe(`${dest.room} · ${ZONE_LABEL[dest.zone]}`);
  });

  it("work status: runs back to the desk (urgent)", () => {
    const { ctx, logs, mk, run } = setup();
    const m = mk("glimbo", 3);
    const coffee = ctx.spots.find((s) => s.id === "coffee")!;
    placeAt(ctx, m, coffee);
    expect(m.mv.mode).toBe("act");
    expect(zoneOf(m)).toBe("santai");
    run(m, { status: "working", dept: null }, 0.05);
    expect(m.mv).toMatchObject({ mode: "walk", urgent: true, speed: 4.6 });
    expect(coffee.occ).toBeNull();
    expect(logs.at(-1)).toBe("glimbo: Buru-buru balik ke meja");
    expect(locText(m)).toEqual({ where: "Santai", what: "jalan balik ke meja" });
    run(m, { status: "working", dept: null }, 30);
    expect(m.mv.mode).toBe("desk");
    expect(m.root.position.distanceTo(m.home.final)).toBeLessThan(1e-6);
    expect(m.root.position.y).toBe(T1);
  });

  it("team agent climbs to its Security station", () => {
    const { logs, mk, run } = setup();
    const m = mk("rexx");
    const a: NavAgent = { status: "working", dept: "red" };
    run(m, a, 0.05);
    expect(logs.at(-1)).toBe("rexx: Buru-buru ke Red Team Lab");
    for (let i = 0; i < 400 && m.mv.mode === "walk"; i++) run(m, a, 0.05);
    expect(m.mv.mode).toBe("desk");
    expect(m.mv.dest.kind).toBe("station");
    expect(zoneOf(m)).toBe("security");
    expect(m.root.position.y).toBe(T2);
    expect(locText(m)).toEqual({ where: "Red Team Lab", what: "Red Team" });
  });

  it("DevOps agent works in the server room (deviation 29)", () => {
    const { logs, mk, run } = setup();
    const m = mk("krunch", 4);
    const a: NavAgent = { status: "working", dept: "ops" };
    run(m, a, 0.05);
    expect(logs.at(-1)).toBe("krunch: Buru-buru ke Ruang Server");
    for (let i = 0; i < 600 && m.mv.mode === "walk"; i++) run(m, a, 0.05);
    expect(m.mv).toMatchObject({ mode: "desk" });
    expect(m.mv.dest).toMatchObject({ kind: "station", dept: "ops", zone: "server" });
    expect(zoneOf(m)).toBe("server");
    expect(locText(m)).toEqual({ where: "Ruang Server", what: "DevOps" });
  });

  it("one agent per station; overflow works at the home desk", () => {
    const { ctx, mk } = setup();
    const movers = Array.from({ length: 5 }, (_, i) => mk("r" + i, i));
    const targets = movers.map((m) => {
      const t = workTarget(ctx, m, { status: "working", dept: "red" });
      placeAt(ctx, m, t);
      return t;
    });
    expect(targets.slice(0, 4).every((t) => t.kind === "station")).toBe(true);
    expect(new Set(targets.slice(0, 4)).size).toBe(4);
    expect(targets[4]).toBe(movers[4].home);
    // keeps its own station
    expect(workTarget(ctx, movers[0], { status: "thinking", dept: "red" })).toBe(targets[0]);
    // offline and no team -> home desk
    expect(workTarget(ctx, movers[0], { status: "offline", dept: "red" })).toBe(movers[0].home);
    expect(workTarget(ctx, movers[0], { status: "working", dept: null as Dept | null })).toBe(movers[0].home);
  });

  it("spots are reserved: pickSpot never returns another agent's spot", () => {
    const { ctx, mk } = setup();
    const movers = Array.from({ length: 12 }, (_, i) => mk("a" + i, i % 9)); // 12 agents, 9 desks (deviation 17)
    const taken = new Set<string>();
    for (const m of movers) {
      const sp = pickSpot(ctx, m);
      if (!sp) break;
      expect(taken.has(sp.id)).toBe(false);
      placeAt(ctx, m, sp);
      taken.add(sp.id);
    }
    expect(taken.size).toBe(12);
  });

  it("no free spot: stays at the desk and retries 10 s later", () => {
    const { ctx, mk, run } = setup();
    for (const s of ctx.spots) s.occ = "someone";
    const m = mk("x");
    run(m, { status: "idle", dept: null }, 3.2);
    expect(m.mv.mode).toBe("desk");
    expect(m.mv.idleSince).toBeGreaterThan(3.2);
  });

  it("removal frees a spot and a station (fix B1)", () => {
    const { ctx, mk } = setup();
    const m = mk("q");
    const coffee = ctx.spots.find((s) => s.id === "coffee")!;
    placeAt(ctx, m, coffee);
    releasePlaces(m);
    expect(coffee.occ).toBeNull();
    const st = ctx.stations[4];
    placeAt(ctx, m, st);
    releasePlaces(m);
    expect(st.occ).toBeNull();
  });

  it("removal while walking to a station frees it for the next agent (fix B1)", () => {
    const { ctx, mk, run } = setup();
    const reds = Array.from({ length: 4 }, (_, i) => mk("r" + i, i));
    for (const m of reds) placeAt(ctx, m, workTarget(ctx, m, { status: "working", dept: "red" }));
    const late = mk("late", 5);
    run(late, { status: "working", dept: "red" }, 0.05);
    expect(late.mv.dest).toBe(late.home); // all 4 red stations taken
    releasePlaces(reds[2]);
    const walker = mk("walker", 6);
    run(walker, { status: "working", dept: "red" }, 0.05);
    expect(walker.mv.mode).toBe("walk");
    expect(walker.mv.dest.kind).toBe("station");
    releasePlaces(walker); // removed mid-walk
    expect(workTarget(ctx, late, { status: "working", dept: "red" }).kind).toBe("station");
  });
});

describe("task board (deviation 14)", () => {
  /** Run until `pred` holds (or `max` seconds pass); returns the elapsed time. */
  const until = (run: (m: Mover, a: NavAgent, s: number) => void, m: Mover, a: NavAgent, pred: () => boolean, max = 40) => {
    let t = 0;
    while (!pred() && t < max) { run(m, a, 0.05); t += 0.05; }
    return t;
  };

  it("a new prompt: the idle agent fetches the card at the board, then carries it to its desk", () => {
    const { logs, mk, run } = setup();
    const m = mk("rexx", 5);
    run(m, { status: "idle", dept: null }, 1); // just finished, still at the desk
    const busy: NavAgent = { status: "thinking", dept: null };
    run(m, busy, 0.05);
    expect(m.mv).toMatchObject({ mode: "walk", fetching: true, carrying: false, urgent: true });
    expect(m.mv.dest.kind).toBe("board");
    expect(m.mv.dest.occ).toBe("rexx");
    expect(logs.at(-1)).toBe("rexx: Buru-buru ambil tugas di papan");
    expect(locText(m)).toEqual({ where: "Kantor", what: "jalan ke Papan Tugas" });
    until(run, m, busy, () => m.mv.mode === "fetch");
    const board = m.mv.dest;
    expect(m.root.position.distanceTo(board.final)).toBeLessThan(1e-6);
    expect(locText(m)).toEqual({ where: "Papan Tugas · Kantor", what: "ambil tugas" });
    run(m, busy, FETCH_GRAB + 0.05);
    expect(m.mv.carrying).toBe(true);
    run(m, busy, FETCH_DONE - FETCH_GRAB);
    expect(m.mv).toMatchObject({ mode: "walk", fetching: false, carrying: true });
    expect(m.mv.dest.kind).toBe("desk");
    expect(board.occ).toBeNull(); // the next agent can use that spot
    expect(logs.at(-1)).toBe("rexx: Buru-buru bawa tugas ke meja");
    until(run, m, busy, () => m.mv.mode === "desk");
    expect(m.root.position.distanceTo(m.home.final)).toBeLessThan(1e-6);
    expect(m.mv.carrying).toBe(false); // card put down on the desk
  });

  it("from the lounge, a security agent goes board first, then its Security station", () => {
    const { ctx, mk, run } = setup();
    const m = mk("sentra", 2);
    placeAt(ctx, m, ctx.spots.find((s) => s.id === "coffee")!);
    run(m, { status: "idle", dept: null }, 0.1);
    const busy: NavAgent = { status: "working", dept: "blue" };
    run(m, busy, 0.05);
    expect(m.mv.dest.kind).toBe("board");
    until(run, m, busy, () => m.mv.mode === "fetch");
    expect(zoneOf(m)).toBe("kantor");
    until(run, m, busy, () => m.mv.mode === "desk", 60);
    expect(m.mv.dest.kind).toBe("station");
    expect(zoneOf(m)).toBe("security");
  });

  it("no board detour for agents that are already busy, mid-task status changes, or a full board", () => {
    const { ctx, mk, run } = setup();
    const first = mk("a", 0);
    run(first, { status: "working", dept: null }, 0.1); // first status seen is busy (snapshot / first event)
    expect(first.mv.fetching).toBe(false);
    run(first, { status: "waiting", dept: null }, 0.1);
    run(first, { status: "working", dept: null }, 0.1); // waiting -> working is the same task
    expect(first.mv.dest.kind).toBe("desk");
    for (const [i, b] of ctx.boards.entries()) b.occ = "other" + i;
    const m = mk("b", 1);
    run(m, { status: "idle", dept: null }, 0.1);
    run(m, { status: "working", dept: null }, 0.1);
    expect(m.mv.fetching).toBe(false);
    expect(m.mv.dest.kind).toBe("desk");
  });

  it("task over before the pickup: the card is dropped and the agent goes to relax; offline: back to its desk", () => {
    const { ctx, mk, run } = setup();
    const m = mk("c", 7);
    run(m, { status: "idle", dept: null }, 0.1);
    run(m, { status: "thinking", dept: null }, 0.5);
    const slot = m.mv.dest;
    expect(slot.kind).toBe("board");
    run(m, { status: "idle", dept: null }, 0.05);
    expect(m.mv.fetching).toBe(false);
    expect(slot.occ).toBeNull();
    expect(["spot", "desk"]).toContain(m.mv.dest.kind);
    const n = mk("d", 8);
    run(n, { status: "offline", dept: null }, 0.1);
    run(n, { status: "working", dept: null }, 0.05);
    expect(n.mv.dest.kind).toBe("board");
    until(run, n, { status: "working", dept: null }, () => n.mv.mode === "fetch");
    run(n, { status: "offline", dept: null }, 0.05);
    expect(n.mv).toMatchObject({ fetching: false, carrying: false });
    expect(n.mv.dest).toBe(n.home);
    expect(ctx.boards.every((b) => b.occ !== "d")).toBe(true);
  });
});

