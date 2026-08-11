import type { Delivery, DeliveryPayload, Reminder } from "@syl/shared";

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

/**
 * The category a coalesced digest carries. Deliberately **not** actionable.
 *
 * `syl-xvx`. A digest used to arrive under `REMINDER_CATEGORY`, so it showed
 * Complete and Snooze — and both actions on the device open with
 * `guard let reminderId = payload.reminderId else { return }`, which a digest
 * is exactly the row that cannot satisfy: it speaks for several reminders and
 * therefore names none of them. He tapped Snooze on a night's work, nothing
 * deferred, and the acknowledgement that fires alongside closed all of them as
 * seen. A reminder he explicitly asked to be given again, silently discarded.
 *
 * The device registers one category, so an identifier it does not know arrives
 * with no buttons at all and opens the app. That is the honest shape: a
 * notification standing for four things is not a thing one button can act on,
 * and offering a button that cannot work is worse than offering none.
 */
const DIGEST_CATEGORY = "reminder_digest";

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
    // And deliberately not actionable. See `DIGEST_CATEGORY`.
    categoryIdentifier: DIGEST_CATEGORY,
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
    const outcome = holdUntilRelease(deps, release, group);
    enqueued.push(...outcome.enqueued);
    fired.push(...outcome.fired);
    coalesced += outcome.coalesced;
  }

  return { enqueued, fired, superseded, coalesced };
}

/**
 * Put a group of held reminders into the batch for their release instant.
 *
 * **The batch spans passes, not one pass.** `held` above is rebuilt on every
 * call and the runner wakes at least every sixty seconds, so reminders spread
 * across a night arrive here a few at a time — which is the only shape that
 * happens in production. Grouping only within a pass gave every reminder a
 * group of one, and ten overnight reminders then became ten rows all released
 * at 08:00: ten notifications in one second, verbatim the burst the module
 * docstring says this exists to prevent.
 *
 * So the row for a release instant is amended as the night goes on. Every
 * reminder marked fired must be named by some row before this returns —
 * `markFired` is what stops it firing again, so a reminder marked fired and
 * named by nothing is gone, and nothing records that it was ever dropped.
 */
function holdUntilRelease(
  deps: DeliverRemindersDeps,
  release: string,
  group: readonly Reminder[],
): { enqueued: string[]; fired: string[]; coalesced: number } {
  const { reminders, outbox } = deps;
  // Derived from the release instant, so every pass over one window addresses
  // the same row rather than writing a second digest.
  const key = `reminder-batch:${release}`;
  const existing = outbox.byIdempotencyKey(key);
  if (existing !== null) return foldInto(deps, existing, release, group);

  const only = group.length === 1 ? group[0] : undefined;

  // One held reminder is not a batch: it keeps its own words. It is still
  // written under the window's key, so the next pass of the night can fold
  // into it rather than making a second notification out of it.
  const { delivery, created } = outbox.enqueue({
    channel: "apns",
    messageClass: "reminder_delivery",
    reminderId: only?.id ?? null,
    payload:
      only === undefined
        ? coalescedPayload(group.length)
        : payloadFor(only, reminders.skippedCount(only.id)),
    idempotencyKey: key,
    late: true,
    scheduledFor: earliest(group),
    coalescedReminderIds: only === undefined ? group.map((reminder) => reminder.id) : [],
    notBefore: release,
  });

  // Somebody wrote this key between the read and the insert. `created` is the
  // answer to "does that row name my reminders", and assuming it does is
  // precisely how they were lost before.
  if (!created) return foldInto(deps, delivery, release, group);

  for (const reminder of group) reminders.markFired(reminder.id, { late: true });
  return {
    enqueued: [delivery.id],
    fired: group.map((reminder) => reminder.id),
    coalesced: only === undefined ? group.length : 0,
  };
}

/** Fold a group into the batch row that already exists for its window. */
function foldInto(
  deps: DeliverRemindersDeps,
  existing: Delivery,
  release: string,
  group: readonly Reminder[],
): { enqueued: string[]; fired: string[]; coalesced: number } {
  const { reminders, outbox } = deps;
  const everyone = group.map((reminder) => reminder.id);

  const covered = new Set(namedBy(existing));
  const additions = group.filter((reminder) => !covered.has(reminder.id));
  if (additions.length === 0) {
    // Every one of them is already named by the row. This is a pass that died
    // between writing the batch and marking them fired; finish the job.
    for (const reminder of group) reminders.markFired(reminder.id, { late: true });
    return { enqueued: [], fired: everyone, coalesced: 0 };
  }

  const ids = [...covered, ...additions.map((reminder) => reminder.id)];
  const amended = outbox.amendHeld(existing.id, {
    payload: coalescedPayload(ids.length),
    // The digest speaks for all of them now, so it speaks for none of them in
    // particular. The ack path reads both fields and closes every id it finds.
    reminderId: null,
    coalescedReminderIds: ids,
    scheduledFor: earlierOf(existing.scheduledFor, earliest(additions)),
  });

  if (amended === null) {
    // The batch has already gone out, or is going out now. Folding into it
    // would put these reminders inside a notification nobody will see again,
    // so they get their own rows: a burst is a nuisance, a drop is not.
    const enqueued = additions.map((reminder) =>
      enqueueOne(deps, reminder, { late: true, notBefore: release }),
    );
    // The ones already named by the sent row are handed over by it.
    for (const reminder of group) {
      if (!covered.has(reminder.id)) continue;
      reminders.markFired(reminder.id, { late: true });
    }
    return { enqueued, fired: everyone, coalesced: 0 };
  }

  // The whole group, not only the additions: a reminder already named by the
  // row but not yet marked is a pass that died halfway, and leaving it unmarked
  // means it comes back every pass until one happens to find nothing new.
  for (const reminder of group) reminders.markFired(reminder.id, { late: true });
  return { enqueued: [amended.id], fired: everyone, coalesced: additions.length };
}

/** Every reminder a delivery row stands for. Matches the ack path exactly. */
function namedBy(delivery: Delivery): readonly string[] {
  return delivery.reminderId === null
    ? delivery.coalescedReminderIds
    : [delivery.reminderId, ...delivery.coalescedReminderIds];
}

function earlierOf(left: string | null, right: string): string {
  return left === null || right < left ? right : left;
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
    // Null means "let the gate decide", which is what the outbox now does with
    // it. This used to have to spread the field away to avoid writing a row
    // that could never come due.
    notBefore: options.notBefore,
  });

  reminders.markFired(reminder.id, { late: options.late });
  return delivery.id;
}

function earliest(group: readonly Reminder[]): string {
  return group
    .map((reminder) => reminder.scheduledFor)
    .reduce((lowest, candidate) => (candidate < lowest ? candidate : lowest));
}
