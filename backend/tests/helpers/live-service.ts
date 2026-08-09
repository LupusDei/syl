import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadQuietHours, type SylConfig } from "../../src/config.js";
import {
  API_BASE_PATH,
  bootstrap,
  startServer,
  type ServiceDependencies,
  type RunningService,
} from "../../src/index.js";
import { ApiKeyService } from "../../src/services/api-key-service.js";
import type { Clock } from "../../src/services/clock.js";
import { DeviceTokenService } from "../../src/services/device-token-service.js";
import { openDatabase, type SylDatabase } from "../../src/services/database.js";
import { databaseProbe } from "../../src/routes/health.js";
import { IdempotencyStore } from "../../src/services/idempotency.js";
import { JobStore } from "../../src/services/job-store.js";
import { MessageStore } from "../../src/services/message-store.js";
import { Outbox } from "../../src/services/outbox.js";
import { PresenceService } from "../../src/services/presence.js";
import { ReminderService } from "../../src/services/reminder-service.js";
import { WS_PATH } from "../../src/services/ws-server.js";

/**
 * Syl, started the way `main` starts her.
 *
 * `createApp` in-process is what almost every existing test uses, and it is the
 * right tool for a route's own behaviour. It is the wrong tool for asking
 * whether the service *works*, because it steps over three layers at once:
 * `bootstrap` (which decides what actually gets constructed and wired), the
 * listening socket, and `SylSocketServer` — which only exists on the path
 * through `startServer`. A whole class of seam lives in exactly those layers,
 * and a test that skips them cannot see any of it.
 *
 * So this is the real thing: `bootstrap` against a real SQLite **file**, a real
 * TCP port, and the WebSocket sharing it. The only concession to a test is port
 * 0 — asking the kernel for a free port, so suites never fight over 4201 or
 * each other.
 */

/** A running Syl, and the handles a test needs to talk to her. */
export interface LiveService {
  /** `http://127.0.0.1:PORT/api/v1`. */
  readonly baseUrl: string;
  /** `ws://127.0.0.1:PORT/api/v1/ws`. */
  readonly wsUrl: string;
  /** The origin, without the base path. For probing unmounted paths. */
  readonly origin: string;
  /** A bearer token obtained over HTTP, by pairing exactly as a device does. */
  readonly token: string;
  readonly config: SylConfig;
  readonly deps: ServiceDependencies;
  readonly database: SylDatabase;
  readonly service: RunningService;
  /** The database file, so a restart can reopen the same store. */
  readonly databasePath: string;
  /**
   * The temp directory holding the store, or `null` when the caller supplied
   * the path. WAL leaves `-wal` and `-shm` beside the `.db`, so a restart test
   * that deletes only the file it named leaves two behind in `os.tmpdir()` on
   * every run; removing this directory removes all three.
   */
  readonly directory: string | null;
  /** Fetch a contract path with the bearer token and a fresh idempotency key. */
  api(path: string, init?: LiveRequest): Promise<Response>;
  /** Stop the service. `keepDatabase` leaves the file for a restart test. */
  close(options?: { readonly keepDatabase?: boolean }): Promise<void>;
}

export interface LiveRequest extends RequestInit {
  /** Overrides the generated key, for testing replay. */
  readonly idempotencyKey?: string;
  /** Send no `Authorization` header at all. */
  readonly anonymous?: boolean;
}

/**
 * Build the dependency set exactly as `bootstrap` does, on a chosen clock.
 *
 * `bootstrap` takes no clock, which is right for production and impossible for
 * a story about *when* something happens: a test that boots the real service
 * and then asserts a reminder fired late would be asserting something about the
 * hour the suite happened to run. This repo has already been bitten by exactly
 * that — see the note on `testDatabase` — so determinism is not optional.
 *
 * The constructor list is duplicated here, which is a real cost, so
 * `live-service.test.ts` asserts it against `bootstrap`'s own output. A field
 * added to `ServiceDependencies` and wired in only one of the two turns the suite
 * red rather than quietly making this a different service.
 */
function dependenciesOn(
  config: SylConfig,
  database: SylDatabase,
  clock: Clock,
): ServiceDependencies {
  return {
    keys: new ApiKeyService({ db: database.handle, clock }),
    messages: new MessageStore({ db: database.handle, clock }),
    devices: new DeviceTokenService({ db: database.handle, clock }),
    idempotency: new IdempotencyStore({ db: database.handle, clock }),
    outbox: new Outbox({ db: database.handle, clock, quietHours: config.quietHours }),
    reminders: new ReminderService({ db: database.handle, clock }),
    jobs: new JobStore({ db: database.handle, clock }),
    presence: new PresenceService({ clock, timeZone: config.quietHours.tz }),
    probes: [databaseProbe(database.handle)],
  };
}

export interface StartLiveServiceOptions {
  /** Reopen an existing store instead of creating one. For restart tests. */
  readonly databasePath?: string;
  /** Skip pairing. `token` is then the empty string. */
  readonly pair?: boolean;
  readonly deviceName?: string;
  /**
   * Freeze the service's clock. Omit to use `bootstrap` verbatim, which is what
   * every test that is not about time should do.
   */
  readonly clock?: Clock;
}

/** Boot Syl on a free port with a real on-disk store, and pair one device. */
export async function startLiveService(
  options: StartLiveServiceOptions = {},
): Promise<LiveService> {
  // `directory` is non-null exactly when this call created the store, and
  // `??` short-circuits, so the `join` below only runs on that branch.
  const directory =
    options.databasePath === undefined ? mkdtempSync(join(tmpdir(), "syl-live-")) : null;
  const databasePath = options.databasePath ?? join(directory ?? "", "syl.db");

  const config: SylConfig = {
    host: "127.0.0.1",
    port: 0,
    nodeEnv: "test",
    version: "0.1.0",
    databasePath,
    credentialSource: "none",
    subscriptionRails: true,
    // Through the same validator `loadConfig` uses, so the harness cannot be
    // handed a window production would have refused to start on.
    quietHours: loadQuietHours(process.env),
  };

  let database: SylDatabase;
  let deps: ServiceDependencies;
  if (options.clock === undefined) {
    ({ database, deps } = bootstrap(config));
  } else {
    database = openDatabase({ path: config.databasePath });
    // Migration 0001 seeds the interactive conversation with SQLite's own
    // `strftime('now')` — the real wall clock. On a frozen clock that row is
    // permanently "in the future" and sorts wrongly. Normalised here, where the
    // non-determinism enters, rather than in every assertion that trips on it.
    const seeded = new Date(options.clock() - 60_000).toISOString();
    database.handle
      .prepare("UPDATE conversations SET created_at = ?, updated_at = ? WHERE updated_at > ?")
      .run(seeded, seeded, seeded);
    deps = dependenciesOn(config, database, options.clock);
  }
  const service = await startServer(config, deps);

  const address = service.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the service did not bind a TCP port");
  }
  const { port } = address satisfies AddressInfo;
  const origin = `http://127.0.0.1:${String(port)}`;
  const baseUrl = `${origin}${API_BASE_PATH}`;

  let keyCounter = 0;
  let token = "";

  const api = async (path: string, init: LiveRequest = {}): Promise<Response> => {
    const { idempotencyKey, anonymous, headers, ...rest } = init;
    keyCounter += 1;
    return fetch(`${baseUrl}${path}`, {
      ...rest,
      headers: {
        "content-type": "application/json",
        ...(anonymous === true || token === "" ? {} : { authorization: `Bearer ${token}` }),
        "Idempotency-Key": idempotencyKey ?? `live-${String(keyCounter)}`,
        ...(headers as Record<string, string> | undefined),
      },
    });
  };

  if (options.pair !== false) {
    // Paired over HTTP, not by reaching into `ApiKeyService`. A token minted
    // in-process would skip `POST /auth/pair`, which is the one route every
    // client must survive before it can do anything else.
    const code = deps.keys.issuePairingCode().code;
    const response = await api("/auth/pair", {
      method: "POST",
      anonymous: true,
      body: JSON.stringify({
        pairingCode: code,
        deviceName: options.deviceName ?? "Commander's iPhone",
      }),
    });
    const body = (await response.json()) as { data?: { token?: string } };
    const granted = body.data?.token;
    if (granted === undefined) {
      throw new Error(`pairing failed: ${JSON.stringify(body)}`);
    }
    token = granted;
  }

  return {
    baseUrl,
    origin,
    wsUrl: `ws://127.0.0.1:${String(port)}${WS_PATH}`,
    get token() {
      return token;
    },
    config,
    deps,
    database,
    service,
    databasePath,
    directory,
    api,
    close: async (closeOptions = {}) => {
      await service.close();
      database.close();
      if (directory !== null && closeOptions.keepDatabase !== true) {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  };
}

/** The `{ success, data }` half of the envelope, for a test that expects one. */
export async function expectData<T>(response: Response): Promise<T> {
  const body = (await response.json()) as { success: boolean; data?: T; error?: unknown };
  if (body.success !== true || body.data === undefined) {
    throw new Error(`expected a success envelope, got ${response.status} ${JSON.stringify(body)}`);
  }
  return body.data;
}
