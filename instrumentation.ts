// Runs once when the Next.js server starts (`next start`, `next dev`; not in the static demo export, whose
// pageExtensions leave this file out). Starts the server monitor sampler (prd.md §7.8) so its 30 minute history
// fills even while nobody watches the office.

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_PHASE === "phase-production-build") return;
  const { ensureServerStats } = await import("./lib/bridge/server-stats");
  ensureServerStats();
}
