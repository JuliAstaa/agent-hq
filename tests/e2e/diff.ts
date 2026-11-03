// Pixel comparison for visual parity, run inside a blank browser page (no image libraries needed).
// Metric: YIQ color distance as in pixelmatch, threshold 0.2 like Playwright's default comparator.

import type { Browser } from "@playwright/test";

export interface Clip {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Polygon in image pixel coordinates; only pixels inside it are compared. */
export type Polygon = [number, number][];

export interface DiffResult {
  ratio: number;
  diffPixels: number;
  totalPixels: number;
  /** PNG data URL: differing pixels in red over a faded copy of `a`. */
  diffPng: string;
}

export async function diffImages(browser: Browser, a: Buffer, b: Buffer, mask?: Polygon, threshold = 0.2): Promise<DiffResult> {
  const page = await browser.newPage();
  try {
    return await page.evaluate(
      async ({ a64, b64, threshold, mask }) => {
        const load = async (b64s: string) => {
          const img = new Image();
          img.src = "data:image/png;base64," + b64s;
          await img.decode();
          const c = document.createElement("canvas");
          c.width = img.width;
          c.height = img.height;
          const ctx = c.getContext("2d")!;
          ctx.drawImage(img, 0, 0);
          return ctx.getImageData(0, 0, c.width, c.height);
        };
        const A = await load(a64), B = await load(b64);
        if (A.width !== B.width || A.height !== B.height) throw new Error("size mismatch");
        const maxDelta = 35215 * threshold * threshold;
        const out = new ImageData(A.width, A.height);
        // Point-in-polygon per pixel center (even-odd rule); no mask = whole image.
        const inside = (px: number, py: number) => {
          if (!mask) return true;
          let c = false;
          for (let j = 0, k = mask.length - 1; j < mask.length; k = j++) {
            const [xj, yj] = mask[j], [xk, yk] = mask[k];
            if (yj > py !== yk > py && px < ((xk - xj) * (py - yj)) / (yk - yj) + xj) c = !c;
          }
          return c;
        };
        let diff = 0, total = 0;
        for (let i = 0; i < A.data.length; i += 4) {
          const px = (i / 4) % A.width + 0.5, py = Math.floor(i / 4 / A.width) + 0.5;
          if (!inside(px, py)) {
            out.data.set([40, 40, 60, 255], i);
            continue;
          }
          total++;
          const r = A.data[i] - B.data[i], g = A.data[i + 1] - B.data[i + 1], bl = A.data[i + 2] - B.data[i + 2];
          const y = r * 0.29889531 + g * 0.58662247 + bl * 0.11448223;
          const ii = r * 0.59597799 - g * 0.2741761 - bl * 0.32180189;
          const q = r * 0.21147017 - g * 0.52261711 + bl * 0.31114694;
          const delta = 0.5053 * y * y + 0.299 * ii * ii + 0.1957 * q * q;
          const gray = 255 - 0.1 * (255 - (A.data[i] * 0.3 + A.data[i + 1] * 0.59 + A.data[i + 2] * 0.11));
          if (delta > maxDelta) {
            diff++;
            out.data.set([255, 0, 0, 255], i);
          } else out.data.set([gray, gray, gray, 255], i);
        }
        const c = document.createElement("canvas");
        c.width = A.width;
        c.height = A.height;
        c.getContext("2d")!.putImageData(out, 0, 0);
        return { ratio: diff / Math.max(1, total), diffPixels: diff, totalPixels: total, diffPng: c.toDataURL("image/png") };
      },
      { a64: a.toString("base64"), b64: b.toString("base64"), threshold, mask },
    );
  } finally {
    await page.close();
  }
}
