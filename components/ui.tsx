// Shared 2D UI pieces, styled after the `.card` and `button` rules of references/agent-hq.html.

import type { ButtonHTMLAttributes } from "react";

export const cn = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

/** `.card` without its background (some cards override it). */
export const CARD_FRAME = "border-[3px] border-ink rounded-[14px] shadow-[4px_4px_0_var(--ink)]";
export const CARD = cn("bg-paper", CARD_FRAME);

/** `.pill` */
export const PILL = "text-[11px] font-bold px-2 py-[2px] border-2 border-ink rounded-full whitespace-nowrap";

const BTN_BASE =
  "[font-family:inherit] font-semibold border-[2.5px] border-ink rounded-[10px] shadow-[2px_2px_0_var(--ink)] cursor-pointer " +
  "transition-[translate,box-shadow] duration-[80ms] hover:translate-x-[-1px] hover:translate-y-[-1px] hover:shadow-[3px_3px_0_var(--ink)] " +
  "active:translate-x-[2px] active:translate-y-[2px] active:shadow-[0_0_0_var(--ink)]";

const SIZES = {
  md: "text-[14px] px-3 py-[6px]", // button
  floor: "text-[13px] px-[10px] py-[4px]", // #floors button
  log: "text-[12px] px-[9px] py-[2px]", // #log header button
} as const;

const TONES = {
  paper: "bg-paper text-ink",
  primary: "bg-thinking text-ink", // button.primary, #floors button.on
  alert: "bg-error text-white", // #log header button.on
} as const;

export function Button({
  size = "md",
  tone = "paper",
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { size?: keyof typeof SIZES; tone?: keyof typeof TONES }) {
  return <button type="button" className={cn(BTN_BASE, SIZES[size], TONES[tone], className)} {...rest} />;
}
