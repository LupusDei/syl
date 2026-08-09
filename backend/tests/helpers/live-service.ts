import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PushEnvironment } from "@syl/shared";

import { loadQuietHours, type SylConfig } from "../../src/config.js";
import type { TurnOptions, TurnRunner } from "../../src/harness/session.js";
import {
  API_BASE_PATH,
  startSyl,
  type ServiceDependencies,
  type RunningService,
} from "../../src/index.js";
import type { DeliveryRuntime } from "../../src/jobs/runtime.js";
import type { Clock } from "../../src/services/clock.js";
import type { SylDatabase } from "../../src/services/database.js";
import type { Timers } from "../../src/services/job-runner.js";
import { WS_PATH } from "../../src/services/ws-server.js";
import { loadFixture, makeFakeClaude, type FakeClaude, type FakeClaudeConfig } from "./fake-claude.js";
import { silentRunner } from "./service.js";

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
 * So this is the real thing: `startSyl` — the entire body of `main` — against a
 * real SQLite **file**, a real TCP port, and the WebSocket sharing it. That
 * includes the delivery runtime and the content-ingestion job, which used to be
 * assembled in `main` alone and therefore ran for the first time in production
 * (`syl-md5`). The only concessions to a test are port 0 — asking the kernel for
 * a free port, so suites never fight over 4201 or each other — and a timer the
 * test drives by hand.
 */

/** A timer the test drives by hand, so no wall-clock second is ever spent. */
export const inertTimers: Timers = { set: () => 0, clear: () => undefined };

/**
 * A fake `claude` that answers, replaying a real captured transcript.
 *
 * Pass it as `claude` to make a live service actually spawn a subprocess per
 * turn, through `runTurn`, exactly as production does. That is the shape US2
 * needs and it costs a node spawn per message — which is why it is opt-in
 * rather than the default. See {@link StartLiveServiceOptions.claude}.
 */
export function answeringClaude(): FakeClaudeConfig {
  return { after: loadFixture("turn-pong"), exitCode: 0 };
}

/**
 * What {@link answeringClaude} says.
 *
 * It is the answer in `fixtures/turn-pong.jsonl` — a real transcript captured
 * from Claude Code 2.1.226 — so a test asserting on the reply is asserting
 * against the wire format the CLI really produces, which is the whole point of
 * the fixtures (constitution rule 1).
 */
export const LIVE_REPLY_TEXT = "PONG";

/**
 * A throwaway APNs configuration, in the shape the environment supplies it.
 *
 * A real P-256 key, freshly generated, because `ApnsProviderToken` signs with
 * it for real — `dsaEncoding: "ieee-p1363"` and all. A fake string would fail
 * at the one place the credential handling is worth exercising.
 */
export function apnsEnv(): NodeJS.ProcessEnv {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    SYL_APNS_KEY_ID: "ABCD123456",
    SYL_APNS_TEAM_ID: "TEAM123456",
    SYL_APNS_BUNDLE_ID: "com.jmm.syl",
    SYL_APNS_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

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
  /**
   * A fresh pairing code, issued the way `npm run pair` issues one.
   *
   * Each call supersedes the last, which is the service's own invariant rather
   * than a convenience: a test that wants two live codes is a test asserting
   * something that cannot happen.
   */
  issuePairingCode(): string;
  readonly config: SylConfig;
  readonly deps: ServiceDependencies;
  readonly database: SylDatabase;
  readonly service: RunningService;
  /**
   * The delivery runtime the service built for itself.
   *
   * Not one a test assembled: this is the object `createDeliveryRuntime`
   * returned on the path `main` takes, with its pushes redirected and its timer
   * inert. Drive it with `runtime.runner.tick()`.
   */
  readonly runtime: DeliveryRuntime;
  /**
   * Every line the delivery runtime said out loud.
   *
   * Collected rather than printed so a suite stays readable, and exposed rather
   * than swallowed because "a machine that cannot send says so" is a claim
   * worth asserting — it is the entire operator signal for a wrong `.p8`.
   */
  readonly warnings: readonly string[];
  /**
   * The fake `claude` this service spawns for every turn, or `null` when turns
   * run in process.
   *
   * Its `invocation()` is how a test asserts on what the harness assembled —
   * the argv, and that no API key reached the child.
   */
  readonly claude: FakeClaude | null;
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

/** Where a live service's pushes should go, and when it should look. */
export interface LiveDeliveryOptions {
  /**
   * The fake Apple to push at. Its origin serves both environments.
   *
   * Supplying this is also what configures APNs at all: without it the service
   * boots with no credentials, exactly as a developer machine with no `.p8`
   * does, and holds everything in the outbox.
   */
  readonly apple?: { readonly origin: string };
  /**
   * The clock the delivery loop walks on, when it must differ from the stores'.
   *
   * A timing story freezes the stores — so that what an HTTP write records is
   * deterministic — and moves this one.
   */
  readonly clock?: Clock;
  /** Real timers, for a test that genuinely wants the loop running. */
  readonly timers?: Timers;
  readonly warn?: (line: string) => void;
  /**
   * Swallow a handler's uncaught throw instead of printing it.
   *
   * For the reboot journey, where a tick is deliberately left running against a
   * closed database and its death rattle is the simulation working.
   */
  readonly onError?: (error: unknown, job: unknown) => void;
}

export interface StartLiveServiceOptions {
  /** Reopen an existing store instead of creating one. For restart tests. */
  readonly databasePath?: string;
  /** Skip pairing. `token` is then the empty string. */
  readonly pair?: boolean;
  readonly deviceName?: string;
  /**
   * Freeze the service's clock. Omit for the real one, which is what every
   * test that is not about time should do.
   */
  readonly clock?: Clock;
  readonly delivery?: LiveDeliveryOptions;
  /** Declare the APNs environment, for a suite that is about the assertion. */
  readonly pushEnvironment?: PushEnvironment | null;
  /** Point the certificate health probe at a status file the test writes. */
  readonly certStatusPath?: string;
  /**
   * Install a fake `claude` executable and run turns through it for real.
   *
   * With this, the service drives `runTurn` exactly as production does: a
   * subprocess per turn, argv assembled by the harness, a captured transcript
   * on stdout. {@link answeringClaude} is the usual value; a suite about the
   * failure path passes something that fails, e.g.
   * `{ ignoreStdin: true, exitCode: 1, stderr: "..." }`.
   *
   * **Opt-in, because it costs a node spawn per message.** The default is
   * {@link StartLiveServiceOptions.runner}, in process.
   */
  readonly claude?: FakeClaudeConfig;
  /**
   * What runs a turn, when no fake `claude` is installed.
   *
   * Defaults to {@link silentRunner} — Syl present, thinking about nothing, and
   * saying nothing, which is a real production outcome and the right shape for
   * every suite that is not about her answering. A test that needs a reply
   * without a subprocess supplies its own.
   *
   * Ignored when `claude` is set: the two are alternatives, and a service
   * cannot have its turns run in two places at once.
   */
  readonly runner?: TurnRunner;
  /**
   * Options forwarded to every turn. `claudeBin` is supplied automatically and
   * must not be overridden with the real binary — nothing in the suite may
   * spawn it.
   */
  readonly turn?: Omit<TurnOptions, "claudeBin">;
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
    // Declared, not inferred. `nodeEnv` is `test` here so the assertion would
    // fall back to sandbox anyway; saying it means a suite that *is* about the
    // environment can override this field and see the real branch.
    pushEnvironment: options.pushEnvironment ?? null,
    allowSandboxPush: false,
    // Under the test's own temp directory, so no suite writes into
    // `~/Library/Logs` and no suite can read another's log.
    logDirectory: join(directory ?? tmpdir(), "logs"),
    certStatusPath: options.certStatusPath ?? join(directory ?? tmpdir(), "cert-status.json"),
  };

  // When a fake `claude` is asked for it is a real executable replaying a real
  // capture, and `runTurn` spawns, pipes and waits exactly as it does in anger
  // — see `helpers/fake-claude.ts` for why that is worth a subprocess. What it
  // must never do is find the real CLI: that costs money, needs a login, and is
  // not deterministic. Without one, turns run in process and say nothing.
  const claude: FakeClaude | null =
    options.claude === undefined ? null : makeFakeClaude(options.claude);

  const apple = options.delivery?.apple;
  const warnings: string[] = [];
  const syl = await startSyl(config, {
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(claude === null
      ? { runner: options.runner ?? silentRunner }
      : { turn: { ...options.turn, claudeBin: claude.bin } }),
    // A fixed soul, rather than whichever `SOUL.md` happens to be checked out.
    // The fake ignores it; pinning it keeps the argv a test asserts on stable.
    soul: "You are Syl, under test.",
    delivery: {
      // A test never reaches the real Apple by omission. Credentials are
      // supplied only alongside somewhere local to send them.
      ...(apple === undefined
        ? {}
        : { env: apnsEnv(), origins: { production: apple.origin, sandbox: apple.origin } }),
      // Inert unless a test asks otherwise: the loop is driven by hand, so no
      // suite ever spends a wall-clock second waiting for a tick.
      timers: options.delivery?.timers ?? inertTimers,
      ...(options.delivery?.clock === undefined ? {} : { clock: options.delivery.clock }),
      warn: options.delivery?.warn ?? ((line) => warnings.push(line)),
      ...(options.delivery?.onError === undefined ? {} : { onError: options.delivery.onError }),
    },
  });
  const { database, deps, service, runtime } = syl;

  if (options.clock !== undefined) {
    // Migration 0001 seeds the interactive conversation with SQLite's own
    // `strftime('now')` — the real wall clock. On a frozen clock that row is
    // permanently "in the future" and sorts wrongly. Normalised here, where the
    // non-determinism enters, rather than in every assertion that trips on it.
    const seeded = new Date(options.clock() - 60_000).toISOString();
    database.handle
      .prepare("UPDATE conversations SET created_at = ?, updated_at = ? WHERE updated_at > ?")
      .run(seeded, seeded, seeded);
  }

  const address = service.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the service did not bind a TCP port");
  }
  const { port } = address satisfies AddressInfo;
  const origin = `http://127.0.0.1:${String(port)}`;
  const baseUrl = `${origin}${API_BASE_PATH}`;

  let token = "";

  const api = async (path: string, init: LiveRequest = {}): Promise<Response> => {
    const { idempotencyKey, anonymous, headers, ...rest } = init;
    return fetch(`${baseUrl}${path}`, {
      ...rest,
      headers: {
        "content-type": "application/json",
        ...(anonymous === true || token === "" ? {} : { authorization: `Bearer ${token}` }),
        // A UUID rather than a counter. The counter restarted at zero for every
        // `startLiveService`, so a test that restarts the service against the
        // same database — which is the whole of US5 — re-sent `live-1` with a
        // different body and got `IDEMPOTENCY_KEY_REUSE`. The ledger outlives
        // the process; a key generator that does not is a bug waiting for the
        // day the ledger starts being enforced. That day is today.
        "Idempotency-Key": idempotencyKey ?? randomUUID(),
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
    runtime,
    warnings,
    claude,
    databasePath,
    directory,
    api,
    issuePairingCode: () => deps.keys.issuePairingCode().code,
    close: async (closeOptions = {}) => {
      await syl.close();
      database.close();
      claude?.cleanup();
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
