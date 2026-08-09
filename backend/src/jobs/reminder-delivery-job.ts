import type { Job } from "@syl/shared";

import { instant, parseInstant } from "../services/clock.js";
import type { DeviceTokenService } from "../services/device-token-service.js";
import type { JobHandler, JobResult } from "../services/job-runner.js";
import type { JobStore } from "../services/job-store.js";
import type { Outbox } from "../services/outbox.js";
import type { ReminderService } from "../services/reminder-service.js";
import { deliverDueReminders } from "./deliver-reminders.js";
import { pushDueDeliveries, type ApnsSender } from "./push-outbox.js";

/**
 * The catalogue entry that makes reminders arrive.
 *
 * **`maxTurns: 0` is the strongest statement in the job catalogue.** A job that
 * cannot spawn a turn cannot be delayed by a rate limit, cannot be broken by a
 * model declining to call a tool, and cannot cost anything. Everything else in
 * the catalogue may use the model; this one is forbidden from it, which is why
 * it is the one carrying a hard guarantee.
 *
 * The job schedules *itself*. What it needs is `min(next reminder, next outbox
 * attempt, one minute)` — no trigger expression can express that, and a fixed
 * interval would either poll pointlessly or fire a reminder late by however
 * coarse the interval is. The one-minute ceiling is the same self-healing
 * property the runner's own timer has: however wrong the last answer was, the
 * next pass recomputes from the clock.
 */

/** How long the job waits when nothing at all is pending. */
export const IDLE_POLL_MS = 60_000;

/** The trigger this job carries. It reschedules itself after every pass. */
export function defineReminderDeliveryJob(store: JobStore, firstRunAt?: string): Job {
  return store.define({
    kind: "reminder_delivery",
    // Below interactive, above everything scheduled. A reminder waits for the
    // Commander's own request and for nothing else.
    priority: "reminder",
    trigger: { type: "event", event: "reminder.due" },
    deliveryClass: "at_least_once",
    // A reminder fires however late and is marked late. It never expires,
    // because a vanished one destroys trust in a way a late one does not.
    catchUp: { policy: "never_expires" },
    budget: { maxTurns: 0, maxWallClockMs: 5_000, allowedTools: [] },
    speaks: true,
    ...(firstRunAt === undefined ? {} : { nextRunAt: firstRunAt }),
  });
}

export interface ReminderDeliveryDeps {
  readonly reminders: ReminderService;
  readonly outbox: Outbox;
  readonly devices: DeviceTokenService;
  /** `null` when APNs is not configured. The outbox holds rows regardless. */
  readonly apns: ApnsSender | null;
}

/**
 * The handler: read the due rows, write the outbox rows, push.
 *
 * No subprocess anywhere in this function or anything it calls. That is the
 * property the whole feature rests on, and it is asserted end to end in
 * `tests/integration/reminder-delivery.test.ts` by failing the run if anything
 * spawns a child process.
 */
export function createReminderDeliveryHandler(deps: ReminderDeliveryDeps): JobHandler {
  return async (context): Promise<JobResult> => {
    deliverDueReminders({ reminders: deps.reminders, outbox: deps.outbox }, context.now);
    const pushed = await pushDueDeliveries(
      { outbox: deps.outbox, devices: deps.devices, apns: deps.apns },
      context.now,
    );

    const waiting = pushed.failed.length;
    return {
      outcome: "success",
      spoke: pushed.accepted.length > 0,
      // Zero, always. If this is ever non-zero, a model got into the delivery
      // path and the guarantee is no longer independent of rate limits.
      turns: 0,
      costUsd: 0,
      // The contract's `summary` is the model's own one line about what it
      // did. There is no model here, so there is nothing to say.
      summary: null,
      // A failed attempt is not a failed run: the row survives and is retried,
      // which is the entire reason the outbox exists.
      error:
        waiting === 0
          ? null
          : `${waiting} notification${waiting === 1 ? "" : "s"} could not be sent and will be retried.`,
      nextRunAt: nextWakeFor(deps, context.now),
    };
  };
}

/**
 * The earliest of: the next reminder, the next outbox attempt, and a minute.
 *
 * A minute is a ceiling rather than a poll interval — everything real is
 * scheduled precisely, and the ceiling is what makes a missed wake-up
 * self-correct instead of stranding the queue.
 */
export function nextWakeFor(
  deps: Pick<ReminderDeliveryDeps, "reminders" | "outbox">,
  now: number,
): string {
  const candidates = [deps.reminders.nextDueAt(), deps.outbox.nextDueAt()]
    .filter((value): value is string => value !== null)
    .map((value) => parseInstant(value))
    .filter((value): value is number => value !== null);

  const soonest = candidates.length === 0 ? Infinity : Math.min(...candidates);
  return instant(Math.min(soonest, now + IDLE_POLL_MS));
}
