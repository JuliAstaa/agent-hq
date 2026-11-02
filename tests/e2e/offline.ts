// Offline helpers for Playwright: serve three.js from node_modules and fonts from the Next build,
// so the prototype (references/agent-hq.html) and the app render with identical assets and no internet.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

const ROOT = path.resolve(__dirname, "../..");
export const PROTOTYPE_URL = "file://" + path.join(ROOT, "references/agent-hq.html");

const CORS = { "access-control-allow-origin": "*" };

/** cdn.jsdelivr.net/npm/three@0.160.0/<path> -> node_modules/three/<path> */
export async function serveThreeOffline(page: Page) {
  await page.route("https://cdn.jsdelivr.net/npm/three@0.160.0/**", (route) => {
    const rel = new URL(route.request().url()).pathname.replace(/^\/npm\/three@0\.160\.0\//, "");
    const file = path.join(ROOT, "node_modules/three", rel);
    if (!file.startsWith(path.join(ROOT, "node_modules/three"))) return route.abort();
    try {
      return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "application/javascript" }, body: readFileSync(file) });
    } catch {
      return route.fulfill({ status: 404, headers: CORS, body: "" });
    }
  });
}

function nextFontCss(): string {
  const dir = path.join(ROOT, ".next/static/chunks");
  const faces: string[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".css")) continue;
    const css = readFileSync(path.join(dir, f), "utf8");
    for (const m of css.matchAll(/@font-face\{[^}]*\}/g)) faces.push(m[0].replace(/url\(\.\.\/media\/([^)]+)\)/g, "url(https://fonts.gstatic.com/hq/$1)"));
  }
  return faces.join("\n");
}

/** Google Fonts CSS + font files -> the same woff2 files next/font bundled in .next/static/media. */
export async function serveFontsOffline(page: Page) {
  const css = nextFontCss();
  await page.route("https://fonts.googleapis.com/**", (route) => route.fulfill({ status: 200, headers: { ...CORS, "content-type": "text/css" }, body: css }));
  await page.route("https://fonts.gstatic.com/**", (route) => {
    const name = path.basename(new URL(route.request().url()).pathname);
    try {
      return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "font/woff2" }, body: readFileSync(path.join(ROOT, ".next/static/media", name)) });
    } catch {
      return route.fulfill({ status: 404, headers: CORS, body: "" });
    }
  });
}

/** Block any other outbound request so tests never depend on the network. */
export async function blockExternal(page: Page) {
  await page.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (route) => route.abort());
}

export async function offline(page: Page) {
  await blockExternal(page);
  await serveThreeOffline(page);
  await serveFontsOffline(page);
}
