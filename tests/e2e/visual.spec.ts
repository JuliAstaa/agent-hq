// Visual parity (plan-m1.md step 7, user correction):
// 1. Building without agents in the 4 views: prototype vs Next, compared with a tolerance.
//    The 12 empty desks (deviation 7) are hidden on the Next side, and only pixels inside the building's projected
//    outline (convex hull of its box) are compared, so the random floating rocks in the sky do not count.
//    Tolerances come from measured runs (TOLERANCE).
// 2. Demo mode screenshots of the 4 views for manual review (checkpoint after step 4).
// Time is frozen with page.clock and advanced in identical 16 ms frames on both pages.

import { expect, test, type Page } from "@playwright/test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { diffImages, type Clip, type Polygon } from "./diff";
import path from "node:path";
import { offline, PROTOTYPE_URL } from "./offline";

type Which = "proto" | "next";
const VIEWS = [
  ["all", "semua"],
  ["3", "lt3"],
  ["2", "lt2"],
  ["1", "lt1"],
] as const;
const T0 = new Date("2026-11-02T10:10:00+07:00");
/** Building box per view (world units): x, z extent of the island; top = highest visible floor's wall top. */
const BOX_TOP: Record<string, number> = { all: 15.8, "3": 15.8, "2": 11.0, "1": 5.4 };
/**
 * Max diff ratio per view inside the building outline, set a little above the measured maximum.
 * Calibration 2026-11-03, 10 runs, 2D UI hidden on both sides (min-max):
 *   semua 1.50-1.80%, lt3 0.85-1.23%, lt2 0.88-1.01%, lt1 0.66-1.73% (lt1 is usually < 1.1%; the outlier is a random
 *   floating rock seen through the back windows, which the outline mask cannot exclude).
 * The residual is random book colors, plant tentacle heights and rocks behind windows, plus the intended shadow
 * changes of deviation 6. Recalibrate after any intended visual change:
 *   HQ_VISUAL_KEEP=1 npx playwright test -g "building without agents" --repeat-each=5
 */
const TOLERANCE: Record<string, number> = { semua: 0.021, lt3: 0.015, lt2: 0.013, lt1: 0.02 };
const OUT = path.resolve(__dirname, "../../test-results/visual");

/* eslint-disable @typescript-eslint/no-explicit-any -- window.agentHQ differs between prototype and app */
async function open(page: Page, which: Which, errors: string[], hideProtoUi = true) {
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`[${which}] ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`[${which}] ${e.message}`));
  await offline(page);
  await page.clock.install({ time: T0 });
  await page.clock.pauseAt(T0);
  await page.goto(which === "proto" ? PROTOTYPE_URL : "/");
  // Next.js/React schedule work with timers, so advance the frozen clock in small steps until the
  // engine exists. The engine clock starts on its first frame, so this does not shift simTime.
  for (let i = 0; i < 400 && !(await page.evaluate(() => !!(window as any).agentHQ)); i++) {
    await page.clock.runFor(16);
    await page.waitForTimeout(20);
  }
  await page.evaluate(() => document.fonts.ready.then(() => true));
  await page.waitForTimeout(300); // let font-ready callbacks run (real microtasks / promises)
  if (which === "proto" && hideProtoUi) {
    // Hide the prototype's 2D UI so only the 3D scene and in-scene labels are compared (React UI is step 5).
    await page.addStyleTag({ content: "#top,#roster,#log,#toast{display:none!important}" });
  }
}

async function emptyBuilding(page: Page, which: Which) {
  await page.evaluate((w) => {
    const hq = (window as any).agentHQ;
    hq.stopSim();
    if (w === "proto") for (const id of [...hq.agents.keys()]) hq.applyEvent({ type: "remove", id });
    else hq.store.getState().clearAgents();
  }, which);
}

async function startDemo(page: Page, which: Which) {
  await page.evaluate((w) => {
    const hq = (window as any).agentHQ;
    if (w === "proto") hq.startSim();
    else hq.demo();
  }, which);
}

/** Advance simulated time in 50 ms frames (the engines cap dt at 0.05 s, so both pages see the same dt). */
async function advance(page: Page, seconds: number) {
  for (let i = 0; i < Math.round(seconds / 0.05); i++) await page.clock.fastForward(50);
}

async function showView(page: Page, view: string) {
  await page.evaluate((v) => (window as any).agentHQ.setFloor(v), view);
  await advance(page, 1.1); // camera fly takes 0.9 s
}

function save(name: string, buf: Buffer) {
  mkdirSync(path.dirname(path.join(OUT, name)), { recursive: true });
  writeFileSync(path.join(OUT, name), buf);
}

/** Building outline on screen: convex hull of its projected box (island up to `top`) plus a padded clip. */
async function buildingArea(page: Page, top: number): Promise<{ clip: Clip; hull: Polygon }> {
  return page.evaluate((top) => {
    const cam = (window as any).agentHQ.camera;
    cam.updateMatrixWorld();
    const v = cam.matrixWorldInverse.elements, p = cam.projectionMatrix.elements;
    const W = window.innerWidth, H = window.innerHeight;
    const pts: [number, number][] = [];
    for (const x of [-14.2, 14.2]) for (const y of [-0.8, top]) for (const z of [-9.2, 9.2]) {
      const vx = v[0] * x + v[4] * y + v[8] * z + v[12], vy = v[1] * x + v[5] * y + v[9] * z + v[13];
      const vz = v[2] * x + v[6] * y + v[10] * z + v[14], vw = v[3] * x + v[7] * y + v[11] * z + v[15];
      const cx = p[0] * vx + p[4] * vy + p[8] * vz + p[12] * vw, cy = p[1] * vx + p[5] * vy + p[9] * vz + p[13] * vw;
      const cw = p[3] * vx + p[7] * vy + p[11] * vz + p[15] * vw;
      pts.push([((cx / cw) * 0.5 + 0.5) * W, (1 - ((cy / cw) * 0.5 + 0.5)) * H]);
    }
    // Andrew's monotone chain.
    pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower: [number, number][] = [], upper: [number, number][] = [];
    for (const q of pts) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
      lower.push(q);
    }
    for (const q of [...pts].reverse()) {
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
      upper.push(q);
    }
    const hullAbs = [...lower.slice(0, -1), ...upper.slice(0, -1)];
    const pad = 4;
    const xs = hullAbs.map((q) => q[0]), ys = hullAbs.map((q) => q[1]);
    const x = Math.max(0, Math.floor(Math.min(...xs) - pad)), y = Math.max(0, Math.floor(Math.min(...ys) - pad));
    const clip = { x, y, width: Math.min(W, Math.ceil(Math.max(...xs) + pad)) - x, height: Math.min(H, Math.ceil(Math.max(...ys) + pad)) - y };
    return { clip, hull: hullAbs.map(([hx, hy]) => [hx - x, hy - y] as [number, number]) };
  }, top);
}

test.describe("visual parity with references/agent-hq.html", () => {
  // SwiftShader renders the scene in software; under load a 4-view run can take several minutes.
  test.setTimeout(480_000);
  test("building without agents, 4 views", async ({ browser }) => {
    const errors: string[] = [];
    const proto = await browser.newPage();
    const next = await browser.newPage();
    await open(proto, "proto", errors);
    await open(next, "next", errors);
    await emptyBuilding(proto, "proto");
    await emptyBuilding(next, "next");
    await next.evaluate(() => (window as any).agentHQ.engine.debug.hideEmptyDesks(true));
    await next.evaluate(() => (window as any).agentHQ.engine.debug.hideTaskBoard(true)); // deviation 14
    await next.evaluate(() => (window as any).agentHQ.engine.debug.hideServerMonitor(true)); // deviation 20: live samples
    await next.evaluate(() => (window as any).agentHQ.engine.debug.hideMeetingFloor(true)); // deviation 23: three floors
    await next.addStyleTag({ content: "[data-hq-ui]{display:none!important}" }); // compare the scene only
    const ratios: Record<string, number> = {};
    for (const [view, name] of VIEWS) {
      await showView(proto, view);
      await showView(next, view);
      const { clip, hull } = await buildingArea(next, BOX_TOP[view]);
      const a = await proto.screenshot({ clip });
      const b = await next.screenshot({ clip });
      save(`empty-${name}-prototype.png`, a);
      save(`empty-${name}-next.png`, b);
      const d = await diffImages(browser, a, b, hull);
      save(`empty-${name}-diff.png`, Buffer.from(d.diffPng.split(",")[1], "base64"));
      // HQ_VISUAL_KEEP=1 keeps every run's images (for calibration / investigating outliers).
      if (process.env.HQ_VISUAL_KEEP) {
        const tag = `${name}-${(d.ratio * 100).toFixed(2)}-${Date.now()}`;
        save(`runs/${tag}-diff.png`, Buffer.from(d.diffPng.split(",")[1], "base64"));
        save(`runs/${tag}-next.png`, b);
        save(`runs/${tag}-prototype.png`, a);
      }
      ratios[name] = d.ratio;
      console.log(`[visual] empty ${name}: ${(d.ratio * 100).toFixed(2)}% of ${d.totalPixels} px differ (limit ${(TOLERANCE[name] * 100).toFixed(2)}%)`);
      expect.soft(d.ratio, `empty ${name}`).toBeLessThanOrEqual(TOLERANCE[name]);
    }
    mkdirSync(OUT, { recursive: true });
    appendFileSync(path.join(OUT, "empty-ratios.jsonl"), JSON.stringify({ at: new Date().toISOString(), ratios }) + "\n");
    expect(errors).toEqual([]);
  });

  test("demo mode, 4 views (manual review)", async ({ browser }) => {
    const errors: string[] = [];
    const proto = await browser.newPage();
    const next = await browser.newPage();
    await open(proto, "proto", errors);
    await open(next, "next", errors);
    await startDemo(proto, "proto");
    await startDemo(next, "next");
    await advance(proto, 1.5);
    await advance(next, 1.5);
    for (const [view, name] of VIEWS) {
      await showView(proto, view);
      await showView(next, view);
      save(`demo-${name}-prototype.png`, await proto.screenshot());
      save(`demo-${name}-next.png`, await next.screenshot());
    }
    expect(errors).toEqual([]);
  });

  // Meeting floor (prd.md §7.9, deviation 23): a session with two subagents and a two-member group, seated directly
  // (placeAt), in the Lt.4 and Semua views. Screenshots for manual review; the store and engine must agree.
  test("meeting floor: Lt.4 and Semua with two meetings (manual review)", async ({ browser }) => {
    const errors: string[] = [];
    const next = await browser.newPage();
    await open(next, "next", errors);
    await emptyBuilding(next, "next");
    const seats = await next.evaluate(() => {
      const hq = (window as any).agentHQ;
      hq.applyEvent({ id: "glimbo", name: "Glimbo", role: "Coder", status: "working", task: "Delegasi: audit modul auth" });
      hq.applyEvent({ id: "sub-1", name: "Penjelajah", role: "Subagen · demo", parent: "glimbo", status: "working", task: "Cari pemanggil fungsi auth" });
      hq.applyEvent({ id: "sub-2", name: "Penguji", role: "Subagen · demo", parent: "glimbo", status: "thinking", task: "Jalankan test modul transaksi" });
      hq.applyEvent({ id: "plonk", name: "Plonk", role: "QA Tester", status: "working", group: "Rilis v2.3", task: "Regression test rilis v2.3" });
      hq.applyEvent({ id: "vexa", name: "Vexa", role: "Writer", status: "waiting", group: "Rilis v2.3", task: "Draft changelog v2.3" });
      const out: Record<string, string> = {};
      for (const a of hq.store.getState().agents.values()) {
        out[a.id] = `${a.meeting?.room}:${a.meeting?.seat}`;
        if (a.meeting) hq.placeAt(a.id, `seat:${a.meeting.room * 5 + a.meeting.seat}`);
      }
      return out;
    });
    expect(seats).toEqual({ glimbo: "0:0", "sub-1": "0:1", "sub-2": "0:2", plonk: "1:0", vexa: "1:1" });
    await advance(next, 1.5);
    const where = await next.evaluate(() => [...(window as any).agentHQ.store.getState().agents.values()].map((a: any) => `${a.id} ${a.loc?.where} ${a.loc?.what}`));
    expect(where).toEqual([
      "glimbo Meeting A · Lt.4 rapat Tim Glimbo", "sub-1 Meeting A · Lt.4 rapat Tim Glimbo", "sub-2 Meeting A · Lt.4 rapat Tim Glimbo",
      "plonk Meeting B · Lt.4 rapat Rilis v2.3", "vexa Meeting B · Lt.4 rapat Rilis v2.3",
    ]);
    for (const [view, name] of [["4", "lt4"], ["all", "semua"], ["3", "lt3"]] as const) {
      await showView(next, view);
      save(`meeting-${name}.png`, await next.screenshot());
    }
    expect(errors).toEqual([]);
  });

  test("2D UI: Semua and one selected agent (manual review)", async ({ browser }) => {
    const errors: string[] = [];
    const proto = await browser.newPage();
    const next = await browser.newPage();
    await open(proto, "proto", errors, false);
    await open(next, "next", errors);
    await startDemo(proto, "proto");
    await startDemo(next, "next");
    await advance(proto, 1.5);
    await advance(next, 1.5);
    for (const [page, which] of [[proto, "prototype"], [next, "next"]] as const) {
      await page.evaluate(() => (window as any).agentHQ.setFloor("all"));
      await advance(page, 1.1);
      save(`ui-semua-${which}.png`, await page.screenshot());
      await page.locator('.agent[data-id="glimbo"]').click();
      await advance(page, 1.1);
      save(`ui-selected-${which}.png`, await page.screenshot());
    }
    expect(errors).toEqual([]);
  });
});
