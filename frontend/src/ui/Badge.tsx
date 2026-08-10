import type { ReactElement, ReactNode } from "react";

import { token, type SemanticToken } from "../theme/tokens";

/**
 * A state chip.
 *
 * The tone names a *meaning*, not a colour, and the colour is a token
 * reference the browser resolves — so a palette swap costs no re-render and
 * no component here ever holds a hex value. `views.tsx` established the
 * pattern for the overview's status dots; this is the same idea with a
 * label attached.
 */
export type Tone = "ok" | "warn" | "fail" | "pending" | "muted" | "accent";

const TONE_TOKEN: Record<Tone, SemanticToken> = {
  ok: "stateOk",
  warn: "stateWarn",
  fail: "stateFail",
  pending: "statePending",
  muted: "textMuted",
  accent: "accent",
};

/**
 * The token reference a tone resolves to.
 *
 * Exported because a chip is not the only thing that carries a tone — the memory
 * graph draws its edges in one — and a second copy of this map is exactly how
 * two surfaces end up disagreeing about what "pending" looks like.
 */
export function toneColour(tone: Tone): string {
  return token[TONE_TOKEN[tone]];
}

export interface BadgeProps {
  readonly tone: Tone;
  readonly children: ReactNode;
  /** The long form — the raw enum value, an error, whatever the chip abbreviates. */
  readonly title?: string | undefined;
}

export function Badge({ tone, children, title }: BadgeProps): ReactElement {
  const colour = toneColour(tone);
  return (
    <span className="badge" style={{ color: colour, borderColor: colour }} title={title}>
      {children}
    </span>
  );
}
