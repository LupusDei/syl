import type { Job } from "@syl/shared";

import { instant, parseInstant } from "../services/clock.js";
import type { DeviceTokenService } from "../services/device-token-service.js";
import type { JobHandler, JobResult } from "../services/job-runner.js";
import type { JobStore } from "../services/job-store.js";
import type { Outbox } from "../services/outbox.js";
import type { AlertSink } from "../services/presence.js";
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

/** The four values a human types once, named in the order they are typed. */
const APNS_ENV_NAMES =
  "SYL_APNS_KEY_ID, SYL_APNS_TEAM_ID, SYL_APNS_BUNDLE_ID, SYL_APNS_PRIVATE_KEY";

export interface ReminderDeliveryDeps {
  readonly reminders: ReminderService;
  readonly outbox: Outbox;
  readonly devices: DeviceTokenService;
  /** `null` when APNs is not configured. The outbox holds rows regardless. */
  readonly apns: ApnsSender | null;
  /**
   * Syl's character, told when something actually broke through.
   *
   * Optional: a delivery runtime with no socket in front of it is still a
   * delivery runtime, and the never-drop guarantee may not come to depend on
   * anything as decorative as a character. See {@link brokeThrough} for what
   * "actually" means here, and `services/presence.ts` for why `alert` is
   * rationed rather than emitted per notification.
   */
  readonly presence?: AlertSink;
  /**
   * Where the one line about a machine that cannot send goes.
   *
   * Injected so a test can read it, and defaulted to stderr because the
   * alternative — the state Syl shipped in — is that a wrong `.p8` produces no
   * output anywhere at all while every reminder quietly piles up.
   */
  readonly warn?: (line: string) => void;
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
  const warn = deps.warn ?? ((line: string): void => console.error(line));
  /**
   * The block already reported, so a machine that cannot send says so once and
   * not sixty times an hour forever.
   *
   * Held in the closure rather than at module scope: two runtimes in one
   * process — which is every test file that builds more than one — must not
   * silence each other.
   */
  let announcedBlock: string | null = null;

  return async (context): Promise<JobResult> => {
    deliverDueReminders({ reminders: deps.reminders, outbox: deps.outbox }, context.now);
    const pushed = await pushDueDeliveries(
      { outbox: deps.outbox, devices: deps.devices, apns: deps.apns },
      context.now,
    );

    // `syl-8l7`. The one thing in the delivery path the character hears about,
    // and the third of presence's three seams.
    //
    // Wrapped, because the guarantee outranks the character in both
    // directions: a throw out of this handler is what opens the job's circuit
    // breaker, so a sink that fails here would end every FUTURE reminder on
    // top of this one. A silent character is a degraded Syl; a stopped
    // delivery loop is a broken promise.
    try {
      if (brokeThrough(deps.outbox, pushed.accepted)) deps.presence?.alerted();
    } catch (error) {
      warn(`[syl] the delivery could not be announced to presence: ${String(error)}`);
    }

    const held = pushed.blocked.length;
    const waiting = pushed.failed.length;
    const lost = pushed.exhausted.length;

    // `syl-clc`, second half. A machine that cannot send used to be completely
    // silent: the rows were dropped, the handler reported success, and no
    // breaker, log line or run record said anything. The row is now held rather
    // than dropped, which means the *only* thing standing between a wrong `.p8`
    // and a week of undelivered reminders is somebody being told.
    //
    // Keyed on the *cause*, not on the count and not on the pass. A pass that
    // found nothing due is not evidence that anything was fixed — most passes
    // find nothing — so silence never clears the block. Only something actually
    // reaching Apple does.
    const cause = held === 0 ? null : (deps.outbox.get(pushed.blocked[0] ?? "")?.lastError ?? null);
    const blockage = cause === null ? null : blockedLine(held, cause);
    if (cause !== null && cause !== announcedBlock) {
      warn(`[syl] ${blockage ?? cause}`);
      announcedBlock = cause;
    } else if (announcedBlock !== null && pushed.accepted.length > 0) {
      warn("[syl] delivery is unblocked; the backlog is going out.");
      announcedBlock = null;
    }

    return {
      // A refused attempt is not a failed run — the row survives and is
      // retried, which is the entire reason the outbox exists — and neither is
      // a blocked one, or a wrong key id would open the breaker and end every
      // *future* reminder on top of the one already waiting.
      //
      // A row the outbox has stopped retrying is different in kind. Nothing
      // further will happen to it on its own, so this is the one case where
      // the run must be recorded as a failure and the breaker allowed to move.
      outcome: lost === 0 ? "success" : "failure",
      spoke: pushed.accepted.length > 0,
      // Zero, always. If this is ever non-zero, a model got into the delivery
      // path and the guarantee is no longer independent of rate limits.
      turns: 0,
      costUsd: 0,
      // The contract's `summary` is the model's own one line about what it
      // did. There is no model here, so there is nothing to say.
      summary: null,
      error: errorLine({ blockage, waiting, lost }),
      nextRunAt: nextWakeFor(deps, context.now),
    };
  };
}

/**
 * Did this pass actually interrupt him?
 *
 * Two conditions, and both are load-bearing.
 *
 * **Apple took it.** A row that was written, held, deferred or refused
 * interrupted nobody, and a character that flared for one would be asserting
 * something that never happened — the derived-state rule, applied to the one
 * fact this file owns.
 *
 * **It was `time-sensitive`.** That is the interruption level that breaks
 * through Focus and the Scheduled Summary, and coupling `alert` to it is what
 * rations the state: if a notification was not worth interrupting his evening
 * for, it is not worth interrupting his screen for either. A rhythm message
 * and an overnight digest are both deliberately `active`, so neither moves
 * her.
 *
 * One announcement per pass, not one per row: several reminders coming due
 * together are one moment of being interrupted.
 */
function brokeThrough(outbox: Outbox, accepted: readonly string[]): boolean {
  return accepted.some(
    (id) => outbox.get(id)?.payload.interruptionLevel === "time-sensitive",
  );
}

/** What to say about rows nothing could be attempted for. */
function blockedLine(held: number, because: string): string {
  return (
    `${held} reminder${held === 1 ? " is" : "s are"} held and undelivered: ${because} ` +
    `Nothing is lost and nothing will be sent until this is fixed — check ${APNS_ENV_NAMES}.`
  );
}

/** The run record's one line, in decreasing order of how bad it is. */
function errorLine(input: {
  readonly blockage: string | null;
  readonly waiting: number;
  readonly lost: number;
}): string | null {
  const parts: string[] = [];
  if (input.lost > 0) {
    parts.push(
      `${input.lost} notification${input.lost === 1 ? "" : "s"} will not be retried again.`,
    );
  }
  if (input.blockage !== null) parts.push(input.blockage);
  if (input.waiting > 0) {
    parts.push(
      `${input.waiting} notification${input.waiting === 1 ? "" : "s"} could not be sent and will be retried.`,
    );
  }
  return parts.length === 0 ? null : parts.join(" ");
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
