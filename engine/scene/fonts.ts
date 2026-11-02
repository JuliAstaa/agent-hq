// Canvas fonts. next/font hashes family names, so read the real names from the CSS variables
// set in app/layout.tsx. Canvas text is drawn only after these fonts are loaded.

export interface Fonts {
  bungee: string;
  fredoka: string;
  mono: string;
}

export function resolveFonts(root: Element = document.documentElement): Fonts {
  const cs = getComputedStyle(root);
  const fam = (v: string, fallback: string) => cs.getPropertyValue(v).trim() || fallback;
  return {
    bungee: `${fam("--font-bungee", "Bungee")}, sans-serif`,
    fredoka: `${fam("--font-fredoka", "Fredoka")}, sans-serif`,
    mono: `${fam("--font-jetbrains-mono", "'JetBrains Mono'")}, monospace`,
  };
}

/** Load every face the canvases use, then wait for document.fonts.ready. Never rejects. */
export async function loadFonts(f: Fonts): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return;
  await Promise.all(
    [`40px ${f.bungee}`, `400 20px ${f.fredoka}`, `600 20px ${f.fredoka}`, `12px ${f.mono}`].map((spec) =>
      document.fonts.load(spec).catch(() => []),
    ),
  );
  await document.fonts.ready;
}
