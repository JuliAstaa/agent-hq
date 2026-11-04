// The actual chat panel and built routes, with a held Hermes stream per session.
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { startFakeHermes, type FakeHermes, type Turn } from "../helpers/fake-hermes-api";
import { blockExternal } from "./offline";

let fake: FakeHermes;
let proc: ChildProcess;
let base: string;
const turns = new Map<string, Turn>();

test.beforeAll(async () => {
  fake = await startFakeHermes();
  fake.script = async (t) => {
    turns.set(t.sessionId, t);
    t.send("run.started");
    t.send("assistant.delta", { delta: `Mengerjakan ${t.message}` });
    await t.stopped;
    t.send("run.cancelled");
    t.send("done");
  };
  const port = await new Promise<number>((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("HQ_")) delete env[key];
  const root = path.resolve(__dirname, "../..");
  proc = spawn(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "start", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: root,
    env: { ...env, HQ_STATE_FILE: "0", HQ_SERVER_STATS: "0", HQ_HERMES_API_URL: fake.url, HQ_HERMES_API_KEY: fake.key,
      HQ_NAMES_FILE: path.join(root, ".next", `hermes-e2e-names-${port}.json`),
      HQ_HERMES_CHAT_FILE: path.join(root, ".next", `hermes-e2e-models-${port}.json`) },
    stdio: "ignore",
  });
  base = `http://127.0.0.1:${port}`;
  await expect.poll(async () => {
    try { return (await fetch(base + "/api/health")).status; } catch { return 0; }
  }, { timeout: 30_000 }).toBe(200);
});

test.afterAll(async () => {
  proc?.kill();
  await fake?.close();
});

test("Hermes: create and switch sessions while both work, preserve drafts, stop only the selected session", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await blockExternal(page);
  await page.goto(base);
  await page.getByRole("button", { name: "Hermes", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Chat Hermes" });
  const input = panel.getByRole("textbox", { name: "Pesan untuk Hermes" });
  await input.fill("tugas A");
  await panel.getByRole("button", { name: "Kirim", exact: true }).click();
  await expect(panel.getByText("Mengerjakan tugas A", { exact: false })).toBeVisible();
  const aid = [...turns.keys()][0];
  await input.fill("draft A");
  await expect(panel.getByRole("button", { name: "Baru", exact: true })).toBeEnabled();
  await panel.getByRole("button", { name: "Baru", exact: true }).click();
  await panel.getByRole("textbox", { name: "Nama", exact: true }).fill("Sesi B");
  await panel.getByRole("button", { name: "Mulai sesi", exact: true }).click();
  await expect(panel.getByRole("button", { name: /Agen: Sesi B/ })).toBeVisible();
  await expect(input).toHaveValue("");
  await input.fill("tugas B");
  await panel.getByRole("button", { name: "Kirim", exact: true }).click();
  await expect(panel.getByText("Mengerjakan tugas B", { exact: false })).toBeVisible();
  const bid = [...turns.keys()].find((id) => id !== aid)!;
  await input.fill("draft B");
  await panel.getByRole("button", { name: "Riwayat", exact: true }).click();
  await expect(panel.getByText("Bekerja", { exact: true })).toHaveCount(3); // header plus two sessions
  await expect(panel.getByRole("button", { name: "Hapus", exact: true }).first()).toBeDisabled();
  await panel.getByRole("button", { name: "Buka", exact: true }).click();
  await expect(panel.getByText("Mengerjakan tugas A", { exact: false })).toBeVisible();
  await expect(panel.getByText("Mengerjakan tugas B", { exact: false })).toBeHidden();
  await expect(input).toHaveValue("draft A");
  await panel.getByRole("button", { name: "Hentikan", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Kirim", exact: true })).toBeVisible();
  const sessions = await (await page.request.post(base + "/api/hermes", { data: { action: "sessions" } })).json();
  expect(sessions.sessions).toContainEqual(expect.objectContaining({ id: bid, phase: "running" }));
  await panel.getByRole("button", { name: "Riwayat", exact: true }).click();
  await panel.getByRole("button", { name: "Buka", exact: true }).click();
  await expect(panel.getByText("Mengerjakan tugas B", { exact: false })).toBeVisible();
  await expect(input).toHaveValue("draft B");
  await panel.getByRole("button", { name: "Hentikan", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Kirim", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
