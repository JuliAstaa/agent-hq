// Engine lifecycle (prd.md §15 M1): StrictMode double-mount in `next dev` must leave exactly one canvas,
// one animation loop and one live WebGL context; dispose() is idempotent and loses the context.

import { expect, test } from "@playwright/test";
import { blockExternal } from "./offline";

const DEV_URL = process.env.HQ_E2E_DEV_URL || `http://127.0.0.1:${(Number(process.env.HQ_E2E_PORT) || 3100) + 1}`;

/* eslint-disable @typescript-eslint/no-explicit-any */
test("StrictMode remount and double dispose do not leak", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await blockExternal(page);
  await page.addInitScript(() => {
    const w = window as any;
    w.__gl = { created: 0, lost: 0 };
    const orig = HTMLCanvasElement.prototype.getContext;
    (HTMLCanvasElement.prototype as any).getContext = function (this: any, type: string, ...rest: unknown[]) {
      const ctx = (orig as any).call(this, type, ...rest);
      if (ctx && /webgl/.test(type) && !this.__hqCounted) {
        this.__hqCounted = true;
        w.__gl.created++;
        this.addEventListener("webglcontextlost", () => w.__gl.lost++);
      }
      return ctx;
    };
    // Count engine loop callbacks (function name `loop`) against real frames.
    const raf = window.requestAnimationFrame.bind(window);
    w.__loops = 0;
    w.__frames = 0;
    window.requestAnimationFrame = (cb: FrameRequestCallback) =>
      raf((t) => {
        if (cb.name === "loop") w.__loops++;
        cb(t);
      });
    const tick = () => {
      w.__frames++;
      raf(tick);
    };
    raf(tick);
  });
  await page.goto(DEV_URL + "/");
  await page.waitForFunction(() => !!(window as any).agentHQ, null, { timeout: 60_000 });
  await page.waitForTimeout(1500);

  const afterMount = await page.evaluate(() => {
    const w = window as any;
    w.__loops = 0;
    w.__frames = 0;
    return { canvases: document.querySelectorAll("canvas").length, gl: { ...w.__gl } };
  });
  // StrictMode: mount -> dispose -> mount. One canvas left, the first context was lost on purpose.
  expect(afterMount.canvases).toBe(1);
  expect(afterMount.gl.created).toBe(2); // proves the StrictMode remount actually happened
  expect(afterMount.gl.created - afterMount.gl.lost).toBe(1);
  await page.waitForTimeout(1000);
  const rate = await page.evaluate(() => (window as any).__loops / Math.max(1, (window as any).__frames));
  expect(rate).toBeGreaterThan(0.5);
  expect(rate).toBeLessThan(1.5); // two loops would give ~2

  // dispose twice: no throw, canvas and labels removed, context lost, loop stopped.
  const after = await page.evaluate(async () => {
    const w = window as any;
    const lostBefore = w.__gl.lost;
    w.agentHQ.engine.dispose();
    w.agentHQ.engine.dispose();
    await new Promise((r) => setTimeout(r, 300));
    w.__loops = 0;
    await new Promise((r) => setTimeout(r, 500));
    return {
      canvases: document.querySelectorAll("canvas").length,
      bubbles: document.querySelectorAll(".bubble,.room").length,
      lostDelta: w.__gl.lost - lostBefore,
      loops: w.__loops,
    };
  });
  expect(after).toEqual({ canvases: 0, bubbles: 0, lostDelta: 1, loops: 0 });
  expect(errors.filter((e) => !/Download the React DevTools|\[HMR\]|\[Fast Refresh\]/.test(e))).toEqual([]);
});
