/**
 * What a render costs, from Runway's own published table.
 *
 * ## Why an accounting layer exists when there is no budget to enforce
 *
 * The Commander, 2026-08-11: *"I am totally fine with syl generating a lot of
 * videos shots herself, that is what the credits are for — exactly this sort of
 * experiment... So make it really easy for Syl to create and view the videos
 * she creates."*
 *
 * So **there is no gate here and no cap.** Nothing in this file refuses
 * anything. What it does is make the bill legible, which is the same rule as
 * `because` on every other verb: the evidence travels with the action, and
 * never stands in front of it. She should always be able to answer "what has
 * this cost" — not so that she will do less of it, but so that a thing she does
 * on his money is a thing he can see.
 *
 * ## Why an unknown rate reports `null` rather than an estimate
 *
 * This table is a copy of somebody else's price list and it will go stale. A
 * confident wrong number is worse than an absent one: he would act on it, and
 * nothing anywhere would say it had drifted. So a model or a resolution tier
 * with no published rate answers `null`, the record stores `null`, and the
 * ledger says how many renders it could not price. Compiled from
 * `RUNWAY_API_INDEX.md` in the toolkit repo, dated 2026-06-25.
 */

/** Runway's own conversion. One credit is one US cent. */
export const USD_PER_CREDIT = 0.01;

/**
 * The three resolution bands Runway prices separately.
 *
 * Named for the band rather than for a pixel count because that is how the
 * price list is written: "36 (480/720p), 40 (1080p), 150 (4K)".
 */
export type ResolutionTier = "sd" | "hd" | "uhd";

/**
 * Credits per second of finished video, by model and band.
 *
 * A missing entry is a rate that is not published for that combination, not a
 * rate of zero — see {@link creditsFor}.
 */
export const CREDITS_PER_SECOND: Readonly<
  Record<string, Partial<Readonly<Record<ResolutionTier, number>>>>
> = {
  // The flagship, and what all eight loops were rendered with.
  seedance2: { sd: 36, hd: 40, uhd: 150 },
  // Published at 480/720p only. Worth testing a prompt on before spending on
  // the real one — though at 29 against 36 the saving is thinner than it looks.
  seedance2_fast: { sd: 29 },
  "gen4.5": { sd: 12, hd: 12, uhd: 12 },
  gen4_turbo: { sd: 5, hd: 5, uhd: 5 },
};

/**
 * The band a ratio falls in, from its larger dimension.
 *
 * Ratios arrive as `"720:1280"` — width and height, and the loops are portrait,
 * so the *larger* number is the one that names the resolution.
 */
export function tierOf(ratio: string): ResolutionTier | null {
  const parts = ratio.split(":");
  if (parts.length !== 2) return null;

  const numbers = parts.map((part) => Number.parseInt(part, 10));
  if (numbers.some((value) => !Number.isFinite(value) || value <= 0)) return null;

  const longest = Math.max(...(numbers as number[]));
  if (longest <= 1280) return "sd";
  if (longest <= 2160) return "hd";
  return "uhd";
}

export interface CreditInput {
  readonly model: string;
  readonly ratio: string;
  readonly seconds: number;
}

/** What a render costs in credits, or `null` when there is no published rate. */
export function creditsFor(input: CreditInput): number | null {
  const tier = tierOf(input.ratio);
  if (tier === null) return null;

  const rate = CREDITS_PER_SECOND[input.model]?.[tier];
  if (rate === undefined) return null;
  if (!Number.isFinite(input.seconds) || input.seconds <= 0) return null;

  return rate * input.seconds;
}

/** Credits as dollars, rounded to the cent they already are. */
export function usdOf(credits: number): number {
  return Math.round(credits * USD_PER_CREDIT * 100) / 100;
}
