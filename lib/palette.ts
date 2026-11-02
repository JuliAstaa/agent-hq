// Avatar palette and id hashing, shared by the store (roster colors) and the engine (avatars).

export const BODY_COLORS = [
  "#ff8fab", "#7bdff2", "#c3a6ff", "#ffc857", "#ff9f68", "#6ee7c8",
  "#f78fff", "#9ad0ff", "#e0e86a", "#ffb3c6", "#b0f2b4", "#f4a259",
];

/** FNV-1a over the string's code points (same as the prototype). */
export function hashStr(s: unknown): number {
  let h = 2166136261;
  for (const ch of String(s)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Body color of the avatar built for `id`. */
export const avatarColor = (id: string): string => BODY_COLORS[(hashStr(id) >>> 3) % BODY_COLORS.length];

/** Roster dot color for an agent without a desk/avatar (prototype quirk: different index). */
export const deskLessColor = (id: string): string => BODY_COLORS[hashStr(id) % BODY_COLORS.length];
