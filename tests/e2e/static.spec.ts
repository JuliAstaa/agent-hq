// Static demo export (plan-m1.md step 6): `npm run build:demo` -> out/. No bridge, demo mode only, fully offline.
// Served here by a tiny static file server. Skipped when out/ is missing.

import { expect, test } from "@playwright/test";
import { existsSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { blockExternal } from "./offline";

const OUT = path.resolve(__dirname, "../../out");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "application/javascript", ".css": "text/css", ".woff2": "font/woff2",
  ".json": "application/json", ".txt": "text/plain", ".ico": "image/x-icon", ".mp3": "audio/mpeg", ".svg": "image/svg+xml",
};

let server: http.Server;
let base = "";

test.skip(!existsSync(path.join(OUT, "index.html")), "run `npm run build:demo` first");

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://x");
    let file = path.join(OUT, decodeURIComponent(url.pathname));
    if (!file.startsWith(OUT)) return void res.writeHead(403).end();
    if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, "index.html");
    if (!existsSync(file) && existsSync(file + ".html")) file += ".html";
    if (!existsSync(file)) return void res.writeHead(404).end("not found");
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" }).end(readFileSync(file));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(() => new Promise<void>((r) => server.close(() => r())));

test("static export runs the demo without any bridge request", async ({ page }) => {
  const errors: string[] = [];
  const bridgeRequests: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("request", (r) => {
    const p = new URL(r.url()).pathname;
    if (/^\/(api\/|hook$|event$|stream$|health$|agents$)/.test(p)) bridgeRequests.push(p);
  });
  await blockExternal(page);
  await page.goto(base + "/");
  const pill = page.locator('[data-hq-ui="top"] [data-mode]');
  await expect(pill).toHaveAttribute("data-mode", "demo", { timeout: 30_000 });
  await expect(pill).toHaveText("Mode demo");
  await expect(page.locator(".agent")).toHaveCount(11);
  await expect(page.locator("canvas")).toHaveCount(1);
  // The connect modal still works for pointing at a real bridge, with the app's default URL.
  await page.getByRole("button", { name: "Sambungkan" }).click();
  await expect(page.locator("#inUrl")).toHaveValue("http://localhost:8787/api/stream");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(3000); // let a few demo ticks run
  expect(bridgeRequests).toEqual([]);
  expect(errors).toEqual([]);
});
