import { afterEach, describe, expect, it, vi } from "vitest";
import { drawWhiteboard, WB_EGG_CHANCE, WB_EGG_TEXT } from "@/engine/displays/office";
import type { Floor2Props } from "@/engine/world/floor2";
import type { Fonts } from "@/engine/scene/fonts";

const FONTS: Fonts = { bungee: "Bungee", fredoka: "Fredoka", mono: "monospace" };

/** Minimal 2D context stand-in that records text and full-board clears. */
function board() {
  const texts: string[] = [];
  const points: [number, number][] = [];
  let clears = 0;
  const ctx = new Proxy(
    {
      fillText: (t: string) => texts.push(t),
      measureText: (t: string) => ({ width: t.length * 16 }),
      moveTo: (x: number, y: number) => points.push([x, y]),
      quadraticCurveTo: (_cx: number, _cy: number, x: number, y: number) => points.push([x, y]),
      fillRect: (_x: number, _y: number, w: number, h: number) => {
        if (w === 512 && h === 320) clears++;
      },
    } as Record<string, unknown>,
    { get: (o, k) => (k in o ? o[k as string] : () => {}), set: () => true },
  );
  const wb = { c: {}, ctx, tex: { needsUpdate: false }, strokes: 0, cx: 120, cy: 120 } as unknown as Floor2Props["wb"];
  return { wb, texts, points, clears: () => clears };
}

afterEach(() => vi.restoreAllMocks());

describe("whiteboard easter egg", () => {
  it("writes the whole phrase, one letter per tick, when the session roll hits", () => {
    const { wb, texts } = board();
    vi.spyOn(Math, "random").mockReturnValue(0.1); // < WB_EGG_CHANCE
    for (let i = 0; i < 80; i++) drawWhiteboard(wb, true, FONTS);
    expect(texts.join("")).toBe(WB_EGG_TEXT);
    expect(WB_EGG_TEXT).toBe("hey antek antek asing!");
    expect(wb.egg).toBeNull();
  });

  it("does nothing when the roll misses", () => {
    const { wb, texts } = board();
    vi.spyOn(Math, "random").mockReturnValue(WB_EGG_CHANCE + 0.01);
    for (let i = 0; i < 200; i++) drawWhiteboard(wb, true, FONTS);
    expect(texts).toEqual([]);
  });

  it("rolls once per whiteboard session (off -> on)", () => {
    const { wb } = board();
    const rnd = vi.spyOn(Math, "random").mockReturnValue(0.9);
    drawWhiteboard(wb, true, FONTS);
    const rolls = rnd.mock.calls.length;
    drawWhiteboard(wb, true, FONTS);
    drawWhiteboard(wb, false, FONTS);
    rnd.mockReturnValue(0.1);
    drawWhiteboard(wb, true, FONTS); // new session -> new roll, hits
    expect(wb.egg).toBeTruthy();
    expect(rolls).toBeGreaterThan(0);
  });

  it("waits for fonts before writing any text", () => {
    const { wb, texts } = board();
    wb.forceEgg = true;
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    for (let i = 0; i < 10; i++) drawWhiteboard(wb, true, null);
    expect(texts).toEqual([]);
    for (let i = 0; i < 40; i++) drawWhiteboard(wb, true, FONTS);
    expect(texts.join("")).toBe(WB_EGG_TEXT);
  });

  it("never wipes the board halfway through the phrase", () => {
    const { wb, texts, clears } = board();
    wb.forceEgg = true;
    wb.strokes = 500; // board would normally be cleared on the next scribble
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    for (let i = 0; i < WB_EGG_TEXT.length; i++) drawWhiteboard(wb, true, FONTS);
    expect(texts.join("")).toBe(WB_EGG_TEXT);
    expect(clears()).toBe(0);
  });

  it("later scribbles keep off the phrase until the board is wiped", () => {
    const { wb, texts, points } = board();
    wb.forceEgg = true;
    for (let i = 0; i < WB_EGG_TEXT.length + 1; i++) drawWhiteboard(wb, true, FONTS);
    expect(texts.join("")).toBe(WB_EGG_TEXT);
    const [x0, y0, x1, y1] = wb.keepOut!;
    points.length = 0;
    wb.strokes = 0;
    for (let i = 0; i < 130; i++) drawWhiteboard(wb, true, FONTS);
    expect(points.length).toBeGreaterThan(100);
    expect(points.filter(([x, y]) => x > x0 && x < x1 && y > y0 && y < y1)).toEqual([]);
    for (let i = 0; i < 40; i++) drawWhiteboard(wb, true, FONTS); // passes 140 strokes -> wipe
    expect(wb.keepOut).toBeNull();
  });
});
