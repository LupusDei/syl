/**
 * The health upload contract — the seam the phone and the server meet at.
 *
 * `syl-t9tj.1.3`. Written and pinned BEFORE either side is built, because both
 * halves are built in parallel and this is where they agree. A shape invented
 * twice is a shape that disagrees.
 *
 *
 * ## The authorisation report is the whole reason this file is interesting
 *
 * HealthKit's authorisation model is asymmetric in a way that makes a missing
 * permission SILENT: a type the Commander has not granted does not error and
 * does not report denial — **it reads as empty**. So on the wire, "he walked
 * nowhere on Tuesday" and "we were never allowed to look at steps" are the same
 * zero samples, forever, with every layer reporting success.
 *
 * Only the phone knows the difference. So it says so, per type, on every upload,
 * and the server refuses to interpret silence it cannot attribute
 * ({@link HealthUpload.authorisation}).
 *
 * This is `syl-kqc` one subsystem over. That was a capability the payload claimed
 * and the binary had never been signed for; iOS accepted it, downgraded it
 * silently, and Focus suppressed the notification — server said delivered, Apple
 * said accepted, the phone showed nothing, and no layer recorded an error. The
 * shape of the bug is identical here and the answer is the same: **make the two
 * states different data rather than trusting them to look different.**
 *
 *
 * ## Idempotent by identity, not by request
 *
 * A sample's identity is `(type, startedAt, endedAt, source)` — see
 * {@link sampleKey}. That is what makes a retry, a racing second device, or an
 * app that lost its watermark harmless. It is deliberately NOT the request's
 * idempotency key: that guards one HTTP call, and the failure to guard against
 * is the same measurement arriving in two different calls.
 *
 * Duplicated samples are not a tidiness problem. A doubled sleep sample is a
 * wrong average, which is a wrong baseline, which is a conclusion about a pattern
 * that does not exist — surfaced to him, through Focus, at the level reserved for
 * things that matter.
 */

/**
 * The seven types read at the start (`syl-t9tj`).
 *
 * `restingHeartRate` is kept distinct from `heartRate` on purpose: it is the
 * baseline nearly every conclusion leans on, while raw heart rate is the
 * highest-volume type HealthKit offers. `bodyMass` is here because
 * `Get back to 185 pounds` is already a goal in his memory graph, which is what
 * lets the conclusion layer say something useful before a month of history
 * exists.
 */
export const HEALTH_TYPES = [
  "heartRate",
  "restingHeartRate",
  "heartRateVariability",
  "sleep",
  "steps",
  "workout",
  "bodyMass",
] as const;

export type HealthType = (typeof HEALTH_TYPES)[number];

export function isHealthType(value: unknown): value is HealthType {
  return typeof value === "string" && (HEALTH_TYPES as readonly string[]).includes(value);
}

/**
 * What the phone can say about one type's permission.
 *
 * **Five states, and the last two were added because iOS cannot support three**
 * (`syl-m3gi`, found while building `HealthReader`). The first draft of this file
 * had `authorised | denied | notDetermined`, which is the model Apple's
 * documentation reads like and is not the one the API can answer:
 *
 * - `authorizationStatus(for:)` answers about **sharing**. Syl requests read-only,
 *   so after the sheet it returns `.sharingDenied` for all seven types whatever he
 *   granted. It is the attractive wrong answer.
 * - `statusForAuthorizationRequest(toShare:read:)` reliably proves
 *   **`notDetermined`** — it answers "would iOS still show a prompt?".
 * - A returned sample proves **`authorised`**. It is the only positive proof, and
 *   it exists only when there is data.
 *
 * So *denied*, *authorised-but-quiet*, and *authorised-then-revoked* are ONE
 * indistinguishable state on this platform. Narrowing them all to `denied` — which
 * the reader had to do against the three-state contract — puts the empty-vs-denied
 * conflation back one level up, in the field built to abolish it. `undisclosed`
 * names it instead of hiding it.
 *
 * `unavailable` is separate because it is a different fact with a different
 * remedy: telling him to grant a permission he has already granted is useless
 * advice.
 *
 * **Narrower in practice than it first reads, and the client proved it rather
 * than assuming it** (`syl-m3gi`). The obvious example — "no watch means no
 * HRV" — is NOT detectable per type: `HKHealthStore.isHealthDataAvailable()`
 * answers device-wide only. So the phone emits `unavailable` for exactly two
 * facts, both uniform across all seven types: HealthKit is absent from the
 * device, or the SDK no longer knows the identifier. A phone with no watch
 * reports HRV as `undisclosed`, which is correct — it is genuinely
 * indistinguishable from a type he declined. No detector was invented to make
 * the example true.
 *
 * **And `denied` is currently unreachable from the phone.** `HealthReader` has
 * four provable states and none of them maps to it, because this app has no way
 * to prove he said no — read authorisation is exactly what iOS will not
 * disclose. The state stays in the contract because it is a real fact a future
 * client, or he himself in the admin, could substantiate. But a reader who sees
 * `denied` in the store today should ask where it came from rather than believe
 * it.
 *
 * **Only `authorised` makes silence evidence** ({@link silenceIsEvidence}), so
 * adding states is safe in the direction that matters: an unproven type simply
 * never licenses a conclusion drawn from its quiet.
 *
 * The residual, which no client-side code can close: **revocation after proof is
 * undetectable.** The samples just stop. Named here so nobody looks for the API
 * that would fix it.
 */
export const AUTHORISATION_STATES = [
  "authorised",
  "denied",
  "notDetermined",
  /** Asked, and the platform will not say. See the block above. */
  "undisclosed",
  /** This device cannot measure it — no watch, no sensor. */
  "unavailable",
] as const;

export type AuthorisationState = (typeof AUTHORISATION_STATES)[number];

/** One measurement, as the phone read it. */
export interface HealthSampleInput {
  readonly type: HealthType;
  /** RFC 3339 UTC. */
  readonly startedAt: string;
  /** RFC 3339 UTC. Equal to `startedAt` for an instantaneous reading. */
  readonly endedAt: string;
  /** The number itself. Unit is fixed per type — see {@link UNITS}. */
  readonly value: number;
  /**
   * Which device or app recorded it — "Apple Watch", "iPhone", "Withings".
   *
   * Part of a sample's identity, because the same minute genuinely measured by a
   * watch and a phone is two measurements rather than a duplicate, and averaging
   * them silently would be inventing a third.
   */
  readonly source: string;
}

/** The unit each type's `value` is in. Fixed, so no sample carries its own. */
export const UNITS: Readonly<Record<HealthType, string>> = {
  heartRate: "count/min",
  restingHeartRate: "count/min",
  heartRateVariability: "ms",
  sleep: "min",
  steps: "count",
  workout: "min",
  bodyMass: "lb",
};

/** One upload from the phone. */
export interface HealthUpload {
  /**
   * What the phone was ALLOWED to read, per type, at the moment it read.
   *
   * **Required, and required to be complete** — every type in
   * {@link HEALTH_TYPES} must appear. An upload that omits a type is refused
   * rather than defaulted, because the default would have to be a guess about
   * permission and a guess is exactly what this field exists to abolish.
   */
  readonly authorisation: Readonly<Record<HealthType, AuthorisationState>>;
  readonly samples: readonly HealthSampleInput[];
}

/** What the server answers, so the phone knows where to resume. */
export interface HealthUploadResult {
  /** How many rows this upload actually created. Zero is a valid, quiet answer. */
  readonly written: number;
  /**
   * How many were already held, by identity.
   *
   * Reported rather than hidden: a re-upload that silently answered "written: 0"
   * is indistinguishable from an upload the server dropped, and the phone advances
   * its watermark on this answer.
   */
  readonly duplicates: number;
  /** The new watermark per type — the phone resumes from here. */
  readonly watermarks: Readonly<Partial<Record<HealthType, string>>>;
}

/**
 * A sample's identity.
 *
 * The unit is not part of it: units are fixed per type, so including one would
 * let a client change a sample's identity by relabelling it.
 *
 * **`\0` is written as the ESCAPE, never as the byte**, and the first version of
 * this file got that wrong. NUL is the right separator — it is the one character
 * that cannot appear in a type name, an RFC 3339 instant, or a device name like
 * `"Apple Watch"`, so a source containing spaces or colons cannot forge another
 * sample's key. But a raw U+0000 in the source is invisible and contagious:
 * `grep` and `rg` classify the whole file as binary and print **nothing at all**
 * — not "no matches", no output — so nobody searching for `HEALTH_TYPES` would
 * ever find this file, git renders it as `Bin 0 -> 6942 bytes`, and
 * `scripts/check-no-nul-bytes.mjs` fails `check:env`, which is the `pretest`,
 * `pretypecheck` and `prebuild` hook. One byte took the whole gate down for every
 * agent on every branch carrying the file.
 *
 * The two are identical at runtime. Only one of them is legible.
 */
export function sampleKey(sample: HealthSampleInput): string {
  return [sample.type, sample.startedAt, sample.endedAt, sample.source].join("\0");
}

/**
 * Every type is accounted for, or the upload is refused.
 *
 * Returns the types missing from a report. An empty array means the phone told us
 * about all seven, which is the only condition under which the server is entitled
 * to read "no samples" as "nothing happened".
 */
export function unreportedTypes(
  authorisation: Partial<Record<HealthType, AuthorisationState>>,
): HealthType[] {
  return HEALTH_TYPES.filter((type) => authorisation[type] === undefined);
}

/**
 * Whether the server may treat an absence of samples for this type as evidence.
 *
 * The one function that encodes the whole point of the report: only an
 * `authorised` type with nothing in it means nothing happened. The other two mean
 * we did not look, and a conclusion drawn from them would be about his phone
 * rather than about him.
 */
export function silenceIsEvidence(state: AuthorisationState): boolean {
  // Deliberately an equality and not a set of exclusions. Written as
  // `state !== "denied"`, every state added later would silently become
  // evidence -- which is how `undisclosed` would have started licensing
  // conclusions about a body nobody looked at.
  return state === "authorised";
}
