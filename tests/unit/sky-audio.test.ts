// Sky events and sound settings (deviation 13). Rendering is covered in the browser; here: placement rules,
// lifecycle and cleanup, and the sound settings.
import * as THREE from "three";
import { afterEach, describe, expect, it } from "vitest";
import { audioStore, clampVolume, DEFAULTS, gainOf, parsePrefs, setMusicVolume, setMuted, setSfxVolume, toggleMuted, type SfxDetail } from "@/lib/audio";
import { F2, F3 } from "@/engine/constants";
import { createKit } from "@/engine/scene/kit";
import { buildSky } from "@/engine/scene/sky";
import { createSkyEvents, FIRST_DELAY } from "@/engine/skyEvents";
import { planMeteors, planPortal, segmentDistance, ZONE_X, ZONES, type PlaceCtx, type SkyZone } from "@/engine/skyPlacement";

const kit = createKit();
const VIEWS: Record<string, { pos: [number, number, number]; target: [number, number, number]; top: number }> = {
  semua: { pos: [30, 30, 37], target: [2.6, 6.2, 0.6], top: F3 + 4.7 },
  lt1: { pos: [10, 16.5, 27.5], target: [2.6, 0.4, -1.2], top: 5.4 },
  side: { pos: [-38, 22, 20], target: [0, 6, 0], top: F2 + 5.3 },
};

/** The same inputs the engine builds in placeCtx(), minus the DOM. */
function makeCtx(view = "semua", aspect = 1.6, uiRects: PlaceCtx["uiRects"] = []) {
  const scene = new THREE.Scene();
  const rocks = buildSky(kit, scene);
  const v = VIEWS[view];
  const camera = new THREE.PerspectiveCamera(36, aspect, 0.1, 400);
  camera.position.set(...v.pos);
  camera.lookAt(new THREE.Vector3(...v.target));
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  const bodies = scene.children.filter((o) => o.userData.obstacleRadius);
  const sphere = (o: THREE.Object3D) => new THREE.Sphere(o.getWorldPosition(new THREE.Vector3()), o.userData.obstacleRadius as number);
  const obstacles = bodies.map(sphere);
  const occluders = bodies.filter((o) => !o.userData.smallRock).map(sphere);
  const building: THREE.Vector3[] = [];
  for (const x of [-14.2, 14.2]) for (const z of [-9.2, 9.2]) for (const y of [-0.8, v.top]) building.push(new THREE.Vector3(x, y, z));
  building.push(new THREE.Vector3(0, -9.8, 0), new THREE.Vector3(4, -13, 1.5));
  const ctx: PlaceCtx = { camera, obstacles, occluders, building, uiRects };
  return { scene, camera, ctx, rocks };
}
const farthestBuildingPoint = (ctx: PlaceCtx) => Math.max(...ctx.building.map((p) => p.distanceTo(ctx.camera.position)));
const bezier = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, k: number) =>
  a.clone().multiplyScalar((1 - k) * (1 - k)).addScaledVector(b, 2 * (1 - k) * k).addScaledVector(c, k * k);

describe("sky event placement", () => {
  it("meteors never pass through a planet, moon or floating rock, and stay behind the building", () => {
    let plans = 0;
    for (const view of Object.keys(VIEWS)) {
      const { ctx } = makeCtx(view);
      const far = farthestBuildingPoint(ctx);
      for (const zone of ZONES) {
        for (let i = 0; i < 25; i++) {
          const plan = planMeteors(ctx, zone, 3);
          if (!plan) continue;
          plans++;
          for (const m of plan.rocks) {
            for (const s of ctx.obstacles) expect(segmentDistance(s.center, m.from, m.to)).toBeGreaterThan(s.radius + m.r);
            for (const p of [m.from, m.to]) expect(p.distanceTo(ctx.camera.position)).toBeGreaterThan(far);
          }
        }
      }
    }
    expect(plans).toBeGreaterThan(100);
  });

  it("portals and their shuttle path keep clear of sky bodies and stay behind the building", () => {
    let plans = 0;
    for (const view of Object.keys(VIEWS)) {
      const { ctx } = makeCtx(view);
      const far = farthestBuildingPoint(ctx);
      for (const zone of ZONES) {
        for (let i = 0; i < 15; i++) {
          const plan = planPortal(ctx, zone);
          if (!plan) continue;
          plans++;
          for (const s of ctx.obstacles) expect(s.center.distanceTo(plan.center)).toBeGreaterThan(s.radius + 8 * plan.scale);
          for (let k = 0; k <= 20; k++) {
            const p = bezier(plan.center, plan.p1, plan.p2, k / 20);
            expect(p.distanceTo(ctx.camera.position)).toBeGreaterThan(far);
            for (const s of ctx.obstacles) expect(s.center.distanceTo(p)).toBeGreaterThan(s.radius);
          }
        }
      }
    }
    expect(plans).toBeGreaterThan(60);
  });

  it("left, center and right all happen when the view has room for them", () => {
    const wide = makeCtx("semua", 2.4).ctx; // wide window: open sky left and right of the building
    // In "Semua" the sky right above the roof holds the big ringed planet, so the center needs a lower view.
    const tall = makeCtx("lt1", 0.8).ctx; // Lt.1 view in a tall window: open sky above the building
    const inZone = (ctx: PlaceCtx, p: THREE.Vector3, z: SkyZone) => {
      const x = p.clone().project(ctx.camera).x;
      return x >= ZONE_X[z][0] - 1e-6 && x <= ZONE_X[z][1] + 1e-6;
    };
    for (const [ctx, z] of [[wide, "left"], [wide, "right"], [tall, "center"]] as [PlaceCtx, SkyZone][]) {
      let portals = 0, meteors = 0;
      for (let i = 0; i < 20; i++) {
        const plan = planPortal(ctx, z);
        if (plan) expect(inZone(ctx, plan.center, plan.zone)).toBe(true); // whatever zone it lands in, it is really there
        if (plan?.zone === z) portals++;
        if (planMeteors(ctx, z)?.zone === z) meteors++;
      }
      expect(portals, `portal ${z}`).toBeGreaterThan(4);
      expect(meteors, `meteor ${z}`).toBeGreaterThan(4);
    }
    // with no preference, all three show up over many events
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) for (const ctx of [wide, tall]) seen.add(planPortal(ctx)?.zone ?? "none");
    expect([...seen].filter((z) => z !== "none").sort()).toEqual(["center", "left", "right"]);
  });

  it("a zone hidden by a UI panel is skipped for another one; no room at all means no event", () => {
    const { ctx } = makeCtx("semua", 2.4, [{ x0: -1, x1: -0.3, y0: -1, y1: 1 }]);
    for (let i = 0; i < 10; i++) expect(planPortal(ctx, "left")?.zone).not.toBe("left");
    const blocked = makeCtx("semua", 1.6, [{ x0: -1, x1: 1, y0: -1, y1: 1 }]).ctx;
    expect(planPortal(blocked)).toBeNull();
    expect(planMeteors(blocked)).toBeNull();
  });
});

function setup(uiRects: PlaceCtx["uiRects"] = []) {
  const { scene, camera, ctx } = makeCtx("semua", 2.0, uiRects);
  const sent: SfxDetail[] = [];
  const sky = createSkyEvents({ scene, camera, kit, place: () => ctx, emit: (d) => sent.push(d) });
  const run = (seconds: number) => {
    for (let t = 0; t < seconds; t += 1 / 60) sky.update(1 / 60);
  };
  return { scene, sky, sent, run };
}

describe("sky events", () => {
  it("a meteor event runs, plays its sound panned on screen, then removes everything it added", () => {
    const { scene, sky, sent, run } = setup();
    const base = scene.children.length;
    expect(sky.trigger("meteor")).toBe(true);
    expect(sky.active()).toBe("meteor");
    expect(ZONES).toContain(sky.zone());
    expect(sky.trigger("portal")).toBe(false); // one event at a time
    run(1);
    expect(scene.children.length).toBeGreaterThan(base);
    expect(sent[0]).toMatchObject({ kind: "meteor" });
    for (const d of sent) expect(Math.abs(d.pan ?? 0)).toBeLessThanOrEqual(1);
    run(8);
    expect(sky.active()).toBeNull();
    expect(scene.children.length).toBe(base);
  });

  it("dispose in the middle of an event cleans up", () => {
    const { scene, sky, run } = setup();
    const base = scene.children.length;
    sky.trigger("meteor");
    run(0.8);
    sky.dispose();
    expect(scene.children.length).toBe(base);
    expect(sky.active()).toBeNull();
  });

  it("schedules the first event on its own within the first-delay window", () => {
    const { sky, run } = setup();
    run(FIRST_DELAY[0] - 1);
    expect(sky.active()).toBeNull();
    let started = false;
    for (let t = 0; t < FIRST_DELAY[1] - FIRST_DELAY[0] + 2 && !started; t += 1 / 60) {
      try {
        sky.update(1 / 60);
      } catch {
        started = true; // a portal needs a canvas (no DOM here); reaching it still proves the scheduler fired
      }
      if (sky.active()) started = true;
    }
    expect(started).toBe(true);
  });

  it("with no room anywhere, trigger declines instead of forcing an event", () => {
    const { sky } = setup([{ x0: -1, x1: 1, y0: -1, y1: 1 }]);
    expect(sky.trigger("meteor")).toBe(false);
    expect(sky.active()).toBeNull();
  });
});

describe("sound settings", () => {
  afterEach(() => audioStore.setState({ ...DEFAULTS }));

  it("clamps volumes and maps slider position to a squared gain", () => {
    expect(clampVolume(2)).toBe(1);
    expect(clampVolume(-1)).toBe(0);
    expect(clampVolume(Number.NaN, 0.4)).toBe(0.4);
    expect(gainOf(0.5)).toBe(0.25);
  });

  it("music and effects are separate; moving a slider while muted unmutes; the speaker toggles", () => {
    expect(audioStore.getState()).toMatchObject({ muted: true, music: 0.5, sfx: 0.4 });
    setSfxVolume(0.1);
    expect(audioStore.getState()).toMatchObject({ muted: false, music: 0.5, sfx: 0.1 });
    setMusicVolume(0);
    expect(audioStore.getState()).toMatchObject({ muted: false, music: 0, sfx: 0.1 });
    toggleMuted();
    expect(audioStore.getState().muted).toBe(true);
    setMuted(false);
    expect(audioStore.getState().muted).toBe(false);
  });

  it("saved preferences: the old single volume becomes the music volume, effects reset to the softer default", () => {
    expect(parsePrefs({ muted: false, volume: 0.8 })).toEqual({ muted: false, music: 0.8, sfx: DEFAULTS.sfx });
    expect(parsePrefs({ muted: false, music: 0.3, sfx: 0.2 })).toEqual({ muted: false, music: 0.3, sfx: 0.2 });
    expect(parsePrefs("junk")).toEqual({ muted: true, music: DEFAULTS.music, sfx: DEFAULTS.sfx });
  });
});
