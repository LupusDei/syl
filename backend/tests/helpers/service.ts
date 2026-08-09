import type { SylConfig } from "../../src/config.js";
import { ApiKeyService, type ApiKeyServiceOptions } from "../../src/services/api-key-service.js";
import { fixedClock, type Clock } from "../../src/services/clock.js";
import { IN_MEMORY, openDatabase, type SylDatabase } from "../../src/services/database.js";
import { DeviceTokenService } from "../../src/services/device-token-service.js";
import type { Entropy } from "../../src/services/id.js";
import { IdempotencyStore } from "../../src/services/idempotency.js";
import { JobStore } from "../../src/services/job-store.js";
import { MessageStore } from "../../src/services/message-store.js";
import { Outbox } from "../../src/services/outbox.js";
import { ReminderService } from "../../src/services/reminder-service.js";

/**
 * The pieces a service-level test needs, assembled the way `bootstrap` does.
 *
 * Every one of these opens a real, migrated SQLite database rather than a
 * double. The store is where the interesting failures are — a CHECK constraint
 * that does not fire, a UNIQUE that does — and a mock cannot have them.
 * `:memory:` makes that free.
 */

/**
 * A migrated, empty database with its seeded rows pinned to the test clock.
 *
 * Migration `0001` seeds the interactive conversation using SQLite's own
 * `strftime('now')` — the REAL wall clock at migration time. That makes the
 * seeded row's timestamps different in every database and, worse, later than
 * anything a fixed-clock test writes once real time passes `TEST_NOW`.
 *
 * It failed exactly that way: `TEST_NOW` is 2026-08-09T07:00Z, so on the day
 * it was written every ordering assertion passed, and from 07:00 UTC the next
 * morning the seeded row sorted first and the suite went red with no change to
 * any code. A time bomb with a one-day fuse, latent from the moment it was
 * committed.
 *
 * Normalising here rather than in the test keeps every future ordering test
 * safe, and keeps the fix in the fixture where the non-determinism enters
 * rather than scattered across the assertions that trip over it.
 *
 * The migration itself is the deeper problem — seeded data should not carry a
 * non-deterministic timestamp — but it has shipped and is checksummed, so that
 * belongs in a follow-up migration rather than an edit. See `syl-1t7`.
 */
export function testDatabase(): SylDatabase {
  const db = openDatabase({ path: IN_MEMORY });
  const seeded = new Date(TEST_NOW - 60_000).toISOString();
  db.handle
    .prepare("UPDATE conversations SET created_at = ?, updated_at = ? WHERE updated_at > ?")
    .run(seeded, seeded, seeded);
  return db;
}

/** A config with every field set, so a new field breaks tests loudly. */
export function testConfig(overrides: Partial<SylConfig> = {}): SylConfig {
  return {
    host: "127.0.0.1",
    // Port 0 asks the kernel for a free one. Tests must never fight over 4201,
    // and never fight each other.
    port: 0,
    nodeEnv: "test",
    version: "0.1.0",
    databasePath: IN_MEMORY,
    credentialSource: "none",
    subscriptionRails: true,
    ...overrides,
  };
}

/** A fixed moment to hang time-dependent assertions off. */
export const TEST_NOW = Date.UTC(2026, 7, 9, 7, 0, 0, 0);

/** Entropy that is deterministic but not constant, so tokens differ. */
export function countingEntropy(start = 1): Entropy {
  let next = start;
  return (into: Uint8Array): void => {
    for (let i = 0; i < into.length; i += 1) into[i] = (next + i) & 0xff;
    next += 1;
  };
}

export interface TestKeyOptions {
  readonly clock?: Clock;
  readonly entropy?: Entropy;
  readonly tokenTtlMs?: number;
  readonly pairingCodeTtlMs?: number;
}

/** A `MessageStore` on a fixed clock. */
export function testMessages(db: SylDatabase, clock: Clock = fixedClock(TEST_NOW)): MessageStore {
  return new MessageStore({ db: db.handle, clock });
}

/** Everything `createApp` needs, on one in-memory store. */
export function testDeps(db: SylDatabase): {
  readonly keys: ApiKeyService;
  readonly messages: MessageStore;
  readonly devices: DeviceTokenService;
  readonly outbox: Outbox;
  readonly reminders: ReminderService;
  readonly jobs: JobStore;
  readonly idempotency: IdempotencyStore;
} {
  const clock = fixedClock(TEST_NOW);
  return {
    keys: testKeys(db),
    messages: testMessages(db),
    devices: new DeviceTokenService({ db: db.handle, clock }),
    // No quiet hours by default: a route test asserting on delivery would
    // otherwise depend on what hour TEST_NOW happens to be in.
    outbox: new Outbox({ db: db.handle, clock }),
    reminders: new ReminderService({ db: db.handle, clock }),
    jobs: new JobStore({ db: db.handle, clock }),
    idempotency: new IdempotencyStore({ db: db.handle, clock }),
  };
}

/** An `ApiKeyService` on a fixed clock and predictable entropy. */
export function testKeys(db: SylDatabase, options: TestKeyOptions = {}): ApiKeyService {
  const built: ApiKeyServiceOptions = {
    db: db.handle,
    clock: options.clock ?? fixedClock(TEST_NOW),
    entropy: options.entropy ?? countingEntropy(),
    ...(options.tokenTtlMs === undefined ? {} : { tokenTtlMs: options.tokenTtlMs }),
    ...(options.pairingCodeTtlMs === undefined
      ? {}
      : { pairingCodeTtlMs: options.pairingCodeTtlMs }),
  };
  return new ApiKeyService(built);
}
