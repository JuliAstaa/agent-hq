// 2D UI behavior (plan-m1.md step 5): connection pill, connect modal, demo, floors, roster selection, log filters;
// plus the Server panel opened from the 3D server room (deviation 21).

import { expect, test } from "@playwright/test";
import { DEMO } from "../../lib/demo";
import { blockExternal } from "./offline";

/* eslint-disable @typescript-eslint/no-explicit-any */
test("2D UI wiring", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await blockExternal(page);
  await page.goto("/");
  const pill = page.locator('[data-hq-ui="top"] [data-mode]');
  await expect(pill).toHaveAttribute("data-mode", "live", { timeout: 15_000 });
  await expect(pill).toHaveText("Live");
  await expect(page.locator('[data-hq-ui="toast"]')).toHaveText("Tersambung ke /api/stream");

  // Connect modal: prefilled with the live URL, Esc closes it.
  const modal = page.locator('[data-hq-ui="modal"]');
  await expect(modal).toBeHidden();
  await page.getByRole("button", { name: "Sambungkan" }).click();
  await expect(modal).toBeVisible();
  await expect(page.locator("#inUrl")).toHaveValue("/api/stream");
  await expect(page.locator("#inUrl")).toBeFocused();
  await expect(modal).toContainText("jalankan npm start lalu buka http://localhost:8787");
  await page.keyboard.press("Escape");
  await expect(modal).toBeHidden();

  // Back to demo from the modal.
  await page.getByRole("button", { name: "Sambungkan" }).click();
  await page.getByRole("button", { name: "Kembali ke demo" }).click();
  await expect(modal).toBeHidden();
  await expect(pill).toHaveAttribute("data-mode", "demo");
  await expect(pill).toHaveText("Mode demo");
  await expect(page.locator(".agent")).toHaveCount(DEMO.length);
  await expect(page.locator('[data-hq-ui="roster"] header')).toContainText(String(DEMO.length));
  await expect(page.locator('[data-hq-ui="log"]')).toContainText("Mode demo aktif. Klik agen untuk zoom, pilih area di atas.");

  // Area switcher drives the store (and the engine). Single-floor layout, deviation 29.
  await page.getByRole("button", { name: "Security", exact: true }).click();
  expect(await page.evaluate(() => (window as any).agentHQ.store.getState().floorMode)).toBe("security");
  await page.getByRole("button", { name: "Meeting", exact: true }).click(); // meeting rooms (prd.md §7.9)
  expect(await page.evaluate(() => (window as any).agentHQ.store.getState().floorMode)).toBe("meeting");
  await page.getByRole("button", { name: "⌂" }).click();
  expect(await page.evaluate(() => (window as any).agentHQ.store.getState().floorMode)).toBe("all");

  // Roster: click selects and expands, click again deselects.
  const card = page.locator('.agent[data-id="glimbo"]');
  await card.click();
  expect(await page.evaluate(() => (window as any).agentHQ.store.getState().selectedId)).toBe("glimbo");
  await expect(card).toContainText("Progres:");
  await card.click();
  expect(await page.evaluate(() => (window as any).agentHQ.store.getState().selectedId)).toBeNull();
  await expect(card).not.toContainText("Progres:");

  // Log filters: "Error saja" hides non-error lines; "_" minimizes the panel.
  await page.evaluate(() => {
    const hq = (window as any).agentHQ;
    hq.stopSim();
    hq.applyEvent({ type: "log", id: "glimbo", level: "error", message: "boom-test" });
    hq.store.getState().pushLog({ id: "glimbo", level: "move", message: "move-test" });
  });
  const log = page.locator('[data-hq-ui="log"]');
  await expect(log.getByText("boom-test")).toBeVisible();
  await expect(log.getByText("move-test")).toBeVisible();
  await page.getByRole("button", { name: "Jalan" }).click();
  await expect(log.getByText("move-test")).toBeHidden();
  await page.getByRole("button", { name: "Error saja" }).click();
  await expect(log.getByText("boom-test")).toBeVisible();
  await expect(log.getByText("Mode demo aktif", { exact: false })).toBeHidden();
  await page.getByRole("button", { name: "_" }).click();
  await expect(log.getByText("boom-test")).toBeHidden();

  // Agent strings are text, never HTML.
  await page.evaluate(() => (window as any).agentHQ.applyEvent({ id: "x<img src=x onerror=alert(1)>", name: "<b>evil</b>", task: "<script>bad()</script>" }));
  await expect(page.locator('.agent[data-id^="x<img"]')).toContainText("<b>evil</b>");
  expect(await page.locator(".agent b, .agent img, .agent script").count()).toBe(0);

  expect(errors).toEqual([]);
});

// Server panel (plan-m1.md deviation 21): a click on the server room opens it while samples come in.
test("server room click opens the Server panel", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await blockExternal(page);
  await page.goto("/");
  await expect(page.locator('[data-hq-ui="top"] [data-mode]')).toHaveAttribute("data-mode", "live", { timeout: 15_000 });
  // Stable room data; host RAM pressure must not replace UI toasts or change the expected room state.
  await page.waitForFunction(() => !!(window as any).agentHQ);
  await page.evaluate(() => (window as any).agentHQ.applyEvent({
    type: "server_stats", platform: "linux", interval_ms: 60_000, cpu: 0.2, cores: 4, load: [0.2, 0.3, 0.4],
    mem_used: 2 * 1024 ** 3, mem_total: 4 * 1024 ** 3,
    disk_used: 20 * 1024 ** 3, disk_avail: 20 * 1024 ** 3, disk_size: 40 * 1024 ** 3,
    uptime_s: 86400, app_rss: 200 * 1024 ** 2,
  }));
  await page.waitForFunction(() => !!(window as any).agentHQ?.store.getState().server, null, { timeout: 20_000 });
  await page.evaluate(() => (window as any).agentHQ.setFloor("server"));
  await page.waitForFunction(() => (window as any).agentHQ.controls.enabled, null, { timeout: 60_000 }); // camera fly done
  // Find the front of the CPU rack (deviation 29: x 19.4, back tier y 2.4, z -16.4, 1.2 deep) on screen.
  const rack = await page.evaluate(() => {
    const { camera } = (window as any).agentHQ;
    const v = camera.position.clone().set(19.4, 2.4 + 1.6, -15.75).project(camera);
    return { x: ((v.x + 1) / 2) * window.innerWidth, y: ((1 - v.y) / 2) * window.innerHeight };
  });
  const canvas = page.locator(".hq-stage canvas").first();
  await page.mouse.move(rack.x - 4, rack.y);
  await page.waitForTimeout(100);
  await page.mouse.move(rack.x, rack.y);
  await expect.poll(() => canvas.evaluate((c) => (c as HTMLCanvasElement).style.cursor)).toBe("pointer");

  const panel = page.locator('[data-hq-ui="server"]');
  await expect(panel).toHaveCount(0);
  await page.mouse.click(rack.x, rack.y);
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("heading", { name: "SERVER", exact: true })).toBeVisible();
  for (const label of ["CPU", "RAM", "DISK"]) await expect(panel.getByText(label, { exact: true })).toBeVisible();
  await expect(panel.locator("svg[role=img]")).toHaveCount(3);
  await expect(panel).toContainText("Mesin tempat Agent HQ jalan.");
  await expect(panel).toContainText(/NORMAL|SIBUK|KRITIS/);
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);

  // Decor (demo mode, no samples) is not clickable.
  await page.evaluate(() => {
    (window as any).agentHQ.demo();
    (window as any).agentHQ.stopSim();
  });
  await page.waitForFunction(() => !(window as any).agentHQ.store.getState().server);
  await page.mouse.move(rack.x + 4, rack.y);
  await page.waitForTimeout(100);
  await page.mouse.click(rack.x, rack.y);
  await page.waitForTimeout(300);
  await expect(panel).toHaveCount(0);
  expect(await canvas.evaluate((c) => (c as HTMLCanvasElement).style.cursor)).toBe("");

  expect(errors).toEqual([]);
});

// Area switcher (deviation 29): six buttons still fit on a 360 px wide phone, without sideways scrolling.
test("floor switcher fits at 360 px", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await blockExternal(page);
  await page.goto("/");
  const buttons = page.locator("button[data-f]");
  await expect(buttons).toHaveCount(6);
  await expect(buttons.first()).toBeVisible();
  for (const b of await buttons.all()) {
    const box = (await b.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(360);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
});
