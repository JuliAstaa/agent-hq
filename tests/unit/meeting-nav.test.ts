// Meeting floor navigation and movement (prd.md §7.9): seats, routes through the lift, meeting before station.
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { ADJ, N, shortest } from "@/engine/nav/graph";
import {
  AIRLOCK, AIRLOCK_NODE, createAirlockSpots, createBoardSlots, createDeskSlots, createSeats, createSpots, DOOR_HALF, ROOM_FRONT_Z, ROOM_RIGHT_X, ROOM_WALLS, ROOM_XS,
  stationPlace, STATION_LAYOUT, TABLE_HALF_X, TABLE_HALF_Z, TABLE_Z, type Place,
} from "@/engine/nav/places";
import { atPlace, route } from "@/engine/nav/router";
import { floorOf, locText, newMovement, updateNav, workTarget, type Mover, type NavAgent, type NavCtx } from "@/engine/agents/movement";
import { F4 } from "@/engine/constants";
import { SEATS_PER_ROOM } from "@/lib/meeting";
import { stepDoors, type MeetingRoomProp } from "@/engine/world/floor4";

const seats = createSeats();
const desks = createDeskSlots();
const stations = STATION_LAYOUT.map((_, i) => stationPlace(i));
const spots = createSpots();
const others: Place[] = [...spots, ...desks.map((d) => d.place), ...stations, ...createBoardSlots()];

describe("seats (prd.md §7.9)", () => {
  it("three rooms with five seats each; the head seat faces the camera, the side seats face the table", () => {
    expect(seats).toHaveLength(3 * SEATS_PER_ROOM);
    seats.forEach((s, i) => {
      expect(s.index).toBe(i);
      expect(s.floor).toBe(4);
      expect(s.final.y).toBe(F4);
      expect(s.room).toBe(["Meeting A", "Meeting B", "Meeting C"][s.roomIndex]);
      const cx = ROOM_XS[s.roomIndex];
      if (s.seat === 0) {
        expect(s.face).toBe(0);
        expect(s.final.x).toBe(cx);
        expect(s.final.z).toBeLessThan(TABLE_Z - TABLE_HALF_Z);
      } else {
        // facing the table: forward points from the seat toward the table's middle line
        expect(Math.sign(Math.sin(s.face))).toBe(Math.sign(cx - s.final.x));
        expect(Math.abs(s.final.x - cx)).toBeGreaterThan(TABLE_HALF_X);
      }
    });
  });

  it("the lift runs on to floor 4 and the corridor reaches every room", () => {
    expect(ADJ.Lift3).toContain("Lift4");
    for (const id of ["Lift4", "X4", "M0", "M1", "M2"]) expect(shortest("H1", id).at(-1)).toBe(id);
    expect(shortest("K3", "M0")).toEqual(expect.arrayContaining(["Lift2", "Lift3", "Lift4", "X4"]));
    expect(N.M0.y).toBe(F4);
  });

  it("every seat is reachable from every desk, station, spot and board, and back", () => {
    for (const seat of seats) {
      for (const p of others) {
        const there = route(atPlace(p), seat);
        expect(there.at(-1)!.p.equals(seat.final)).toBe(true);
        const back = route(atPlace(seat), p);
        expect(back.at(-1)!.p.equals(p.final)).toBe(true);
      }
    }
  });

  it("every seat is reached through its room's door", () => {
    for (const s of seats) {
      const cx = ROOM_XS[s.roomIndex];
      expect(s.via[0].x).toBe(cx);
      expect(s.via[0].z).toBeLessThan(ROOM_FRONT_Z);
    }
  });

  it("no floor-4 route crosses a table or a glass wall except through a door, nor the building walls", () => {
    const pad = 0.25;
    const inTable = (x: number, z: number) => ROOM_XS.some((cx) => Math.abs(x - cx) < TABLE_HALF_X + pad && Math.abs(z - TABLE_Z) < TABLE_HALF_Z + pad);
    const inDoor = (x: number) => ROOM_XS.some((cx) => Math.abs(x - cx) < DOOR_HALF - 0.1);
    // enclosed rooms (deviation 23): the front wall on the corridor, the walls between rooms, Meeting C's right wall
    const inGlass = (x: number, z: number) =>
      (Math.abs(z - ROOM_FRONT_Z) < pad && x > -12.6 && x < ROOM_RIGHT_X + pad && !inDoor(x)) ||
      (z < ROOM_FRONT_Z + pad && [...ROOM_WALLS, ROOM_RIGHT_X].some((wx) => Math.abs(x - wx) < pad));
    const all = [...seats, desks[0].place, stations[0], spots[0]];
    const bad: string[] = [];
    for (const a of all) {
      for (const b of seats) {
        if (a === b) continue;
        for (const r of [route(atPlace(a), b), route(atPlace(b), a)]) {
        for (let i = 1; i < r.length; i++) {
          const p = r[i - 1].p, q = r[i].p;
          if (Math.abs(p.y - F4) > 0.3 || Math.abs(q.y - F4) > 0.3) continue;
          for (let k = 0; k <= 80; k++) {
            const x = p.x + ((q.x - p.x) * k) / 80, z = p.z + ((q.z - p.z) * k) / 80;
            const what = inTable(x, z) ? "table" : inGlass(x, z) ? "glass" : !(z > -7.6 + pad && x > -12.6 + pad && x < 13) ? "wall" : "";
            if (what && bad.length < 10) bad.push(`${what}: ${a.final.toArray()} -> ${b.final.toArray()} at (${x.toFixed(2)}, ${z.toFixed(2)})`);
          }
        }
        }
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("movement with a meeting seat", () => {
  function setup() {
    const logs: string[] = [];
    let now = 0;
    const ctx: NavCtx = { spots: createSpots(), stations: STATION_LAYOUT.map((_, i) => stationPlace(i)), boards: createBoardSlots(), now: () => now, log: (id, m) => logs.push(`${id}: ${m}`), changed: () => {} };
    const mk = (id: string, home: Mover["home"] = desks[0].place): Mover => {
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
  const seat = () => createSeats()[0];

  it("the meeting seat wins over the team station (user decision 2026-11-04), offline still goes home", () => {
    const { ctx, mk } = setup();
    const m = mk("rexx");
    const s = seat();
    expect(workTarget(ctx, m, { status: "working", dept: "red", seat: s })).toBe(s);
    expect(workTarget(ctx, m, { status: "working", dept: "red", seat: null }).kind).toBe("station");
    expect(workTarget(ctx, m, { status: "offline", dept: "red", seat: s })).toBe(m.home);
  });

  it("walks up through the lift to its seat, then sits there: Meeting A · Lt.4, rapat <team>", () => {
    const { logs, mk, run } = setup();
    const m = mk("glimbo");
    const s = seat();
    const a: NavAgent = { status: "working", dept: null, seat: s };
    run(m, a, 0.05);
    expect(logs.at(-1)).toBe("glimbo: Buru-buru ke Meeting A (Lt.4)");
    expect(locText(m)).toEqual({ where: "Lt.2", what: "jalan ke Meeting A" });
    run(m, a, 40);
    expect(m.mv.mode).toBe("desk");
    expect(m.root.position.distanceTo(s.final)).toBeLessThan(1e-6);
    expect(floorOf(m)).toBe(4);
    expect(locText(m, "Tim Glimbo")).toEqual({ where: "Meeting A · Lt.4", what: "rapat Tim Glimbo" });
  });

  it("an idle leader with a seat waits at the table instead of strolling to the lounge", () => {
    const { mk, run } = setup();
    const m = mk("glimbo");
    const s = seat();
    run(m, { status: "working", dept: null, seat: s }, 40);
    run(m, { status: "idle", dept: null, seat: s }, 20);
    expect(m.mv.mode).toBe("desk");
    expect(m.mv.dest).toBe(s);
    // once the meeting is over (no seat) it is an ordinary idle agent again
    run(m, { status: "idle", dept: null, seat: null }, 4);
    expect(m.mv.dest.kind).toBe("spot");
  });

  it("a desk-less subagent (home = its seat) skips the task board on a new task", () => {
    const { mk, run } = setup();
    const s = seat();
    const m = mk("sub", s);
    run(m, { status: "idle", dept: null, seat: s }, 1);
    run(m, { status: "working", dept: null, seat: s }, 1);
    expect(m.mv.fetching).toBe(false);
    expect(m.mv.dest).toBe(s);
    expect(m.mv.mode).toBe("desk");
  });

  it("manual discussion participants go directly to their seat and stay through repeated speaking turns", () => {
    const { ctx, mk, run, logs } = setup();
    const m = mk("speaker"), s = seat();
    const a: NavAgent = { status: "idle", dept: null, seat: s, discussionId: "discussion-1" };
    run(m, a, 0.1);
    run(m, { ...a, status: "thinking" }, 40);
    expect(m.mv.dest).toBe(s);
    expect(m.root.position.distanceTo(s.final)).toBeLessThan(1e-6);
    for (let round = 0; round < 3; round++) {
      for (const status of ["idle", "thinking", "working", "waiting", "error", "idle"] as const) {
        run(m, { ...a, status }, 0.3);
        expect(m.mv).toMatchObject({ mode: "desk", fetching: false, carrying: false });
        expect(m.mv.dest).toBe(s);
      }
    }
    expect(ctx.boards.every((b) => b.occ !== m.id)).toBe(true);
    expect(logs.some((line) => line.includes("ambil tugas di papan"))).toBe(false);
    // After the discussion ends, an ordinary new prompt still fetches a card.
    run(m, { status: "idle", dept: null }, 0.1);
    run(m, { status: "thinking", dept: null }, 0.1);
    expect(m.mv.dest.kind).toBe("board");
  });

  it("joining a manual discussion cancels a pending pickup and releases the board", () => {
    const { ctx, mk, run } = setup();
    const m = mk("joining"), s = seat();
    run(m, { status: "idle", dept: null }, 0.1);
    run(m, { status: "thinking", dept: null }, 0.1);
    const board = m.mv.dest;
    expect(board.kind).toBe("board");
    expect(board.occ).toBe(m.id);
    run(m, { status: "working", dept: null, seat: s, discussionId: "discussion-2" }, 0.1);
    expect(m.mv.dest).toBe(s);
    expect(m.mv).toMatchObject({ fetching: false, carrying: false });
    expect(board.occ).toBeNull();
    expect(ctx.boards.every((b) => b.occ !== m.id)).toBe(true);
  });
});

describe("sliding doors (deviation 23)", () => {
  it("open while an agent is at the door, close again once it has gone in", () => {
    const leaf = new THREE.Group();
    const room = { door: { leaf, open: 0, x: ROOM_XS[1] } } as unknown as MeetingRoomProp;
    const agent = new THREE.Vector3(ROOM_XS[1], F4, ROOM_FRONT_Z + 0.8);
    for (let i = 0; i < 30; i++) stepDoors([room], [agent], 0.05);
    expect(room.door.open).toBeGreaterThan(0.95);
    expect(leaf.position.x).toBeLessThan(-DOOR_HALF * 2 * 0.95); // slid aside over the glass
    agent.set(ROOM_XS[1], F4, TABLE_Z); // at the table
    for (let i = 0; i < 30; i++) stepDoors([room], [agent], 0.05);
    expect(room.door.open).toBeLessThan(0.05);
    // an agent on another floor below the door does not open it
    agent.set(ROOM_XS[1], F4 - 5.6, ROOM_FRONT_Z);
    stepDoors([room], [agent], 0.05);
    expect(room.door.open).toBeLessThan(0.05);
  });
});

describe("Airlock (prd.md §7.10)", () => {
  const airlock = createAirlockSpots();

  it("three standing spots inside, facing the camera, reached through the inner door from node AL", () => {
    expect(airlock).toHaveLength(3);
    expect(ADJ[AIRLOCK_NODE]).toEqual(["M2"]);
    expect(N[AIRLOCK_NODE].x).toBeLessThan(AIRLOCK.x0);
    for (const s of airlock) {
      expect(s.kind).toBe("airlock");
      expect(s.floor).toBe(4);
      expect(s.via[0]).toMatchObject({ x: AIRLOCK.x0 + 0.6, z: AIRLOCK.doorZ });
      expect(s.final.x).toBeGreaterThan(AIRLOCK.x0);
      expect(s.final.x).toBeLessThan(AIRLOCK.x1);
      expect(s.final.z).toBeGreaterThan(AIRLOCK.z0);
      expect(s.final.z).toBeLessThan(AIRLOCK.z1);
    }
  });

  it("every desk, station, spot, board and seat has a route to every Airlock spot", () => {
    for (const p of [...others, ...seats]) {
      for (const s of airlock) expect(route(atPlace(p), s).at(-1)!.p.equals(s.final)).toBe(true);
    }
  });

  it("no route to the Airlock crosses the lift tube, a glass wall, or the Airlock's own walls", () => {
    const pad = 0.25;
    const { x0, x1, z0, z1, doorZ, doorHalf } = AIRLOCK;
    const inLift = (x: number, z: number) => Math.hypot(x - 6.8, z - 4.8) < 0.95 + 0.2; // glass tube radius 0.95
    const inRoomGlass = (x: number, z: number) =>
      (Math.abs(z - ROOM_FRONT_Z) < pad && x > -12.6 && x < ROOM_RIGHT_X + pad && !ROOM_XS.some((cx) => Math.abs(x - cx) < DOOR_HALF - 0.1)) ||
      (z < ROOM_FRONT_Z + pad && [...ROOM_WALLS, ROOM_RIGHT_X].some((wx) => Math.abs(x - wx) < pad));
    const inAirlockWall = (x: number, z: number) =>
      (Math.abs(x - x0) < pad && z > z0 - pad && z < z1 + pad && Math.abs(z - doorZ) > doorHalf - 0.1) ||
      (x > x0 - pad && x < x1 + pad && (Math.abs(z - z0) < pad || Math.abs(z - z1) < pad)) ||
      (Math.abs(x - x1) < pad && z > z0 && z < z1);
    const bad: string[] = [];
    for (const p of [...others, ...seats]) {
      for (const s of airlock) {
        const r = route(atPlace(p), s);
        for (let i = 1; i < r.length; i++) {
          const a = r[i - 1].p, b = r[i].p;
          if (Math.abs(a.y - F4) > 0.3 || Math.abs(b.y - F4) > 0.3) continue;
          for (let k = 0; k <= 80; k++) {
            const x = a.x + ((b.x - a.x) * k) / 80, z = a.z + ((b.z - a.z) * k) / 80;
            // the lift: only its own exit segment (Lift4 -> X4) starts inside the tube
            const lift = inLift(x, z) && !(r[i - 1].ref.t === "node" && (r[i - 1].ref as { id: string }).id === "Lift4");
            const what = lift ? "lift" : inRoomGlass(x, z) ? "glass" : inAirlockWall(x, z) ? "airlock wall" : "";
            if (what && bad.length < 10) bad.push(`${what}: ${p.final.toArray()} -> ${s.final.toArray()} at (${x.toFixed(2)}, ${z.toFixed(2)})`);
          }
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
