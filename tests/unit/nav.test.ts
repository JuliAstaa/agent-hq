import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { ADJ, N, shortest } from "@/engine/nav/graph";
import { createBoardSlots, createDeskSlots, createSpots, stationPlace, STATION_LAYOUT, type Place } from "@/engine/nav/places";
import { atPlace, chainOf, route } from "@/engine/nav/router";
import { FETCH_DONE, FETCH_GRAB, floorOf, locText, newMovement, pickSpot, placeAt, releasePlaces, updateNav, workTarget, type Mover, type NavAgent, type NavCtx } from "@/engine/agents/movement";
import { F2, F3 } from "@/engine/constants";
import type { Dept } from "@/lib/teams";

describe("waypoint graph", () => {
  it("links are symmetric and every node is reachable from the lobby", () => {
    for (const [a, list] of Object.entries(ADJ)) for (const b of list) expect(ADJ[b]).toContain(a);
    for (const id of Object.keys(N)) expect(shortest("H1", id).at(-1)).toBe(id);
  });
  it("floor 1 -> floor 3 goes up the stairs, then the lift", () => {
    const p = shortest("PH", "RH");
    expect(p).toEqual(["PH", "H1", "L1a", "Land1", "SB", "ST", "Top2", "HL", "Lift2a", "Lift2", "Lift3", "X3", "RPH", "RH"]);
  });
  it("same node", () => {
    expect(shortest("K1", "K1")).toEqual(["K1"]);
  });
});

describe("router", () => {
  const spots = createSpots();
  const desks = createDeskSlots();
  const stations = STATION_LAYOUT.map((_, i) => stationPlace(i));
  const all: Place[] = [...spots, ...desks.map((d) => d.place), ...stations, ...createBoardSlots()];
  const floorOfY = (y: number) => (y > 8.4 ? 3 : y > 2.8 ? 2 : 1);

  it("every place is reachable from every desk, ending at its final point", () => {
    for (const d of desks) {
      for (const dest of all) {
        const r = route(atPlace(d.place), dest);
        expect(r.at(-1)!.p.equals(dest.final)).toBe(true);
        for (let i = 1; i < r.length; i++) expect(r[i].p.distanceToSquared(r[i - 1].p)).toBeGreaterThan(1e-6);
      }
    }
  });

  it("desk -> coffee: retrace the aisle, go down the stairs, enter the pantry chain", () => {
    const desk = desks[0].place;
    const coffee = spots.find((s) => s.id === "coffee")!;
    const r = route(atPlace(desk), coffee);
    expect(r[0].p.equals(desk.final)).toBe(true);
    expect(r[1].p.equals(desk.via[0])).toBe(true);
    const ids = r.filter((w) => w.ref.t === "node").map((w) => (w.ref as { id: string }).id);
    expect(ids).toEqual(["K2", "K3", "HL", "Top2", "ST", "SB", "Land1", "L1a", "H1", "PH"]);
    expect(r.slice(-4).map((w) => w.p.toArray())).toEqual(chainOf(coffee).slice(1).map((w) => w.p.toArray()));
    // height only changes on the stairs segment
    const ys = r.map((w) => floorOfY(w.p.y));
    expect(ys[0]).toBe(2);
    expect(ys.at(-1)).toBe(1);
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

  it("stations are on floor 3 and face the back wall", () => {
    expect(stations).toHaveLength(11);
    expect(stations.filter((s) => s.dept === "red")).toHaveLength(4);
    expect(stations.filter((s) => s.dept === "report")).toHaveLength(3);
    expect(stations.filter((s) => s.dept === "blue")).toHaveLength(4);
    for (const s of stations) {
      expect(s.final.y).toBe(F3);
      expect(s.face).toBe(Math.PI);
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
    for (const slot of [0, 5, 11]) {
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
    expect(logs.at(-1)).toMatch(/^zorp: Jalan santai, ke .+ \(Lt\.[12]\)$/);
    run(m, a, 40);
    expect(m.mv.mode).toBe("act");
    expect(m.root.position.distanceTo(dest.final)).toBeLessThan(1e-6);
    if (dest.kind === "spot") expect(dest.types).toContain(m.mv.activity);
    expect(locText(m).where).toBe(`${dest.room} · Lt.${dest.floor}`);
  });

  it("work status: runs back to the desk (urgent)", () => {
    const { ctx, logs, mk, run } = setup();
    const m = mk("glimbo", 3);
    const coffee = ctx.spots.find((s) => s.id === "coffee")!;
    placeAt(ctx, m, coffee);
    expect(m.mv.mode).toBe("act");
    expect(floorOf(m)).toBe(1);
    run(m, { status: "working", dept: null }, 0.05);
    expect(m.mv).toMatchObject({ mode: "walk", urgent: true, speed: 4.6 });
    expect(coffee.occ).toBeNull();
    expect(logs.at(-1)).toBe("glimbo: Buru-buru balik ke meja");
    expect(locText(m)).toEqual({ where: "Lt.1", what: "jalan balik ke meja" });
    run(m, { status: "working", dept: null }, 30);
    expect(m.mv.mode).toBe("desk");
    expect(m.root.position.distanceTo(m.home.final)).toBeLessThan(1e-6);
    expect(m.root.position.y).toBe(F2);
  });

  it("team agent goes to its floor-3 station via the lift", () => {
    const { logs, mk, run } = setup();
    const m = mk("rexx");
    const a: NavAgent = { status: "working", dept: "red" };
    run(m, a, 0.05);
    expect(logs.at(-1)).toBe("rexx: Buru-buru ke Red Team Lab (Lt.3)");
    const ys = new Set<number>();
    for (let i = 0; i < 400 && m.mv.mode === "walk"; i++) {
      run(m, a, 0.05);
      ys.add(floorOf(m));
    }
    expect(ys.has(3)).toBe(true);
    expect(m.mv.mode).toBe("desk");
    expect(m.mv.dest.kind).toBe("station");
    expect(locText(m)).toEqual({ where: "Red Team Lab · Lt.3", what: "Red Team" });
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
    const movers = Array.from({ length: 12 }, (_, i) => mk("a" + i, i));
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
    expect(locText(m)).toEqual({ where: "Lt.2", what: "jalan ke Papan Tugas" });
    until(run, m, busy, () => m.mv.mode === "fetch");
    const board = m.mv.dest;
    expect(m.root.position.distanceTo(board.final)).toBeLessThan(1e-6);
    expect(locText(m)).toEqual({ where: "Papan Tugas · Lt.2", what: "ambil tugas" });
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

  it("from the lounge, a security agent goes board first, then its floor-3 station", () => {
    const { ctx, mk, run } = setup();
    const m = mk("sentra", 2);
    placeAt(ctx, m, ctx.spots.find((s) => s.id === "coffee")!);
    run(m, { status: "idle", dept: null }, 0.1);
    const busy: NavAgent = { status: "working", dept: "blue" };
    run(m, busy, 0.05);
    expect(m.mv.dest.kind).toBe("board");
    until(run, m, busy, () => m.mv.mode === "fetch");
    expect(floorOf(m)).toBe(2);
    until(run, m, busy, () => m.mv.mode === "desk", 60);
    expect(m.mv.dest.kind).toBe("station");
    expect(floorOf(m)).toBe(3);
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

