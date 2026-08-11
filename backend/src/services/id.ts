import { randomFillSync } from "node:crypto";

import { systemClock, type Clock } from "./clock.js";

/**
 * Identifiers: `syl:<type>:<uuidv7>`.
 *
 * Type-prefixed so a dangling reference is legible in a log line — `syl:todo:…`
 * in a column that should hold a reminder is a bug you can see rather than one
 * you have to join a table to find. UUIDv7 so ids sort by creation time, which
 * is what lets a cursor be an id instead of an offset.
 *
 * The convention is fixed before the first row is written, because every graph
 * edge in the system will reference it forever.
 */

/** The resource types that get ids. Closed, so a typo is a compile error. */
export type IdType =
  | "principal"
  | "apikey"
  | "pairing_code"
  | "conversation"
  | "message"
  // Images and video (`0015_attachments.sql`). An attachment is addressable on
  // its own because it is created before the message that claims it — see the
  // header of that migration.
  | "attachment"
  | "reminder"
  | "todo"
  | "goal"
  | "device"
  | "delivery"
  | "job"
  | "run"
  | "step"
  // The memory graph (`0012_memory_core.sql`). The KIND of a node — fact,
  // person, source, goal — is a column, not part of the id: `syl:goal:<uuid>`
  // already addresses a row in the operational `goals` table above, and one id
  // shape must never address two different stores.
  | "memory_node"
  | "memory_edge"
  // An ENTITY, as opposed to a node that mentions one (`syl-zdf.3`). Two
  // `person` rows for one woman share a `memory_subject`; neither row is
  // deleted and neither is the "real" one. Its own namespace rather than
  // reusing `memory_node`, because `subject_id` pointing at a node would say
  // "this node is a handle for that node", which is a different claim from
  // "these nodes are the same thing" and is one `projection.ts` already owns.
  | "memory_subject"
  // The supersession ledger (`0017_supersession_ledger.sql`). A row is a CLAIM
  // with a validity interval, not a node: facts are never deleted, they are
  // retired, and the closed rows are what answers "what did I believe in
  // March?".
  | "memory_assertion"
  // The audit record of an explicit deletion (`0020_memory_deletions.sql`).
  // Type-prefixed because it IS referenced from outside: the scope table points
  // at it, and every redaction tombstone left in surviving prose names it — so
  // a dangling reference to a deletion has to stay legible.
  | "memory_deletion"
  // Something she chose to give him (`0024_sendings.sql`): her words, and the
  // video of her saying them. Addressable on its own because it outlives the
  // write that made it — the video lands minutes after the words do, and the
  // surface that lists them is not the conversation.
  | "sending"
  // A render she started and has not looked at yet (`0026_render_watches.sql`).
  // Its own id rather than the render's name, because the name addresses a file
  // on disk and this addresses the promise to come back to it — the two have
  // different lifetimes, and the file outlives the decision.
  | "render_watch"
  // Telemetry, not memory. A dream session is a row in the dream log
  // (`0013_dream_log.sql`) and never a node in the graph — see the header of
  // that migration for why the two must not touch.
  | "dream_session";

/**
 * `syl:<type>:<uuid>`, matching the contract's `Id` pattern exactly.
 *
 * The contract permits either hex case, so this accepts either: a validator at
 * the API boundary that is stricter than the contract rejects requests a
 * conforming client is entitled to make. Syl only ever *mints* lowercase, so
 * the two never disagree on anything it wrote itself.
 */
const SYL_ID =
  /^syl:([a-z][a-z_]*):([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

/** Bytes of entropy in a UUID. */
const UUID_BYTES = 16;

/** Fills a buffer with random bytes. Injectable so tests can be exact. */
export type Entropy = (into: Uint8Array) => void;

/** The real one. */
export const systemEntropy: Entropy = (into) => {
  randomFillSync(into);
};

/**
 * A UUIDv7 generator with monotonic ordering inside a millisecond.
 *
 * RFC 9562 leaves sub-millisecond ordering to the implementation. Left purely
 * random, two ids minted in the same millisecond sort arbitrarily against each
 * other — which is invisible until a cursor built from an id starts skipping
 * or repeating a row under load. This uses the RFC's "replace leftmost random
 * bits with an increased counter" method: within a millisecond the 12-bit
 * `rand_a` field counts up instead of being redrawn.
 *
 * The clock going backwards (NTP correction, a laptop waking in another
 * timezone) is handled by holding the last timestamp rather than emitting an
 * id that sorts before its predecessor. Time can move back; the sequence
 * cannot.
 */
export function createUuidV7(
  clock: Clock = systemClock,
  entropy: Entropy = systemEntropy,
): () => string {
  let lastMs = -1;
  let counter = 0;

  return function uuidv7(): string {
    const now = clock();

    if (now > lastMs) {
      lastMs = now;
      counter = 0;
    } else {
      // Same millisecond, or the clock stepped backwards. Either way the
      // timestamp we emit is the one we already emitted, and the counter is
      // what keeps this id after the last.
      counter += 1;
      if (counter > 0xfff) {
        // 4096 ids in one millisecond. Borrow from the next millisecond
        // rather than wrapping, which would emit a duplicate.
        lastMs += 1;
        counter = 0;
      }
    }

    const bytes = new Uint8Array(UUID_BYTES);
    entropy(bytes);

    const timestamp = BigInt(lastMs);
    bytes[0] = Number((timestamp >> 40n) & 0xffn);
    bytes[1] = Number((timestamp >> 32n) & 0xffn);
    bytes[2] = Number((timestamp >> 24n) & 0xffn);
    bytes[3] = Number((timestamp >> 16n) & 0xffn);
    bytes[4] = Number((timestamp >> 8n) & 0xffn);
    bytes[5] = Number(timestamp & 0xffn);

    // Version 7 in the high nibble of byte 6, then the counter across the
    // remaining 12 bits of `rand_a`.
    bytes[6] = 0x70 | ((counter >> 8) & 0x0f);
    bytes[7] = counter & 0xff;

    // Variant 10 in the top two bits of byte 8. `noUncheckedIndexedAccess`
    // makes the read optional; a 16-byte array always has index 8.
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

    return formatUuid(bytes);
  };
}

/** The process-wide generator. */
export const uuidv7 = createUuidV7();

/** Hyphenate 16 bytes into the canonical UUID text form. */
function formatUuid(bytes: Uint8Array): string {
  const hex = Buffer.from(bytes).toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/** Mint an id for a resource type. */
export function newId(type: IdType, generate: () => string = uuidv7): string {
  return `syl:${type}:${generate()}`;
}

/** Whether a string is a well-formed id, optionally of a particular type. */
export function isId(value: string, type?: IdType): boolean {
  const match = SYL_ID.exec(value);
  if (match === null) return false;
  return type === undefined || match[1] === type;
}

/** The type segment of an id, or `null` if it is not one. */
export function idType(value: string): string | null {
  return SYL_ID.exec(value)?.[1] ?? null;
}
