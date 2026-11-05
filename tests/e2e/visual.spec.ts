// Visual checks.
// The 3D scene is no longer the prototype's: the user replaced the four stacked floors with one terraced floor
// (plan-m1.md deviation 29), so the scene parity test against references/agent-hq.html is retired. What stays:
// 1. Building without agents, every view: renders without console errors, each view really moves the camera (the
//    frames differ), screenshots for manual review.
// 2. Demo mode, every view, and the meeting rooms: screenshots for manual review; store and engine must agree.
// 3. 2D UI: prototype vs Next screenshots (the React UI still follows the prototype).
// Time is frozen with page.clock and advanced in 16 ms frames.

import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { diffImages } from "./diff";
import path from "node:path";
import { offline, PROTOTYPE_URL } from "./offline";

type Which = "proto" | "next";
const VIEWS = ["all", "santai", "kantor", "security", "meeting", "server"] as const;
const T0 = new Date("2026-11-02T10:10:00+07:00");
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

test.describe("visual checks", () => {
  // SwiftShader renders the scene in software; under load a 6-view run can take several minutes.
  test.setTimeout(480_000);
  test("building without agents, every view", async ({ browser }) => {
    const errors: string[] = [];
    const next = await browser.newPage();
    await open(next, "next", errors);
    await emptyBuilding(next, "next");
    await next.addStyleTag({ content: "[data-hq-ui]{display:none!important}" }); // the scene only
    const shots: Buffer[] = [];
    for (const view of VIEWS) {
      await showView(next, view);
      const b = await next.screenshot();
      save(`empty-${view}.png`, b);
      shots.push(b);
    }
    // Every view moves the camera: consecutive frames differ a lot (a blank or frozen canvas would not).
    const W = next.viewportSize()!.width, H = next.viewportSize()!.height;
    for (let i = 1; i < shots.length; i++) {
      const d = await diffImages(browser, shots[i - 1], shots[i], [[0, 0], [W, 0], [W, H], [0, H]]);
      expect(d.ratio, `${VIEWS[i - 1]} -> ${VIEWS[i]}`).toBeGreaterThan(0.2);
    }
    expect(errors).toEqual([]);
  });

  test("demo mode, every view (manual review)", async ({ browser }) => {
    const errors: string[] = [];
    const next = await browser.newPage();
    await open(next, "next", errors);
    await startDemo(next, "next");
    await advance(next, 1.5);
    for (const view of VIEWS) {
      await showView(next, view);
      save(`demo-${view}.png`, await next.screenshot());
    }
    expect(errors).toEqual([]);
  });

  // Meeting rooms (prd.md §7.9, deviation 23): a session with two subagents and a two-member group, seated directly
  // (placeAt), in the Meeting and Semua views. Screenshots for manual review; the store and engine must agree.
  test("meeting rooms: Meeting and Semua with two meetings (manual review)", async ({ browser }) => {
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
      "glimbo Meeting A rapat Tim Glimbo", "sub-1 Meeting A rapat Tim Glimbo", "sub-2 Meeting A rapat Tim Glimbo",
      "plonk Meeting B rapat Rilis v2.3", "vexa Meeting B rapat Rilis v2.3",
    ]);
    for (const view of ["meeting", "all", "security"] as const) {
      await showView(next, view);
      save(`meeting-${view}.png`, await next.screenshot());
    }
    expect(errors).toEqual([]);
  });

  // Kick (prd.md §7.10): an idle agent on a garden bench (Kantor) is led by the escort drone down the grand stairs to
  // the Airlock in the front right corner of Santai, waits behind the closed inner door, and is blown out of the
  // hatch into space. Screenshots for manual review.
  test("kick: escort to the Airlock and launch into space (manual review)", async ({ browser }) => {
    const errors: string[] = [];
    const next = await browser.newPage();
    await open(next, "next", errors);
    await emptyBuilding(next, "next");
    await next.addStyleTag({ content: "[data-hq-ui]{display:none!important}" });
    await next.evaluate(() => {
      const hq = (window as any).agentHQ;
      hq.applyEvent({ id: "zorp", name: "Zorp", role: "Researcher", status: "idle", task: "Menunggu prompt berikutnya" });
      hq.placeAt("zorp", "parkB");
    });
    await advance(next, 1);
    await next.evaluate(() => (window as any).agentHQ.applyEvent({ type: "remove", id: "zorp", reason: "kick" }));
    const ejects = () => next.evaluate(() => (window as any).agentHQ.engine.debug.ejects() as { id: string; phase: string; t: number; zone: string; door: number; hatch: number }[]);
    expect(await next.evaluate(() => (window as any).agentHQ.store.getState().agents.has("zorp"))).toBe(false);
    await advance(next, 1.2);
    expect((await ejects()).map((e) => [e.id, e.phase, e.zone])).toEqual([["zorp", "walk", "kantor"]]);
    save("kick-1-escort-semua.png", await next.screenshot());
    await showView(next, "santai");
    const until = async (ok: (e: { phase: string; t: number; hatch: number }) => boolean, max = 30) => {
      for (let i = 0; i < max * 4; i++) {
        const [e] = await ejects();
        if (!e || ok(e)) return e;
        await advance(next, 0.25);
      }
      throw new Error("kick sequence stalled: " + JSON.stringify(await ejects()));
    };
    await until((e) => e.phase === "wait" && e.t > 0.5);
    const inside = (await ejects())[0];
    expect(inside.zone).toBe("santai");
    expect(inside.door).toBeLessThan(0.5);
    save("kick-2-airlock-santai.png", await next.screenshot());
    await until((e) => e.phase === "launch" && e.hatch > 0.8);
    save("kick-3-hatch-santai.png", await next.screenshot());
    await until((e) => e.phase === "fly" && e.t > 0.5);
    save("kick-4-space-santai.png", await next.screenshot());
    await until((e) => e.phase === "fly" && e.t > 1.6);
    save("kick-5-space-santai.png", await next.screenshot());
    await showView(next, "all");
    save("kick-6-space-semua.png", await next.screenshot());
    for (let i = 0; i < 40 && (await ejects()).length; i++) await advance(next, 0.25);
    expect(await ejects()).toEqual([]);
    // it comes back on its next task, with a fresh avatar at its desk
    await next.evaluate(() => (window as any).agentHQ.applyEvent({ id: "zorp", name: "Zorp", status: "working", task: "Benchmark latency" }));
    expect(await next.evaluate(() => (window as any).agentHQ.store.getState().agents.get("zorp")?.status)).toBe("working");
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
