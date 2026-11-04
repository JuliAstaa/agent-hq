// Real built routes and the room panel against a scripted Hermes API. No live model calls.
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { startFakeHermes, type FakeHermes } from "../helpers/fake-hermes-api";
import { blockExternal } from "./offline";

let fake: FakeHermes, processUnderTest: ChildProcess, base: string;
test.beforeAll(async () => {
  fake = await startFakeHermes();
  fake.script = async (t) => {
    t.send("run.started");
    t.send("assistant.delta", { delta: `Pendapat ${t.sessionId}` });
    await new Promise((r) => setTimeout(r, 150));
    t.send("assistant.completed", { content: `Pendapat ${t.sessionId}: usulkan pengujian sebelum rilis.` });
    t.send("run.completed"); t.send("done");
  };
  const port = await new Promise<number>((resolve) => {
    const server = net.createServer(); server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port; server.close(() => resolve(port));
    });
  });
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("HQ_")) delete env[key];
  const root = path.resolve(__dirname, "../..");
  processUnderTest = spawn(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "start", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: root, stdio: "ignore",
    env: { ...env, HQ_STATE_FILE: "0", HQ_SERVER_STATS: "0", HQ_HERMES_API_URL: fake.url, HQ_HERMES_API_KEY: fake.key,
      HQ_NAMES_FILE: path.join(root, ".next", `meeting-names-${port}.json`), HQ_HERMES_CHAT_FILE: path.join(root, ".next", `meeting-models-${port}.json`) },
  });
  base = `http://127.0.0.1:${port}`;
  await expect.poll(async () => { try { return (await fetch(base + "/api/health")).status; } catch { return 0; } }, { timeout: 30_000 }).toBe(200);
});
test.afterAll(async () => { processUnderTest?.kill(); await fake?.close(); });

test("monitor opens a discussion, create two real agents, see their shared chat, reopen after reload", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await blockExternal(page); await page.goto(base);
  await page.waitForFunction(() => !!window.agentHQ);
  await page.getByRole("button", { name: "Lt.4 Meeting", exact: true }).click();
  await page.waitForFunction(() => !!window.agentHQ?.controls.enabled);
  const screen = await page.evaluate(() => {
    const { camera, controls } = window.agentHQ!;
    controls.target.set(-8.5, 19.4, -7.4); camera.position.set(-7.5, 21.4, 7.5); controls.update(); camera.updateMatrixWorld(true);
    const point = camera.position.clone().set(-8.5, 19.7, -7.41).project(camera);
    return { x: (point.x + 1) * innerWidth / 2, y: (1 - point.y) * innerHeight / 2 };
  });
  await page.mouse.move(screen.x, screen.y);
  await expect.poll(() => page.locator(".hq-stage canvas").evaluate((canvas) => (canvas as HTMLCanvasElement).style.cursor)).toBe("pointer");
  await page.mouse.click(screen.x, screen.y);
  const panel = page.getByRole("dialog", { name: "Diskusi Meeting A" });
  await expect(panel).toBeVisible();
  await panel.getByLabel("Goal rapat").fill("Tentukan strategi rilis yang aman");
  let failCreation = true;
  await page.route("**/api/meetings", async (route) => {
    const body = route.request().postDataJSON();
    if (failCreation && body?.action === "create_agent") {
      failCreation = false;
      return route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ ok: false, error: "Hermes sementara tidak tersedia" }) });
    }
    return route.continue();
  });
  await panel.getByRole("button", { name: "+ Buat agen baru", exact: true }).click();
  await panel.getByRole("textbox", { name: "Nama", exact: true }).fill("Draft agen");
  await panel.getByRole("textbox", { name: "Peran", exact: true }).fill("Reviewer");
  await panel.getByRole("button", { name: "Buat dan tambahkan", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("Hermes sementara tidak tersedia");
  await expect(panel.getByLabel("Goal rapat")).toHaveValue("Tentukan strategi rilis yang aman");
  await expect(panel.getByRole("textbox", { name: "Nama", exact: true })).toHaveValue("Draft agen");
  await panel.getByRole("button", { name: "Tutup form agen", exact: true }).click();
  for (const [name, role] of [["Arsitek rapat", "Arsitek"], ["Penguji rapat", "QA"]]) {
    await panel.getByRole("button", { name: "+ Buat agen baru", exact: true }).click();
    await panel.getByRole("textbox", { name: "Nama", exact: true }).fill(name);
    await panel.getByRole("textbox", { name: "Peran", exact: true }).fill(role);
    await panel.getByRole("button", { name: "Buat dan tambahkan", exact: true }).click();
    await expect(panel.getByRole("button", { name: `Keluarkan ${name} dari peserta`, exact: true })).toBeVisible();
  }
  expect(fake.sessions).toHaveLength(2);
  await panel.getByLabel("Putaran diskusi").selectOption("1");
  await panel.getByRole("button", { name: "Mulai diskusi", exact: true }).click();
  await expect(panel.getByText("Selesai", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByRole("log", { name: "Percakapan rapat" })).toContainText("Arsitek rapat");
  await expect(panel.getByRole("log", { name: "Percakapan rapat" })).toContainText("Penguji rapat");
  await expect(panel.getByText("Kesimpulan · Arsitek rapat", { exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/meeting-discussion-desktop.png" });
  const calls = fake.calls.filter((c) => c.path.endsWith("/chat/stream"));
  expect(calls).toHaveLength(3);
  expect(calls[1].body).toMatchObject({ message: expect.stringContaining(`Pendapat ${fake.sessions[0].id}`) });
  await page.reload();
  await page.getByRole("button", { name: "Lt.4 Meeting", exact: true }).click();
  await page.getByRole("navigation", { name: "Buka ruang meeting" }).getByRole("button", { name: "Meeting A", exact: true }).click();
  await expect(panel.getByText("Kesimpulan · Arsitek rapat", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Rapat baru", exact: true }).click();
  await expect(panel.getByLabel("Pilih agen yang sudah ada").locator("option")).toHaveCount(3);
  await page.setViewportSize({ width: 360, height: 800 });
  await expect(panel.getByRole("button", { name: "+ Buat agen baru", exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/meeting-setup-mobile.png" });
  await panel.getByRole("button", { name: "+ Buat agen baru", exact: true }).click();
  await panel.getByRole("textbox", { name: "Nama", exact: true }).fill("Agen baru dari rapat");
  await panel.getByRole("textbox", { name: "Peran", exact: true }).fill("Reviewer");
  await page.screenshot({ path: "test-results/meeting-create-agent-mobile.png" });
  expect((await panel.getByLabel("Goal rapat").boundingBox())!.height).toBeGreaterThanOrEqual(60);
  const box = await panel.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(360);
  expect(errors).toEqual([]);
});

test("meeting routes reject cross-site control, invalid JSON and unsupported sessions", async ({ request }) => {
  expect((await request.post(base + "/api/meetings", { headers: { origin: "https://evil.example", "content-type": "application/json" }, data: { action: "create_agent", agent: { name: "X" } } })).status()).toBe(403);
  expect((await request.post(base + "/api/meetings", { headers: { "content-type": "application/json" }, data: "bad json" })).status()).toBe(400);
  const response = await request.get(base + "/api/meetings");
  expect(response.status()).toBe(200);
  expect(Array.isArray((await response.json()).rooms)).toBe(true);
});
