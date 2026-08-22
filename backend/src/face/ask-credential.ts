import { createHash, timingSafeEqual } from "node:crypto";

import { parseInstant } from "../services/clock.js";
import { systemEntropy, type Entropy } from "../services/id.js";
import type { FaceSession, FaceSessionStore } from "./face-session-store.js";

/**
 * The credential the avatar presents when it calls back to ask her something.
 *
 * ## Why this is not an API key
 *
 * `api_keys` holds standing credentials for **the Commander**: a `device` key
 * is his phone, an `admin` key is his console, an `agent` key is Syl's own
 * hands. Each has a `Principal` behind it, lasts a year, and is minted by
 * pairing or at a terminal. Every one of those properties is wrong here:
 *
 * | | a device key | an ask_syl credential |
 * |---|---|---|
 * | who holds it | the Commander's phone | a provider's avatar process |
 * | how long | a year | the minutes one face lasts |
 * | how minted | `POST /auth/pair`, eight digits | only by paying for a session |
 * | what it reaches | his whole API | one question, on one session |
 * | how revoked | explicitly | by the session ending |
 *
 * Reusing the `scope` column would have put a five-minute machine credential in
 * the same table as the key on his phone, and the first person to widen a scope
 * check would have joined them. So: a different table (`face_sessions`), a
 * different prefix, a different verifier, and no `Principal` at any point. The
 * two systems share nothing but the rule that only a hash touches disk.
 *
 * **It expires with the session, structurally.** The hash is a *column of the
 * session row*, so settling the session is what invalidates the credential —
 * there is no sweeper to run and no TTL anybody has to remember. `askExpiresAt`
 * is belt and braces on top, for the row a crashed process never settled.
 *
 * ## What a rejected caller learns
 *
 * Nothing. Every failure — malformed, unknown session, settled, expired, wrong
 * secret — produces {@link ASK_REJECTION_MESSAGE} and no more. The distinctions
 * exist internally, where they answer "why did her face stop answering", and
 * they must not be derivable from outside: a caller who can tell "no such
 * session" from "wrong secret" can enumerate live sessions, and one who can
 * tell "expired" from "wrong secret" has an oracle for guessing.
 *
 * The comparison is constant-time, and an unknown session is compared against a
 * decoy hash rather than returning early, so the *timing* does not answer the
 * question the message refuses to.
 */

/**
 * `syl_face_` plus 32 hex characters.
 *
 * Deliberately not `syl_pat_`. The prefixes are checked against each other in
 * `face-ask-credential.test.ts`, so the day somebody unifies them is the day a
 * test says so.
 */
export const ASK_SECRET_PREFIX = "syl_face_";

const SECRET_HEX_LENGTH = 32;
const SECRET_SHAPE = new RegExp(`^${ASK_SECRET_PREFIX}[0-9a-f]{${SECRET_HEX_LENGTH}}$`);

/** The one message every rejection produces. See the note above. */
export const ASK_REJECTION_MESSAGE =
  "This face session did not accept that credential.";

/**
 * A hash of something that is not any real secret, compared against when there
 * is nothing to compare against — so an unknown session costs the same time as
 * a known one with a wrong secret.
 */
const DECOY_HASH = createHash("sha256").update("syl:face:decoy", "utf8").digest("hex");

/** A freshly minted credential: the secret to hand out, and the hash to store. */
export interface MintedAskSecret {
  /** Given to the RPC handler for this session. Never stored, never logged. */
  readonly secret: string;
  /** SHA-256 hex. The only form that touches disk. */
  readonly hash: string;
}

/** SHA-256, hex. The only form of the secret that touches disk. */
export function hashAskSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** Mint a per-session credential. 128 bits, from the system CSPRNG. */
export function mintAskSecret(entropy: Entropy = systemEntropy): MintedAskSecret {
  const bytes = new Uint8Array(SECRET_HEX_LENGTH / 2);
  entropy(bytes);
  const secret = `${ASK_SECRET_PREFIX}${Buffer.from(bytes).toString("hex")}`;
  return { secret, hash: hashAskSecret(secret) };
}

/** Why a credential was refused. Internal — for the log, never for the caller. */
export type AskRejectionReason =
  | "malformed"
  | "unknown_session"
  | "settled"
  | "expired"
  | "mismatch";

export type AskVerification =
  | { readonly ok: true; readonly session: FaceSession }
  | {
      readonly ok: false;
      readonly reason: AskRejectionReason;
      /** Always {@link ASK_REJECTION_MESSAGE}. */
      readonly message: string;
    };

/** What the store must offer for a credential to be checked. */
export type AskCredentialLookup = Pick<FaceSessionStore, "get">;

export interface VerifyAskCredentialInput {
  readonly sessions: AskCredentialLookup;
  readonly sessionId: string;
  readonly secret: string;
  /** Epoch milliseconds. Injected so expiry is testable without waiting. */
  readonly now: number;
}

/** Constant-time equality over two hex digests of equal length. */
function hashesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  // `timingSafeEqual` throws on a length mismatch, which would itself be a
  // disclosure. Both sides are SHA-256 hex from this module, so a mismatch
  // means malformed storage rather than a guess — refuse it either way.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function refuse(reason: AskRejectionReason): AskVerification {
  return { ok: false, reason, message: ASK_REJECTION_MESSAGE };
}

/**
 * Is this the credential for this live session?
 *
 * Never throws, and never returns early in a way that a stopwatch could read.
 * A malformed secret is the one shape rejected before the store is consulted,
 * and that is safe to disclose by timing: it says nothing about which sessions
 * exist, only that the caller did not send something of the right shape.
 */
export function verifyAskCredential(input: VerifyAskCredentialInput): AskVerification {
  if (!SECRET_SHAPE.test(input.secret)) return refuse("malformed");

  const presented = hashAskSecret(input.secret);
  const session = input.sessions.get(input.sessionId);

  if (session === null) {
    // Compared anyway, so an unknown session costs what a known one costs.
    hashesMatch(presented, DECOY_HASH);
    return refuse("unknown_session");
  }

  const matches = hashesMatch(presented, session.askSecretHash);

  // Order matters only for the internal reason. Whatever answer comes back, the
  // outward message is one string, so the ordering discloses nothing.
  if (!matches) return refuse("mismatch");
  if (session.closedAt !== null) return refuse("settled");

  const expiresAt = parseInstant(session.askExpiresAt);
  if (expiresAt === null || input.now >= expiresAt) return refuse("expired");

  return { ok: true, session };
}
