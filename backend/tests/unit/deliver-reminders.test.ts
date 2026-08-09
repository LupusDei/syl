import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  LATE_THRESHOLD_MS,
  RHYTHM_GRACE_MS,
  coalescedPayload,
  countWord,
  deliverDueReminders,
  payloadFor,
} from "../../src/jobs/deliver-reminders.js";
import type { SylDatabase } from "../../src/services/database.js";
import { Outbox } from "../../src/services/outbox.js";
import { ReminderService, type CreateReminderInput } from "../../src/services/reminder-service.js";
import { testDatabase } from "../helpers/service.js";

const CHICAGO = "America/Chicago";
const QUIET = { quiet: { start: "22:00", end: "08:00" }, tz: CHICAGO };

/** 2026-08-09T12:00Z — 07:00 in Chicago. */
const MORNING = Date.UTC(2026, 7, 9, 12, 0, 0, 0);
/** 2026-08-09T04:00Z — 23:00 in Chicago on the 8th, inside quiet hours. */
const NIGHT = Date.UTC(2026, 7, 9, 4, 0, 0, 0);
/** 22:00 Chicago on the 8th: the window closes. */
const NIGHT_STARTS = Date.UTC(2026, 7, 9, 3, 0, 0, 0);
/** 06:00 Chicago on the 9th, still inside it. */
const MORNING_AFTER = Date.UTC(2026, 7, 9, 11, 0, 0, 0);

describe("countWord", () => {
  it("should spell a small count", () => {
    expect(countWord(3)).toBe("Three");
    expect(countWord(10)).toBe("Ten");
  });

  it("should fall back to digits past ten", () => {
    // "Seventeen things came in overnight" is a sentence; 47 is a number.
    expect(countWord(47)).toBe("47");
  });
});

describe("payloadFor", () => {
  const base = {
    id: "syl:reminder:x",
    kind: "commitment" as const,
    text: "Call the pharmacy.",
    todoId: null,
    eventId: null,
    wallTime: "16:00",
    tz: CHICAGO,
    rrule: null,
    scheduledFor: "2026-08-09T21:00:00.000Z",
    nextFireAt: "2026-08-09T21:00:00.000Z",
    urgent: false,
    late: false,
    deferredFrom: null,
    supersedesPrevious: false,
    deliveryState: "scheduled" as const,
    createdAt: "2026-08-09T12:00:00.000Z",
    updatedAt: "2026-08-09T12:00:00.000Z",
    completedAt: null,
  };

  it("should break a commitment through Focus", () => {
    // A reminder that waits for the next Scheduled Summary is not a reminder.
    expect(payloadFor(base, 0).interruptionLevel).toBe("time-sensitive");
  });

  it("should keep the actionable category, because one reminder has an id to act on", () => {
    // The other half of `syl-xvx`: only a *digest* loses the buttons, and it
    // loses them because it cannot name what they would act on.
    expect(payloadFor(base, 0).categoryIdentifier).toBe("reminder");
  });

  it("should leave an ordinary rhythm message at active", () => {
    expect(payloadFor({ ...base, kind: "rhythm" }, 0).interruptionLevel).toBe("active");
  });

  it("should promote an urgent rhythm message", () => {
    expect(payloadFor({ ...base, kind: "rhythm", urgent: true }, 0).interruptionLevel).toBe(
      "time-sensitive",
    );
  });

  it("should carry the text itself, not an id to fetch", () => {
    expect(payloadFor(base, 0).body).toBe("Call the pharmacy.");
    expect(payloadFor(base, 0).threadIdentifier).toBe("reminders");
    expect(payloadFor(base, 0).categoryIdentifier).toBe("reminder");
  });

  it("should say what was skipped rather than hiding it", () => {
    expect(payloadFor(base, 2).body).toContain("Two went unsaid");
  });
});

describe("coalescedPayload", () => {
  it("should say how many waited and point at the app", () => {
    expect(coalescedPayload(3).body).toBe(
      "Three things came in overnight. They're in the app when you're ready.",
    );
  });

  it("should not break through Focus to report a quiet night", () => {
    expect(coalescedPayload(3).interruptionLevel).toBe("active");
  });

  it("should not carry the category whose actions need a reminder id", () => {
    // `syl-xvx`. A digest has no `reminderId` — it speaks for several and so
    // for none in particular — and both device actions guard on exactly that
    // field. Under the actionable category the buttons appeared and did
    // nothing, while the acknowledgement fired alongside and closed every
    // reminder the digest named as seen.
    expect(coalescedPayload(3).categoryIdentifier).not.toBe("reminder");
  });
});

describe("deliverDueReminders", () => {
  let db: SylDatabase;
  let now: number;
  let reminders: ReminderService;
  let outbox: Outbox;

  function make(overrides: Partial<CreateReminderInput> = {}): ReturnType<ReminderService["create"]> {
    return reminders.create({
      text: "Call the pharmacy.",
      wallTime: "16:00",
      tz: CHICAGO,
      date: "2026-08-09",
      ...overrides,
    });
  }

  beforeEach(() => {
    db = testDatabase();
    now = MORNING;
    reminders = new ReminderService({ db: db.handle, clock: () => now });
    outbox = new Outbox({ db: db.handle, clock: () => now, jitter: () => 0 });
  });

  afterEach(() => {
    db.close();
  });

  it("should do nothing when nothing is due", () => {
    make();
    expect(deliverDueReminders({ reminders, outbox }, now)).toEqual({
      enqueued: [],
      fired: [],
      superseded: [],
      coalesced: 0,
    });
  });

  it("should write an outbox row for a due reminder and mark it fired", () => {
    const reminder = make();
    now = Date.parse(reminder.nextFireAt);

    const result = deliverDueReminders({ reminders, outbox }, now);

    expect(result.enqueued).toHaveLength(1);
    expect(result.fired).toEqual([reminder.id]);
    expect(reminders.get(reminder.id)?.deliveryState).toBe("delivered");

    const delivery = outbox.get(result.enqueued[0] ?? "");
    expect(delivery?.reminderId).toBe(reminder.id);
    expect(delivery?.payload.body).toBe("Call the pharmacy.");
    expect(delivery?.state).toBe("pending");
    expect(delivery?.scheduledFor).toBe(reminder.scheduledFor);
  });

  it("should write one row when run twice", () => {
    // A reboot recovery, a retry, two ticks racing — all the same occurrence.
    const reminder = make();
    now = Date.parse(reminder.nextFireAt);

    deliverDueReminders({ reminders, outbox }, now);
    const second = deliverDueReminders({ reminders, outbox }, now);

    expect(second.enqueued).toHaveLength(0);
    expect(outbox.list().items).toHaveLength(1);
  });

  it("should declare lateness rather than hiding it", () => {
    const reminder = make();
    now = Date.parse(reminder.nextFireAt) + LATE_THRESHOLD_MS + 1;

    const result = deliverDueReminders({ reminders, outbox }, now);
    expect(outbox.get(result.enqueued[0] ?? "")?.late).toBe(true);
    expect(reminders.get(reminder.id)?.late).toBe(true);
  });

  it("should not call a reminder late for firing on the second", () => {
    const reminder = make();
    now = Date.parse(reminder.nextFireAt);
    const result = deliverDueReminders({ reminders, outbox }, now);
    expect(outbox.get(result.enqueued[0] ?? "")?.late).toBe(false);
  });

  it("should roll a recurring reminder forward instead of closing it", () => {
    const reminder = make({ date: null, rrule: "FREQ=DAILY", wallTime: "07:00" });
    now = Date.parse(reminder.nextFireAt);

    deliverDueReminders({ reminders, outbox }, now);

    const after = reminders.get(reminder.id);
    expect(after?.deliveryState).toBe("scheduled");
    expect(Date.parse(after?.nextFireAt ?? "")).toBeGreaterThan(now);
  });

  describe("rhythm supersession", () => {
    it("should skip a rhythm message that is past its grace window", () => {
      // Yesterday's morning agenda has no business arriving today.
      const reminder = make({
        kind: "rhythm",
        date: null,
        rrule: "FREQ=DAILY",
        wallTime: "07:00",
        text: "Morning agenda.",
      });
      now = Date.parse(reminder.nextFireAt) + RHYTHM_GRACE_MS + 1;

      const result = deliverDueReminders({ reminders, outbox }, now);

      expect(result.superseded).toEqual([reminder.id]);
      expect(result.enqueued).toHaveLength(0);
      expect(reminders.skippedCount(reminder.id)).toBe(1);
    });

    it("should still fire a rhythm message inside its grace window", () => {
      const reminder = make({
        kind: "rhythm",
        date: null,
        rrule: "FREQ=DAILY",
        wallTime: "07:00",
      });
      now = Date.parse(reminder.nextFireAt) + RHYTHM_GRACE_MS - 1;

      const result = deliverDueReminders({ reminders, outbox }, now);
      expect(result.enqueued).toHaveLength(1);
      expect(result.superseded).toHaveLength(0);
    });

    it("should say what it skipped when it finally speaks", () => {
      const reminder = make({
        kind: "rhythm",
        date: null,
        rrule: "FREQ=DAILY",
        wallTime: "07:00",
        text: "Morning agenda.",
      });
      reminders.supersede(reminder.id);
      reminders.supersede(reminder.id);

      now = Date.parse(reminders.get(reminder.id)?.nextFireAt ?? "");
      const result = deliverDueReminders({ reminders, outbox }, now);

      expect(outbox.get(result.enqueued[0] ?? "")?.payload.body).toContain("Two went unsaid");
    });

    it("should never supersede a commitment, however late", () => {
      // A commitment fires late and says it is late. It does not collapse.
      const reminder = make();
      now = Date.parse(reminder.nextFireAt) + 10 * RHYTHM_GRACE_MS;

      const result = deliverDueReminders({ reminders, outbox }, now);
      expect(result.superseded).toHaveLength(0);
      expect(result.enqueued).toHaveLength(1);
      expect(outbox.get(result.enqueued[0] ?? "")?.late).toBe(true);
    });
  });

  describe("quiet hours", () => {
    function gated(): Outbox {
      return new Outbox({ db: db.handle, clock: () => now, quietHours: QUIET, jitter: () => 0 });
    }

    it("should hold a single overnight reminder in its own words", () => {
      // One held reminder is not a batch, so it keeps what Syl wrote.
      const reminder = make({ wallTime: "23:00", date: "2026-08-08" });
      now = NIGHT;
      const held = gated();

      const result = deliverDueReminders({ reminders, outbox: held }, now);
      const delivery = held.get(result.enqueued[0] ?? "");

      expect(result.coalesced).toBe(0);
      expect(delivery?.payload.body).toBe("Call the pharmacy.");
      expect(delivery?.nextAttemptAt).toBe("2026-08-09T13:00:00.000Z");
      expect(delivery?.late).toBe(true);
      expect(reminders.get(reminder.id)?.deliveryState).toBe("delivered");
    });

    it("should coalesce a batch into one notification, not a burst", () => {
      // Ten reminders released at 08:00 would otherwise arrive as ten
      // notifications in one second. Staggering would be worse.
      for (const text of ["One thing.", "Another thing.", "A third thing."]) {
        make({ text, wallTime: "23:00", date: "2026-08-08" });
      }
      now = NIGHT;
      const held = gated();

      const result = deliverDueReminders({ reminders, outbox: held }, now);

      expect(result.enqueued).toHaveLength(1);
      expect(result.coalesced).toBe(3);

      const delivery = held.get(result.enqueued[0] ?? "");
      expect(delivery?.reminderId).toBeNull();
      expect(delivery?.coalescedReminderIds).toHaveLength(3);
      expect(delivery?.payload.body).toContain("Three things came in overnight");
      expect(delivery?.nextAttemptAt).toBe("2026-08-09T13:00:00.000Z");
      // Every one of them is still marked handled: nothing is left behind.
      expect(result.fired).toHaveLength(3);
    });

    it("should coalesce across a whole night of passes, not just one", () => {
      // syl-yvi. The runner wakes at least every sixty seconds and precisely at
      // each reminder's own instant, so a night is many passes and every
      // reminder used to be a group of one. Both older coalescing tests give
      // every reminder the same wall time and run a single pass, which is the
      // only shape that ever reached the digest.
      make({ text: "One thing.", wallTime: "22:30", date: "2026-08-08" });
      make({ text: "Another thing.", wallTime: "23:30", date: "2026-08-08" });
      make({ text: "A third thing.", wallTime: "01:30", date: "2026-08-09" });
      const held = gated();

      // A pass every minute from 22:00 to 06:00 Chicago: the real cadence.
      for (now = NIGHT_STARTS; now <= MORNING_AFTER; now += 60_000) {
        deliverDueReminders({ reminders, outbox: held }, now);
      }

      const rows = held.list().items;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.nextAttemptAt).toBe("2026-08-09T13:00:00.000Z");
      expect(rows[0]?.coalescedReminderIds).toHaveLength(3);
      expect(rows[0]?.payload.body).toContain("Three things came in overnight");
      // The earliest of them, not the last one folded in.
      expect(rows[0]?.scheduledFor).toBe("2026-08-09T03:30:00.000Z");
    });

    it("should name every reminder it marks delivered, across every pass", () => {
      // syl-2il. The invariant, stated directly: `markFired` is what stops a
      // reminder firing again, so one marked fired and named by no outbox row
      // is gone — invisible to the ack path and to the unacknowledged view,
      // with nothing anywhere recording that it was dropped.
      for (const [text, wallTime] of [
        ["Pay the invoice.", "22:30"],
        ["Email the landlord.", "22:30"],
        ["Call the pharmacy.", "23:30"],
        ["Move the car.", "23:30"],
        ["Water the plants.", "03:15"],
      ] as const) {
        make({ text, wallTime, date: wallTime === "03:15" ? "2026-08-09" : "2026-08-08" });
      }
      const held = gated();

      for (now = NIGHT_STARTS; now <= MORNING_AFTER; now += 60_000) {
        deliverDueReminders({ reminders, outbox: held }, now);
      }

      const named = new Set(
        held.list().items.flatMap((delivery) => [
          ...(delivery.reminderId === null ? [] : [delivery.reminderId]),
          ...delivery.coalescedReminderIds,
        ]),
      );
      const delivered = reminders
        .list()
        .items.filter((reminder) => reminder.deliveryState === "delivered");

      expect(delivered).toHaveLength(5);
      expect(delivered.filter((reminder) => !named.has(reminder.id))).toEqual([]);
    });

    it("should write its own row rather than amend a batch already claimed", () => {
      // Changing the words of a notification that is on its way to Apple is
      // the same silent drop by another route, so a batch that has been
      // claimed is closed to additions. A burst is a nuisance; a drop is not.
      make({ text: "One thing.", wallTime: "23:00", date: "2026-08-08" });
      now = NIGHT;
      const held = gated();
      const first = held.get(
        deliverDueReminders({ reminders, outbox: held }, now).enqueued[0] ?? "",
      );

      // Something claimed it: a second drainer, or a clock that stepped back.
      held.markSending(first?.id ?? "");

      const later = make({ text: "Water the plants.", wallTime: "23:30", date: "2026-08-08" });
      now = Date.UTC(2026, 7, 9, 4, 31, 0, 0);
      const result = deliverDueReminders({ reminders, outbox: held }, now);

      expect(result.fired).toEqual([later.id]);
      expect(held.list().items).toHaveLength(2);
      expect(held.get(result.enqueued[0] ?? "")?.payload.body).toBe("Water the plants.");
      expect(held.get(result.enqueued[0] ?? "")?.nextAttemptAt).toBe("2026-08-09T13:00:00.000Z");
      // And the claimed row is untouched.
      expect(held.get(first?.id ?? "")?.payload.body).toBe("One thing.");
    });

    it("should finish a pass that died between the batch and the mark", () => {
      // The reminders are already named by the row; what is missing is the
      // mark. Re-running must finish the job without folding them in twice.
      make({ text: "One.", wallTime: "23:00", date: "2026-08-08" });
      make({ text: "Two.", wallTime: "23:00", date: "2026-08-08" });
      now = NIGHT;
      const held = gated();

      const ids = deliverDueReminders({ reminders, outbox: held }, now).fired;
      // The row was written; the process died before `markFired` landed.
      db.handle
        .prepare("UPDATE reminders SET delivery_state = 'scheduled' WHERE id IN (?, ?)")
        .run(ids[0] ?? "", ids[1] ?? "");

      const again = deliverDueReminders({ reminders, outbox: held }, now);

      expect(again.fired).toHaveLength(2);
      expect(held.list().items).toHaveLength(1);
      expect(held.list().items[0]?.coalescedReminderIds).toHaveLength(2);
      for (const id of ids) expect(reminders.get(id)?.deliveryState).toBe("delivered");
    });

    it("should write one digest when the pass runs twice", () => {
      for (const text of ["One.", "Two."]) make({ text, wallTime: "23:00", date: "2026-08-08" });
      now = NIGHT;
      const held = gated();

      deliverDueReminders({ reminders, outbox: held }, now);
      const second = deliverDueReminders({ reminders, outbox: held }, now);

      expect(second.enqueued).toHaveLength(0);
      expect(held.list().items).toHaveLength(1);
    });

    it("should let an urgent reminder through the window", () => {
      make({ wallTime: "23:00", date: "2026-08-08", urgent: true });
      now = NIGHT;
      const held = gated();

      const result = deliverDueReminders({ reminders, outbox: held }, now);
      expect(held.get(result.enqueued[0] ?? "")?.nextAttemptAt).toBe(new Date(now).toISOString());
      expect(held.due(now)).toHaveLength(1);
    });

    it("should deliver normally once the window has lifted", () => {
      const reminder = make({ wallTime: "16:00", date: "2026-08-09" });
      now = Date.parse(reminder.nextFireAt);
      const held = gated();

      const result = deliverDueReminders({ reminders, outbox: held }, now);
      expect(held.get(result.enqueued[0] ?? "")?.late).toBe(false);
      expect(held.due(now)).toHaveLength(1);
    });
  });
});
