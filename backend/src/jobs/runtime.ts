import type { Job, JobKind, PushEnvironment } from "@syl/shared";

import { ApnsClient, apnsCredentialsFromEnv } from "../services/apns-service.js";
import { instant, systemClock, type Clock } from "../services/clock.js";
import type { DeviceTokenService } from "../services/device-token-service.js";
import { JobRunner, type JobHandler, type Timers } from "../services/job-runner.js";
import type { JobStore } from "../services/job-store.js";
import type { Outbox } from "../services/outbox.js";
import type { ReminderService } from "../services/reminder-service.js";
import { createReminderDeliveryHandler, defineReminderDeliveryJob } from "./reminder-delivery-job.js";

/**
 * The delivery runtime: the pieces that make a reminder actually arrive,
 * assembled once at boot.
 *
 * Separated from `createApp` because they fail differently. The HTTP surface
 * is up or it is not; the runtime is a loop that must survive everything —
 * Apple being down, the tunnel dropping, the machine sleeping — and keep the
 * outbox moving. Nothing here is required for the service to answer requests,
 * which is why an unconfigured APNs key degrades to "rows accumulate in the
 * outbox" rather than to a service that will not start.
 */

export interface DeliveryRuntimeDeps {
  readonly jobs: JobStore;
  readonly reminders: ReminderService;
  readonly outbox: Outbox;
  readonly devices: DeviceTokenService;
  /**
   * Handlers for the other kinds in the catalogue.
   *
   * One runner, not one per kind: `JobRunner` enforces concurrency of one
   * across everything, which is the whole point on subscription rails where a
   * single rate-limit pool is shared with the Commander's own work. A second
   * runner would break that, and would also lease jobs whose kind it cannot
   * handle and record them as failures.
   *
   * `reminder_delivery` is built here and cannot be overridden — the never-drop
   * guarantee is not a thing a caller gets to replace.
   */
  readonly handlers?: ReadonlyMap<JobKind, JobHandler>;
  readonly env?: NodeJS.ProcessEnv;
  readonly clock?: Clock;
  readonly timers?: Timers;
  /**
   * Where each environment's pushes go. Omit for Apple.
   *
   * `syl-md5`: without this, there was no way for any test to obtain a runtime
   * from *this function* — the one `main` calls — whose pushes went anywhere
   * but `api.push.apple.com`. So five journeys rebuilt the runner by hand out
   * of the pieces this function uses, which is precisely the shape of test that
   * cannot see a defect living in the assembly it skipped.
   */
  readonly origins?: Readonly<Record<PushEnvironment, string>>;
  /** Where the line about a machine that cannot send goes. Default stderr. */
  readonly warn?: (line: string) => void;
  /** Where a handler's uncaught throw is reported. Default stderr. */
  readonly onError?: (error: unknown, job: Job | null) => void;
}

export interface DeliveryRuntime {
  readonly runner: JobRunner;
  /** `null` when APNs is not configured on this machine. */
  readonly apns: ApnsClient | null;
  /** The reminder-delivery job row, created on first boot. */
  readonly job: Job;
  /** Whether push can actually leave this machine. */
  readonly pushEnabled: boolean;
  stop(): Promise<void>;
}

/**
 * Find the reminder-delivery job, or create it.
 *
 * Exactly one exists, forever. It is not defined per boot, because its
 * `nextRunAt` is state — the instant the last pass decided it next needed to
 * wake — and redefining it on every start would throw that away along with its
 * circuit breaker.
 */
export function ensureReminderDeliveryJob(jobs: JobStore, now: number): Job {
  const existing = jobs.list({ kind: "reminder_delivery", limit: 1 }).items[0];
  if (existing !== undefined) return existing;
  return defineReminderDeliveryJob(jobs, instant(now));
}

/** Assemble the runtime. Does not start it. */
export function createDeliveryRuntime(deps: DeliveryRuntimeDeps): DeliveryRuntime {
  const clock = deps.clock ?? systemClock;
  const credentials = apnsCredentialsFromEnv(deps.env ?? process.env);
  const apns =
    credentials === null
      ? null
      : new ApnsClient({
          credentials,
          clock,
          ...(deps.origins === undefined ? {} : { origins: deps.origins }),
        });

  const job = ensureReminderDeliveryJob(deps.jobs, clock());

  const handler: JobHandler = createReminderDeliveryHandler({
    reminders: deps.reminders,
    outbox: deps.outbox,
    devices: deps.devices,
    apns,
    ...(deps.warn === undefined ? {} : { warn: deps.warn }),
  });

  const runner = new JobRunner({
    store: deps.jobs,
    // Reminder delivery last, so it cannot be displaced by a caller's map.
    handlers: new Map<JobKind, JobHandler>([
      ...(deps.handlers ?? new Map<JobKind, JobHandler>()),
      ["reminder_delivery", handler],
    ]),
    clock,
    ...(deps.timers === undefined ? {} : { timers: deps.timers }),
    ...(deps.onError === undefined ? {} : { onError: deps.onError }),
  });

  return {
    runner,
    apns,
    job,
    pushEnabled: apns !== null,
    stop: async () => {
      runner.stop();
      await apns?.close();
    },
  };
}

/** The lines to print about the delivery runtime once it is up. */
export function describeRuntime(runtime: DeliveryRuntime): readonly string[] {
  if (runtime.pushEnabled) {
    return [`[syl] delivery runtime up; next wake ${runtime.job.nextRunAt ?? "unscheduled"}`];
  }
  return [
    "[syl] delivery runtime up, but APNs is NOT configured " +
      "(SYL_APNS_KEY_ID, SYL_APNS_TEAM_ID, SYL_APNS_BUNDLE_ID, SYL_APNS_PRIVATE_KEY). " +
      "Reminders will be written to the outbox and held there, not pushed.",
  ];
}
