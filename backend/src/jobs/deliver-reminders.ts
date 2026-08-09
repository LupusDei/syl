import type { DeliveryPayload, Reminder } from "@syl/shared";

import type { Outbox } from "../services/outbox.js";
import type { ReminderService } from "../services/reminder-service.js";

/**
 * The zero-turn delivery job.
 *
 * **Nothing in this file may invoke the model.** Read the due row, write the
 * outbox row. No subprocess, no tool call, no rate limit, and no possibility
 * of a model deciding not to act. That is what makes the never-drop guarantee
 * independent of everything else in the system — and it is only possible
 * because the reminder text was composed at *creation* time, in Syl's voice,
 * so nothing downstream needs to think in order to know what to say.
 *
 * Three judgements live here, and each is the answer to a specific way the
 * naive version goes wrong.
 *
 * **Lateness is declared, not hidden.** A reminder that fired after its
 * instant says so. That single admission is what converts the weakest moment
 * in the system into evidence that it is honest.
 *
 * **A rhythm message supersedes; a commitment never does.** Yesterday's
 * morning agenda has no business arriving today. But the skip is counted
 * rather than discarded, so the next one can say what it missed — a
 * suppression nobody is told about is exactly the silence this design exists
 * to prevent.
 *
 * **A batch held by quiet hours becomes one notification, not ten.**
 * `deferPastQuietHours` collapses everything in the window onto the same
 * instant, so ten overnight reminders would otherwise arrive as ten
 * notifications in one second — correct by the letter of the guarantee and
 * awful in practice. Staggering them would be worse: ten notifications spread
 * over twenty minutes. One notification, detail in the app.
 */

/** Fired more than this after its instant, and a reminder says it is late. */
export const LATE_THRESHOLD_MS = 60_000;

/**
 * How late a rhythm message may be and still be worth saying.
 *
 * Three hours: a morning agenda that arrives at 10:00 is still a morning
 * agenda. One that arrives at 16:00 is an interruption about a morning that
 * has already happened.
 */
export const RHYTHM_GRACE_MS = 3 * 60 * 60_000;

/** APNs thread that groups reminder notifications on the device. */
const REMINDER_THREAD = "reminders";

/** The notification category carrying Complete and Snooze actions. */
const REMINDER_CATEGORY = "reminder";

const SMALL_NUMBERS: readonly string[] = [
  "No",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
];

/** Spell a small count, because "3 things" reads like a machine wrote it. */
export function countWord(count: number): string {
  return SMALL_NUMBERS[count] ?? String(count);
}

export interface DeliverRemindersDeps {
  readonly reminders: ReminderService;
  readonly outbox: Outbox;
}

/** What one pass of the job did. */
export interface DeliverRemindersResult {
  /** Outbox rows written. */
  readonly enqueued: readonly string[];
  /** Reminders whose occurrence was handed over. */
  readonly fired: readonly string[];
  /** Rhythm occurrences rolled forward without speaking. */
  readonly superseded: readonly string[];
  /** How many reminders went into coalesced notifications. */
  readonly coalesced: number;
}

/**
 * The body of a notification for one reminder.
 *
 * Self-sufficient by design: the text itself travels, never an id to fetch.
 * Push reaches the phone over Apple's network, which does not touch the
 * tailnet, so a notification whose body is an id is unreadable exactly when
 * the tunnel is down — one of the times it matters most.
 */
export function payloadFor(reminder: Reminder, skipped: number): DeliveryPayload {
  // The suppression is reported, not hidden. A rhythm message that quietly
  // skipped four mornings and then behaved as though nothing happened is
  // exactly the silence this design is built against.
  const skippedNote =
    skipped > 0 ? ` (${countWord(skipped)} went unsaid while I was away.)` : "";

  return {
    title: "Syl",
    body: `${reminder.text}${skippedNote}`,
    // A commitment breaks through Focus and the Scheduled Summary: it is a
    // thing he undertook to do at a time, and a reminder that waits for the
    // next Scheduled Summary is not a reminder. A rhythm message is ordinary
    // unless it was marked urgent.
    interruptionLevel:
      reminder.kind === "commitment" || reminder.urgent ? "time-sensitive" : "active",
    categoryIdentifier: REMINDER_CATEGORY,
    threadIdentifier: REMINDER_THREAD,
  };
}

/** The body of the single notification standing in for a held batch. */
export function coalescedPayload(count: number): DeliveryPayload {
  return {
    title: "Syl",
    body: `${countWord(count)} things came in overnight. They're in the app when you're ready.`,
    // Deliberately not time-sensitive. Breaking through Focus to say "several
    // things happened while you were asleep" is the noise this exists to stop.
    interruptionLevel: "active",
    categoryIdentifier: REMINDER_CATEGORY,
    threadIdentifier: REMINDER_THREAD,
  };
}

/**
 * Move every due reminder into the outbox.
 *
 * Synchronous and pure of I/O beyond the two stores, so it can be called from
 * a timer tick, from a recovery pass, or from a test, and produce the same
 * result. Idempotent by construction: the outbox key is derived from the
 * occurrence, so running twice writes one row.
 */
export function deliverDueReminders(
  deps: DeliverRemindersDeps,
  now: number,
): DeliverRemindersResult {
  const { reminders, outbox } = deps;

  const enqueued: string[] = [];
  const fired: string[] = [];
  const superseded: string[] = [];
  const held = new Map<string, Reminder[]>();

  for (const reminder of reminders.due(now)) {
    const fireAt = Date.parse(reminder.nextFireAt);
    const lateBy = now - fireAt;

    if (reminder.kind === "rhythm" && lateBy > RHYTHM_GRACE_MS && reminder.rrule !== null) {
      reminders.supersede(reminder.id);
      superseded.push(reminder.id);
      continue;
    }

    const release = outbox.releaseAt(now, reminder.urgent);
    if (Date.parse(release) > now) {
      const group = held.get(release) ?? [];
      group.push(reminder);
      held.set(release, group);
      continue;
    }

    const delivery = enqueueOne(deps, reminder, {
      late: lateBy > LATE_THRESHOLD_MS,
      notBefore: null,
    });
    enqueued.push(delivery);
    fired.push(reminder.id);
  }

  let coalesced = 0;
  for (const [release, group] of held) {
    if (group.length === 1) {
      const only = group[0];
      if (only === undefined) continue;
      // One held reminder is not a batch. It keeps its own words.
      enqueued.push(enqueueOne(deps, only, { late: true, notBefore: release }));
      fired.push(only.id);
      continue;
    }

    const ids = group.map((reminder) => reminder.id);
    const { delivery } = outbox.enqueue({
      channel: "apns",
      messageClass: "reminder_delivery",
      reminderId: null,
      payload: coalescedPayload(group.length),
      // Derived from the release instant, so a second pass over the same
      // window joins the existing row instead of writing a second digest.
      idempotencyKey: `reminder-batch:${release}`,
      late: true,
      scheduledFor: earliest(group),
      coalescedReminderIds: ids,
      notBefore: release,
    });

    enqueued.push(delivery.id);
    coalesced += group.length;
    for (const reminder of group) {
      reminders.markFired(reminder.id, { late: true });
      fired.push(reminder.id);
    }
  }

  return { enqueued, fired, superseded, coalesced };
}

function enqueueOne(
  deps: DeliverRemindersDeps,
  reminder: Reminder,
  options: { readonly late: boolean; readonly notBefore: string | null },
): string {
  const { reminders, outbox } = deps;

  const { delivery } = outbox.enqueue({
    channel: "apns",
    messageClass: "reminder_delivery",
    reminderId: reminder.id,
    payload: payloadFor(reminder, reminders.skippedCount(reminder.id)),
    // Derived from the occurrence, never from the clock: that is what makes a
    // second pass — a retry, a recovery after a reboot, two ticks racing —
    // write one row rather than two notifications.
    idempotencyKey: `reminder:${reminder.id}:${reminder.nextFireAt}`,
    late: options.late,
    scheduledFor: reminder.scheduledFor,
    urgent: reminder.urgent,
    ...(options.notBefore === null ? {} : { notBefore: options.notBefore }),
  });

  reminders.markFired(reminder.id, { late: options.late });
  return delivery.id;
}

function earliest(group: readonly Reminder[]): string {
  return group
    .map((reminder) => reminder.scheduledFor)
    .reduce((lowest, candidate) => (candidate < lowest ? candidate : lowest));
}
