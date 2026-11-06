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

// Kick from the roster (prd.md §7.10), live through the bridge: only an idle or offline agent can be kicked, it leaves
// the roster, idle updates keep it out, and its next task brings it back.
test("kick from the roster (live)", async ({ page, request }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await blockExternal(page);
  await page.goto("/");
  await expect(page.locator('[data-hq-ui="top"] [data-mode]')).toHaveAttribute("data-mode", "live", { timeout: 15_000 });
  const id = `kick-e2e-${Date.now()}`;
  const send = (data: object) => request.post("/api/event", { data });
  await send({ id, name: "Tendang", role: "Tester", status: "working", task: "Kerja dulu" });
  const card = page.locator(`.agent[data-id="${id}"]`);
  const button = card.getByRole("button", { name: "Keluarkan Tendang" });
  await expect(button).toBeDisabled();
  await send({ id, status: "idle" });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(card).toHaveCount(0);
  await expect(page.locator('[data-hq-ui="toast"]')).toHaveText("Tendang dikeluarkan lewat Airlock. Kembali saat mulai kerja.");
  await send({ id, status: "idle", task: "Masih santai" });
  await page.waitForTimeout(500);
  await expect(card).toHaveCount(0);
  await send({ id, status: "working", task: "Balik kerja" });
  await expect(card).toContainText("Tendang");
  await expect(card).toContainText("Balik kerja");
  await send({ type: "remove", id });
  expect(errors).toEqual([]);
});

test("roster buttons ask for HQ_TOKEN once per tab (live)", async ({ page, request }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // The test server runs without HQ_TOKEN; this route stands in for a bridge that has one (like the VPS). Renames
  // are answered here so agent-hq-names.json stays untouched; kicks go on to the real bridge.
  const seen: string[] = [];
  let lastRename: unknown = null;
  await page.context().route("**/api/event", async (route) => {
    const req = route.request();
    if (req.method() !== "POST") return route.continue();
    const auth = (await req.headerValue("authorization")) || "";
    const body = req.postDataJSON() as { type?: string };
    seen.push(`${body?.type} ${auth === "Bearer e2e-token" ? "ok" : auth ? "wrong" : "none"}`);
    if (auth !== "Bearer e2e-token") return route.fulfill({ status: 401, contentType: "application/json", body: '{"ok":false,"error":"token salah"}' });
    if (body?.type === "rename") {
      lastRename = body;
      return route.fulfill({ status: 202, contentType: "application/json", body: '{"ok":true}' });
    }
    return route.continue();
  });
  const open = async (p: typeof page) => {
    await blockExternal(p);
    await p.goto("/");
    await expect(p.locator('[data-hq-ui="top"] [data-mode]')).toHaveAttribute("data-mode", "live", { timeout: 15_000 });
  };
  await open(page);
  const a = `tok-a-${Date.now()}`, b = `tok-b-${Date.now()}`;
  const send = (data: object) => request.post("/api/event", { data });
  await send({ id: a, name: "Tokenan", role: "Tester", status: "idle" });
  await send({ id: b, name: "Tokenin", role: "Tester", status: "idle" });

  // Kick without a token: the card asks for one, a wrong one is refused, the right one kicks.
  const cardA = page.locator(`.agent[data-id="${a}"]`);
  await cardA.getByRole("button", { name: "Keluarkan Tokenan" }).click();
  await expect(cardA).toContainText("Agent HQ memakai HQ_TOKEN. Masukkan tokennya dulu.");
  const field = cardA.getByLabel("HQ_TOKEN", { exact: true });
  await expect(field).toBeFocused();
  await expect(cardA.getByRole("button", { name: "Simpan token" })).toBeDisabled();
  await page.locator('[data-hq-ui="roster"]').screenshot({ path: "test-results/visual/roster-token.png" });
  await field.fill("salah");
  await field.press("Enter");
  await expect(cardA).toContainText("Token salah. Masukkan lagi.");
  await cardA.getByLabel("HQ_TOKEN", { exact: true }).fill("e2e-token");
  await cardA.getByRole("button", { name: "Simpan token" }).click();
  await expect(cardA).toHaveCount(0);
  await expect(page.locator('[data-hq-ui="toast"]')).toHaveText("Tokenan dikeluarkan lewat Airlock. Kembali saat mulai kerja.");

  // Same tab: a rename goes straight through with the saved token.
  const cardB = page.locator(`.agent[data-id="${b}"]`);
  await cardB.getByRole("button", { name: "Ganti nama Tokenin" }).click();
  await cardB.getByLabel("Nama", { exact: true }).fill("Tokenin Baru");
  await cardB.getByRole("button", { name: "Simpan", exact: true }).click();
  await expect(cardB.locator("form")).toHaveCount(0);

  // A new tab has no token yet: the rename form asks for it, and Enter in the field saves it and sends the rename.
  // The first tab closes first: its streams would hold the browser's connections to this host.
  await page.close();
  const page2 = await page.context().newPage();
  page2.on("pageerror", (e) => errors.push(e.message));
  await open(page2);
  const cardB2 = page2.locator(`.agent[data-id="${b}"]`);
  await cardB2.getByRole("button", { name: "Ganti nama Tokenin" }).click();
  await cardB2.getByLabel("Nama", { exact: true }).fill("Tokenin Lagi");
  await cardB2.getByRole("button", { name: "Simpan", exact: true }).click();
  await expect(cardB2.locator("form")).toContainText("Agent HQ memakai HQ_TOKEN. Masukkan tokennya dulu.");
  await cardB2.getByLabel("HQ_TOKEN", { exact: true }).fill("e2e-token");
  await cardB2.getByLabel("HQ_TOKEN", { exact: true }).press("Enter");
  await expect(cardB2.locator("form")).toHaveCount(0);
  expect(lastRename).toEqual({ type: "rename", id: b, name: "Tokenin Lagi" });

  expect(seen).toEqual(["kick none", "kick wrong", "kick ok", "rename ok", "rename none", "rename ok"]);
  await send({ type: "remove", id: a });
  await send({ type: "remove", id: b });
  expect(errors).toEqual([]);
});
