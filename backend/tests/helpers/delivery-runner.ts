import { generateKeyPairSync } from "node:crypto";

import { createReminderDeliveryHandler } from "../../src/jobs/reminder-delivery-job.js";
import { ensureReminderDeliveryJob } from "../../src/jobs/runtime.js";
import { ApnsClient } from "../../src/services/apns-service.js";
import type { Clock } from "../../src/services/clock.js";
import { JobRunner, type Timers } from "../../src/services/job-runner.js";
import type { FakeApns } from "./fake-apns.js";
import type { LiveService } from "./live-service.js";

/**
 * The delivery runner, pointed at a stand-in Apple.
 *
 * **This helper is a workaround, and it should not exist.** `syl-md5`:
 * `createDeliveryRuntime` constructs `new ApnsClient({ credentials, clock })`
 * and forwards no `origins`, and `ApnsClient` falls back to `APNS_ORIGINS` — a
 * module constant with no environment override. So there is no way to obtain a
 * runtime from the function `main` actually calls whose pushes go anywhere but
 * `api.push.apple.com`.
 *
 * Every test that needs a reminder to reach a fake Apple therefore rebuilds the
 * runner out of the same two exported pieces the runtime uses. That was five
 * separate copies of these forty lines before this file existed. Consolidating
 * them is the lesser evil; **deleting this file** by giving
 * `createDeliveryRuntime` an origins seam is the actual fix, and when that
 * lands every caller here should move to it.
 *
 * What this does share with production is everything that matters other than
 * the destination: the same handler factory, the same `ensureReminderDeliveryJob`
 * call, and the live service's own stores.
 */

/** A timer the test drives by hand, so no wall-clock second is ever spent. */
export const inertTimers: Timers = { set: () => 0, clear: () => undefined };

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

/** A runner and the sender behind it, both stoppable. */
export interface DeliveryRig {
  readonly runner: JobRunner;
  close(): Promise<void>;
}

export interface DeliveryRigOptions {
  readonly syl: LiveService;
  readonly apple: FakeApns;
  /** The same clock the service was started on. */
  readonly clock: Clock;
  /** Identifies this rig's job leases. */
  readonly owner: string;
  /**
   * Swallow a handler throw instead of printing it.
   *
   * For the reboot journey, where a tick is deliberately left running against a
   * closed database and its death rattle is expected rather than interesting.
   */
  readonly silent?: boolean;
}

/** Build the delivery runner over a live service's stores, sending to `apple`. */
export function deliveryRig(options: DeliveryRigOptions): DeliveryRig {
  const { syl, apple, clock, owner } = options;
  const env = apnsEnv();

  // The exact call `createDeliveryRuntime` makes at boot: find the job, or
  // create it. Not `define`, which inserts unconditionally and would hand a
  // restarted service a second delivery job.
  ensureReminderDeliveryJob(syl.deps.jobs, clock());

  const apns = new ApnsClient({
    credentials: {
      keyId: env["SYL_APNS_KEY_ID"] ?? "",
      teamId: env["SYL_APNS_TEAM_ID"] ?? "",
      bundleId: env["SYL_APNS_BUNDLE_ID"] ?? "",
      privateKeyPem: env["SYL_APNS_PRIVATE_KEY"] ?? "",
    },
    origins: { production: apple.origin, sandbox: apple.origin },
    clock,
  });

  const runner = new JobRunner({
    store: syl.deps.jobs,
    handlers: new Map([
      [
        "reminder_delivery",
        createReminderDeliveryHandler({
          reminders: syl.deps.reminders,
          outbox: syl.deps.outbox,
          devices: syl.deps.devices,
          apns,
        }),
      ],
    ]),
    clock,
    timers: inertTimers,
    owner,
    ...(options.silent === true ? { onError: (): undefined => undefined } : {}),
  });

  return {
    runner,
    close: async () => {
      runner.stop();
      await apns.close();
    },
  };
}
