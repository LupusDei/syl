import type { Device, DevicePage, DevicePlatform, PushEnvironment } from "@syl/shared";

import { instant, systemClock, type Clock } from "./clock.js";
import { newId } from "./id.js";
import { pageOf, resolvePage, type PageOptions } from "./paging.js";
import type { Database } from "./sqlite.js";

/**
 * Registered push targets.
 *
 * Two decisions in here are the difference between push working and push
 * failing silently, and both are recorded in the contract for the same reason.
 *
 * **The environment is a property of the token, not of the server.** An
 * Xcode-installed build always produces a sandbox token; TestFlight and App
 * Store builds always produce production ones. During development both exist
 * at once, so a single server-wide setting is guaranteed to be wrong for one of
 * them — and the only symptom is `BadDeviceToken` on every send to that device.
 * No log line, no exception, no delivery.
 *
 * **The full token never leaves this service except to APNs.** It is a
 * credential for pushing to the Commander's phone. `Device` carries only the
 * last eight characters, which is enough to tell two phones apart in an admin
 * view and useless to anyone else. {@link DeviceTokenService.targets} is the
 * single exit, and it exists for the sender.
 */

/** A token is hex, and Apple's is 64 characters — but has grown before. */
const APNS_TOKEN = /^[0-9a-fA-F]{64,200}$/;

/** How many characters of the token identify a device on the wire. */
const SUFFIX_LENGTH = 8;

const PLATFORMS: readonly DevicePlatform[] = ["ios"];
const ENVIRONMENTS: readonly PushEnvironment[] = ["sandbox", "production"];

/** Thrown when a registration cannot be accepted as asked. */
export class DeviceTokenError extends Error {
  readonly kind: "bad_token" | "bad_environment" | "bad_platform";

  constructor(kind: DeviceTokenError["kind"], message: string) {
    super(message);
    this.name = "DeviceTokenError";
    this.kind = kind;
  }
}

/** What `POST /devices` supplies. */
export interface RegisterDeviceInput {
  readonly token: string;
  readonly environment: string;
  readonly platform: string;
  readonly name: string;
  readonly appVersion: string;
  readonly osVersion: string;
}

/** The result of a registration, and whether it made a new row. */
export interface RegisterDeviceResult {
  readonly device: Device;
  readonly created: boolean;
}

/**
 * A live push target: the credential and the environment it must be sent to,
 * inseparably. Handing these back as one value is what makes per-token routing
 * hard to get wrong at the call site.
 */
export interface PushTarget {
  readonly deviceId: string;
  readonly token: string;
  readonly environment: PushEnvironment;
}

interface DeviceRow {
  readonly id: string;
  readonly platform: DevicePlatform;
  readonly environment: PushEnvironment;
  readonly token: string;
  readonly token_suffix: string;
  readonly name: string;
  readonly app_version: string;
  readonly os_version: string;
  readonly active: number;
  readonly registered_at: string;
  readonly last_seen_at: string;
}

const COLUMNS =
  "id, platform, environment, token, token_suffix, name, app_version, os_version, active, registered_at, last_seen_at";

function toDevice(row: DeviceRow): Device {
  return {
    id: row.id,
    platform: row.platform,
    environment: row.environment,
    tokenSuffix: row.token_suffix,
    name: row.name,
    appVersion: row.app_version,
    osVersion: row.os_version,
    active: row.active === 1,
    registeredAt: row.registered_at,
    lastSeenAt: row.last_seen_at,
  };
}

/**
 * Normalise a token to the form stored and compared.
 *
 * Lowercased, because iOS hands the same token to different call sites in
 * different cases and two rows for one phone means half the reminders go to a
 * device that has been replaced.
 *
 * @throws {DeviceTokenError} if it is not a plausible APNs token.
 */
export function normaliseToken(raw: string): string {
  if (!APNS_TOKEN.test(raw)) {
    throw new DeviceTokenError(
      "bad_token",
      "An APNs device token is 64 to 200 hexadecimal characters.",
    );
  }
  return raw.toLowerCase();
}

export interface DeviceTokenServiceOptions {
  readonly db: Database;
  readonly clock?: Clock;
}

export class DeviceTokenService {
  readonly #db: Database;
  readonly #clock: Clock;

  constructor(options: DeviceTokenServiceOptions) {
    this.#db = options.db;
    this.#clock = options.clock ?? systemClock;
  }

  /**
   * Register a token, or refresh the row that already holds it.
   *
   * Re-registering updates in place rather than inserting: the app registers on
   * every launch, and a second row for the same phone would double every
   * notification and leave a stale environment behind on the older one.
   *
   * A token that had been unregistered comes back active. A `410` means "not
   * right now" — the app was deleted, or the token rotated — and the device
   * telling us about itself again is the strongest possible evidence that it is
   * back.
   */
  register(input: RegisterDeviceInput): RegisterDeviceResult {
    const token = normaliseToken(input.token);
    const environment = ENVIRONMENTS.find((candidate) => candidate === input.environment);
    if (environment === undefined) {
      throw new DeviceTokenError(
        "bad_environment",
        `environment must be one of ${ENVIRONMENTS.join(", ")}.`,
      );
    }
    const platform = PLATFORMS.find((candidate) => candidate === input.platform);
    if (platform === undefined) {
      throw new DeviceTokenError("bad_platform", `platform must be one of ${PLATFORMS.join(", ")}.`);
    }

    const at = instant(this.#clock());
    const existing = this.#byToken(token);

    if (existing !== null) {
      this.#db
        .prepare(
          `UPDATE devices
              SET environment = ?, platform = ?, name = ?, app_version = ?, os_version = ?,
                  active = 1, last_seen_at = ?
            WHERE id = ?`,
        )
        .run(
          environment,
          platform,
          input.name,
          input.appVersion,
          input.osVersion,
          at,
          existing.id,
        );

      const device = this.get(existing.id);
      // The row was read a statement ago inside the same connection; it is here.
      if (device === null) throw new Error("device vanished during registration");
      return { device, created: false };
    }

    const id = newId("device");
    this.#db
      .prepare(`INSERT INTO devices (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
      .run(
        id,
        platform,
        environment,
        token,
        token.slice(-SUFFIX_LENGTH),
        input.name,
        input.appVersion,
        input.osVersion,
        at,
        at,
      );

    return {
      device: {
        id,
        platform,
        environment,
        tokenSuffix: token.slice(-SUFFIX_LENGTH),
        name: input.name,
        appVersion: input.appVersion,
        osVersion: input.osVersion,
        active: true,
        registeredAt: at,
        lastSeenAt: at,
      },
      created: true,
    };
  }

  /** One device by id, or `null`. */
  get(id: string): Device | null {
    const row = this.#db.prepare(`SELECT ${COLUMNS} FROM devices WHERE id = ?`).get(id);
    return row === undefined ? null : toDevice(row as unknown as DeviceRow);
  }

  /** A page of devices, most recently registered first. */
  list(options: PageOptions = {}): DevicePage {
    const { limit, offset } = resolvePage(options);
    const rows = this.#db
      .prepare(
        `SELECT ${COLUMNS} FROM devices
          ORDER BY registered_at DESC, id DESC
          LIMIT ? OFFSET ?`,
      )
      .all(limit + 1, offset);

    return pageOf(
      rows.map((row) => toDevice(row as unknown as DeviceRow)),
      limit,
      offset,
    );
  }

  /**
   * Every live push target, with its environment.
   *
   * The one place a full token leaves this module. Callers push and nothing
   * else; anything that wants to *show* a device uses {@link list}.
   */
  targets(): readonly PushTarget[] {
    const rows = this.#db
      .prepare("SELECT id, token, environment FROM devices WHERE active = 1 ORDER BY registered_at")
      .all();

    return rows.map((row) => {
      // Safe assertion: our own columns, declared NOT NULL on a STRICT table.
      const typed = row as unknown as {
        id: string;
        token: string;
        environment: PushEnvironment;
      };
      return { deviceId: typed.id, token: typed.token, environment: typed.environment };
    });
  }

  /** Mark a device inactive. Rows are closed, never deleted. */
  deactivate(id: string): Device | null {
    if (this.get(id) === null) return null;
    this.#db.prepare("UPDATE devices SET active = 0 WHERE id = ?").run(id);
    return this.get(id);
  }

  /**
   * Unregister by token — the form APNs reports a dead one in.
   *
   * @returns whether a row changed. A token we never had is not an error: the
   * point of this call is that the token is gone, and it being gone twice is
   * the same outcome.
   */
  deactivateByToken(rawToken: string): boolean {
    let token: string;
    try {
      token = normaliseToken(rawToken);
    } catch {
      return false;
    }
    const existing = this.#byToken(token);
    if (existing === null || existing.active === 0) return false;
    this.#db.prepare("UPDATE devices SET active = 0 WHERE id = ?").run(existing.id);
    return true;
  }

  /** Record that we have heard from a device. */
  touch(id: string): void {
    this.#db
      .prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?")
      .run(instant(this.#clock()), id);
  }

  #byToken(token: string): DeviceRow | null {
    const row = this.#db.prepare(`SELECT ${COLUMNS} FROM devices WHERE token = ?`).get(token);
    return row === undefined ? null : (row as unknown as DeviceRow);
  }
}
