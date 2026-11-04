import { defineConfig } from "@playwright/test";

// Visual tests run against the production build (run `npm run build` first) and the prototype file.
// Fully offline: three.js and fonts are served locally through page.route (tests/e2e/offline.ts).
const PORT = Number(process.env.HQ_E2E_PORT) || 3100;
// Next allows one `next dev` per project folder. If one is already running, point HQ_E2E_DEV_URL at it.
const EXTERNAL_DEV = process.env.HQ_E2E_DEV_URL;

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 180_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  outputDir: "test-results/playwright",
  snapshotPathTemplate: "test-results/__snapshots__/{arg}{ext}",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] },
  },
  webServer: [
    {
      command: `node node_modules/next/dist/bin/next start -H 127.0.0.1 -p ${PORT}`,
      url: `http://127.0.0.1:${PORT}/api/health`,
      env: { HQ_STATE_FILE: "0", HQ_SERVER_STATS: "0" },
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    ...(EXTERNAL_DEV ? [] : [{
      // Dev server: React StrictMode double-mount, used by the dispose/leak test.
      command: `node node_modules/next/dist/bin/next dev -H 127.0.0.1 -p ${PORT + 1}`,
      url: `http://127.0.0.1:${PORT + 1}/api/health`,
      env: { HQ_STATE_FILE: "0", HQ_SERVER_STATS: "0" },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    }]),
  ],
});
