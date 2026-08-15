import { modelNote } from "./models.js";

/**
 * What a render costs, at the rate of the model that actually made it.
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
 * A rate is a copy of somebody else's price list and it will go stale. A
 * confident wrong number is worse than an absent one: he would act on it, and
 * nothing anywhere would say it had drifted. So a model or a resolution tier
 * with no published rate answers `null`, the record stores `null`, and the
 * ledger says how many renders it could not price.
 *
 * ## Why there is no table in this file any more
 *
 * There was one, and it was **the second place a rate was written down**. It
 * held `seedance2: {sd: 36, hd: 40, uhd: 150}` and `seedance2_fast: {sd: 29}`,
 * duplicating `models.ts` exactly — and it held **no rate at all** for
 * `seedance2_5`, which is now the house model. So on the day the default
 * changed, every render she made would have priced as `null` and landed in the
 * ledger as *"could not price"*, while a table one directory away knew the
 * answer was 30.
 *
 * That is this project's signature defect stated in one sentence: **a
 * hard-coded price that silently belongs to the old model.** The fix is not a
 * bigger table, it is one table. `models.ts` stores only what a probe measured,
 * against the balance or against `estimatedCost`, with the day it was measured
 * — so a rate here can no longer disagree with the model it prices, because
 * there is nothing here to disagree with.
 *
 * `gen4.5` and `gen4_turbo` were carried in the old table at 12 and 5 credits a
 * second, copied from `RUNWAY_API_INDEX.md` dated 2026-06-25, and are **not**
 * reinstated: nothing has ever rendered on them here, no probe has confirmed
 * those numbers against this account, and a rate nobody measured is exactly what
 * `null` is for. Add them to `models.ts` the day one is probed.
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

/**
 * The band a `resolution`-shaped model was asked for.
 *
 * `grok_imagine_1_5` has no `ratio` key at all — it is an *Unrecognized key*
 * there — so its geometry arrives as `480p｜720p｜1080p` and the price has to be
 * banded off that instead. The names line up with the way Runway writes its own
 * price list: "36 (480/720p), 40 (1080p), 150 (4K)".
 */
export function tierOfResolution(resolution: string): ResolutionTier | null {
  const height = Number.parseInt(resolution.replace(/p$/iu, ""), 10);
  if (!Number.isFinite(height) || height <= 0) return null;
  if (height <= 720) return "sd";
  if (height <= 1080) return "hd";
  return "uhd";
}

export interface CreditInput {
  readonly model: string;
  readonly seconds: number;
  /** The video's shape. What a `ratio`-shaped model is priced off. */
  readonly ratio?: string;
  /** The band. What a `resolution`-shaped model is priced off. */
  readonly resolution?: string;
}

/**
 * What a render costs in credits, or `null` when there is no measured rate.
 *
 * **The rate comes from the model that is actually being used**, which is the
 * whole of `syl-023`'s cost story: 30 credits a second against 36 is 90 credits
 * on one ordinary fifteen-second render, and a constant here would have gone on
 * quoting the old one while the new one was billed.
 */
export function creditsFor(input: CreditInput): number | null {
  const tier =
    input.resolution === undefined
      ? input.ratio === undefined
        ? null
        : tierOf(input.ratio)
      : tierOfResolution(input.resolution);
  if (tier === null) return null;

  const rate = modelNote(input.model)?.creditsPerSecond[tier];
  if (rate === undefined) return null;
  if (!Number.isFinite(input.seconds) || input.seconds <= 0) return null;

  return rate * input.seconds;
}

/** Credits as dollars, rounded to the cent they already are. */
export function usdOf(credits: number): number {
  return Math.round(credits * USD_PER_CREDIT * 100) / 100;
}
