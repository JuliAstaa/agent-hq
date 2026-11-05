// Areas of the single-floor terraced office (plan-m1.md deviation 29). Shared by the store, the UI and the engine.
// No DOM, no three.js.

/** Areas, front (low) to back (high): Santai on the front tier, Kantor on the middle tier, Security, Meeting and
 *  Server side by side on the back tier. */
export const ZONES = ["santai", "kantor", "security", "meeting", "server"] as const;
export type ZoneId = (typeof ZONES)[number];

/** View chosen in the area switcher: the whole island or one area. */
export type FloorMode = "all" | ZoneId;

export const ZONE_LABEL: Record<ZoneId, string> = {
  santai: "Santai",
  kantor: "Kantor",
  security: "Security",
  meeting: "Meeting",
  server: "Server",
};

export const isFloorMode = (v: unknown): v is FloorMode => v === "all" || (ZONES as readonly unknown[]).includes(v);
