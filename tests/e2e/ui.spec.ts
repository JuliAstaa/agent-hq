// 2D UI behavior (plan-m1.md step 5): connection pill, connect modal, demo, floors, roster selection, log filters.

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
  await expect(page.locator('[data-hq-ui="log"]')).toContainText("Mode demo aktif. Klik agen untuk zoom, pilih lantai di atas.");

  // Floor switcher drives the store (and the engine).
  await page.getByRole("button", { name: "Lt.3 Security" }).click();
  expect(await page.evaluate(() => (window as any).agentHQ.store.getState().floorMode)).toBe("3");
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
