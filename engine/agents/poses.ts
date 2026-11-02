// Body pose offsets per pose name (lie is handled separately in animate.ts).

export const POSE: Record<string, { y: number; rx: number; z: number; leg: number }> = {
  desk: { y: 0, rx: 0, z: 0, leg: -1.35 },
  walk: { y: 0, rx: 0, z: 0, leg: 0 },
  stand: { y: 0, rx: 0, z: 0, leg: 0 },
  sit: { y: -0.1, rx: 0, z: 0, leg: -1.35 },
  stool: { y: 0.15, rx: 0, z: 0, leg: -0.45 },
  recline: { y: 0.05, rx: -1.0, z: 0.75, leg: -0.8 },
};
