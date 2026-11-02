// Visual parity (plan-m1.md step 7, user correction):
// 1. Building without agents in the 4 views: prototype vs Next, compared with a tolerance.
// 2. Demo mode screenshots of the 4 views for manual review (checkpoint after step 4).
// Time is frozen with page.clock and advanced in identical 16 ms frames on both pages.

import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
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
const OUT = path.resolve(__dirname, "../../test-results/visual");

/* eslint-disable @typescript-eslint/no-explicit-any -- window.agentHQ differs between prototype and app */
async function open(page: Page, which: Which, errors: string[]) {
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
  if (which === "proto") {
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
  mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, name), buf);
}

test.describe("visual parity with references/agent-hq.html", () => {
  test("building without agents, 4 views", async ({ browser }, testInfo: TestInfo) => {
    const errors: string[] = [];
    const proto = await browser.newPage();
    const next = await browser.newPage();
    await open(proto, "proto", errors);
    await open(next, "next", errors);
    await emptyBuilding(proto, "proto");
    await emptyBuilding(next, "next");
    for (const [view, name] of VIEWS) {
      await showView(proto, view);
      await showView(next, view);
      const a = await proto.screenshot();
      save(`empty-${name}-prototype.png`, a);
      save(`empty-${name}-next.png`, await next.screenshot());
      // Use the prototype frame as the expected image for Playwright's comparator.
      mkdirSync(path.dirname(testInfo.snapshotPath(`empty-${name}.png`)), { recursive: true });
      writeFileSync(testInfo.snapshotPath(`empty-${name}.png`), a);
      await expect.soft(next).toHaveScreenshot(`empty-${name}.png`, { maxDiffPixelRatio: 0.04, threshold: 0.2 });
    }
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
});
