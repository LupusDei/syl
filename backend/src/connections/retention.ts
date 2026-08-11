/**
 * How long an ingested source lives, and how carefully it is deleted.
 *
 * **The class is assigned at intake, never later.** An ingested source is a
 * permanent artifact: within a year the graph has been dreaming over it, and
 * nodes and edges descended from it are scattered through everything Syl
 * believes. Deciding then which of those touch the Commander's marriage, his
 * children or his money is not a migration anybody can write. Deciding now
 * costs one column.
 *
 * The classes are the mechanism, not the policy. Which sources count as
 * sensitive is the Commander's call — the proposal leaves it open — so the
 * host list below is a starting default that is easy to widen and impossible
 * to forget, because every row must carry a class.
 */

/** What a source's retention class can be. */
export type RetentionClass =
  /** A one-off lookup. Purged automatically after {@link EPHEMERAL_DAYS}. */
  | "ephemeral"
  /** Public writing. Kept until something deletes it. */
  | "standard"
  /**
   * Family, money, health, school, legal. Kept, but a delete must reach every
   * node and edge derived from it through the provenance chain.
   */
  | "sensitive";

export const RETENTION_CLASSES: readonly RetentionClass[] = ["ephemeral", "standard", "sensitive"];

/** How long an `ephemeral` source survives before `purgeExpired` takes it. */
export const EPHEMERAL_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whether a string is one of the classes. */
export function isRetentionClass(value: string): value is RetentionClass {
  return (RETENTION_CLASSES as readonly string[]).includes(value);
}

/**
 * Hosts whose content is assumed to touch something private.
 *
 * Matched as substrings of the lowercased hostname, so `chase.com` catches
 * `secure.chase.com`. Deliberately over-inclusive: a public article filed as
 * sensitive costs nothing, and the reverse costs the thing this file exists
 * to protect.
 */
export const SENSITIVE_HOST_PATTERNS: readonly string[] = [
  "bank",
  "chase.com",
  "fidelity.com",
  "vanguard.com",
  "schwab.com",
  "irs.gov",
  "mint.com",
  "myhealth",
  "mychart",
  "patient",
  "health.",
  "clinic",
  "hospital",
  "insurance",
  "schoology",
  "powerschool",
  "classroom.google.com",
  "23andme",
  "ancestry.",
];

export interface RetentionInput {
  /** The URL being ingested. */
  readonly url: string;
  /** An explicit class from the caller. Always wins. */
  readonly requested?: RetentionClass | undefined;
}

export interface RetentionDecision {
  readonly retention: RetentionClass;
  /** Why, in words, so a row can explain itself later. */
  readonly reason: string;
}

/**
 * Decide a source's retention class.
 *
 * An explicit request always wins: the Commander marking something sensitive
 * must not be second-guessed by a host list.
 */
export function classifyRetention(input: RetentionInput): RetentionDecision {
  if (input.requested !== undefined) {
    return { retention: input.requested, reason: "classified explicitly at intake" };
  }

  let host = "";
  try {
    host = new URL(input.url).hostname.toLowerCase();
  } catch {
    // An unparseable URL never reaches the fetcher, but classification runs
    // first and must not be the thing that throws.
    return { retention: "standard", reason: "no host to classify" };
  }

  const matched = SENSITIVE_HOST_PATTERNS.find((pattern) => host.includes(pattern));
  if (matched !== undefined) {
    return { retention: "sensitive", reason: `host matches "${matched}"` };
  }

  return { retention: "standard", reason: "public web content" };
}

/**
 * When a source of this class expires, or `null` for "not on a timer".
 *
 * Only `ephemeral` expires. `sensitive` is the class that most needs deleting
 * and the one least safe to delete on a schedule nobody asked for — it goes
 * when the Commander says so, and then it goes completely.
 */
export function expiryFor(retention: RetentionClass, now: number): string | null {
  if (retention !== "ephemeral") return null;
  return new Date(now + EPHEMERAL_DAYS * DAY_MS).toISOString();
}
