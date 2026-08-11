import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SylDatabase } from "../../src/services/database.js";
import { PagingError } from "../../src/services/paging.js";
import {
  ReminderError,
  ReminderService,
  type CreateReminderInput,
} from "../../src/services/reminder-service.js";
import { localPartsOf } from "../../src/services/recurrence.js";
import { testDatabase } from "../helpers/service.js";

const CHICAGO = "America/Chicago";
/** 2026-08-09T12:00Z — 07:00 in Chicago, a Sunday morning. */
const NOW = Date.UTC(2026, 7, 9, 12, 0, 0, 0);

function commitment(overrides: Partial<CreateReminderInput> = {}): CreateReminderInput {
  return {
    text: "Call the pharmacy — the refill lapses today.",
    wallTime: "16:00",
    tz: CHICAGO,
    date: "2026-08-09",
    ...overrides,
  };
}

describe("ReminderService", () => {
  let db: SylDatabase;
  let now: number;
  let reminders: ReminderService;

  beforeEach(() => {
    db = testDatabase();
    now = NOW;
    reminders = new ReminderService({ db: db.handle, clock: () => now });
  });

  afterEach(() => {
    db.close();
  });

  describe("create", () => {
    it("should materialise a one-shot at the requested wall clock", () => {
      const reminder = reminders.create(commitment());

      expect(reminder.kind).toBe("commitment");
      expect(reminder.deliveryState).toBe("scheduled");
      expect(reminder.nextFireAt).toBe("2026-08-09T21:00:00.000Z");
      expect(reminder.scheduledFor).toBe("2026-08-09T21:00:00.000Z");
      // Wall time and zone are what is stored. The instant is derived.
      expect(reminder.wallTime).toBe("16:00");
      expect(reminder.tz).toBe(CHICAGO);
    });

    it("should keep the text exactly as it was composed", () => {
      // Delivery reads this verbatim; there is no model downstream to improve it.
      const reminder = reminders.create(commitment());
      expect(reminder.text).toBe("Call the pharmacy — the refill lapses today.");
    });

    it("should schedule a recurrence at its next occurrence", () => {
      const reminder = reminders.create(
        commitment({
          text: "Morning agenda.",
          kind: "rhythm",
          wallTime: "07:00",
          date: null,
          rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
        }),
      );

      expect(reminder.kind).toBe("rhythm");
      // A rhythm message supersedes; a commitment never collapses.
      expect(reminder.supersedesPrevious).toBe(true);
      expect(localPartsOf(new Date(reminder.nextFireAt), CHICAGO).date).toBe("2026-08-10");
    });

    it("should mark a commitment as never superseding", () => {
      expect(reminders.create(commitment()).supersedesPrevious).toBe(false);
    });

    it("should refuse a reminder with nothing to say", () => {
      expect(() => reminders.create(commitment({ text: "   " }))).toThrow(ReminderError);
    });

    it("should refuse a wall time that is not one", () => {
      expect(() => reminders.create(commitment({ wallTime: "25:00" }))).toThrow(ReminderError);
      expect(() => reminders.create(commitment({ wallTime: "4pm" }))).toThrow(ReminderError);
    });

    it("should refuse a fixed UTC offset in place of a zone", () => {
      // An offset is a property of an instant, not of a place, and one that
      // reaches storage survives exactly one DST boundary.
      expect(() => reminders.create(commitment({ tz: "-05:00" }))).toThrow(ReminderError);
      expect(() => reminders.create(commitment({ tz: "EST" }))).toThrow(ReminderError);
      expect(() => reminders.create(commitment({ tz: "Not/AZone" }))).toThrow(ReminderError);
    });

    it("should refuse both a date and an rrule, or neither", () => {
      expect(() => reminders.create(commitment({ rrule: "FREQ=DAILY" }))).toThrow(ReminderError);
      expect(() => reminders.create(commitment({ date: null }))).toThrow(ReminderError);
    });

    it("should refuse an rrule outside the supported subset", () => {
      try {
        reminders.create(commitment({ date: null, rrule: "FREQ=HOURLY" }));
        expect.unreachable("should have thrown");
      } catch (error) {
        expect((error as ReminderError).kind).toBe("rrule_unsupported");
      }
    });

    it("should refuse a kind the contract does not define", () => {
      expect(() => reminders.create(commitment({ kind: "nag" }))).toThrow(ReminderError);
    });

    it("should carry urgency, which is what becomes time-sensitive", () => {
      expect(reminders.create(commitment({ urgent: true })).urgent).toBe(true);
      expect(reminders.create(commitment()).urgent).toBe(false);
    });
  });

  describe("due", () => {
    it("should return nothing before the moment arrives", () => {
      reminders.create(commitment());
      expect(reminders.due(now)).toHaveLength(0);
    });

    it("should return a reminder once its instant has passed", () => {
      const reminder = reminders.create(commitment());
      expect(reminders.due(Date.parse(reminder.nextFireAt))).toHaveLength(1);
    });

    it("should include a deferred reminder, because deferral moves it rather than removing it", () => {
      const reminder = reminders.create(commitment());
      reminders.snooze(reminder.id, { minutes: 30 });
      expect(reminders.due(Date.parse(reminder.nextFireAt) + 3_600_000)).toHaveLength(1);
    });

    it("should not return a cancelled or completed reminder", () => {
      const cancelled = reminders.create(commitment());
      const completed = reminders.create(commitment());
      reminders.cancel(cancelled.id);
      reminders.complete(completed.id);
      expect(reminders.due(now + 86_400_000)).toHaveLength(0);
    });

    it("should report the next instant anything is due", () => {
      expect(reminders.nextDueAt()).toBeNull();
      const reminder = reminders.create(commitment());
      expect(reminders.nextDueAt()).toBe(reminder.nextFireAt);
    });
  });

  describe("snooze", () => {
    it("should move a reminder strictly later and remember where it came from", () => {
      const reminder = reminders.create(commitment());
      const snoozed = reminders.snooze(reminder.id, { minutes: 15 });

      expect(snoozed?.deliveryState).toBe("deferred");
      expect(snoozed?.deferredFrom).toBe(reminder.nextFireAt);
      expect(Date.parse(snoozed?.nextFireAt ?? "")).toBe(
        Date.parse(reminder.nextFireAt) + 15 * 60_000,
      );
    });

    it("should measure minutes from now when the reminder is already late", () => {
      // "Fifteen minutes" on a reminder that is two hours late must mean
      // fifteen minutes from now, not an hour and three quarters ago.
      const reminder = reminders.create(commitment());
      now = Date.parse(reminder.nextFireAt) + 2 * 3_600_000;
      const snoozed = reminders.snooze(reminder.id, { minutes: 15 });
      expect(Date.parse(snoozed?.nextFireAt ?? "")).toBe(now + 15 * 60_000);
    });

    it("should accept an explicit later instant", () => {
      const reminder = reminders.create(commitment());
      const snoozed = reminders.snooze(reminder.id, { until: "2026-08-10T21:00:00.000Z" });
      expect(snoozed?.nextFireAt).toBe("2026-08-10T21:00:00.000Z");
    });

    it("should refuse a deferral that does not move forward", () => {
      // Accepting one would drop the reminder, which is the single failure
      // this project is built against.
      const reminder = reminders.create(commitment());
      for (const until of [reminder.nextFireAt, "2026-08-09T20:00:00.000Z"]) {
        try {
          reminders.snooze(reminder.id, { until });
          expect.unreachable("should have thrown");
        } catch (error) {
          expect((error as ReminderError).kind).toBe("not_later");
        }
      }
    });

    it("should refuse a request that names neither until nor minutes", () => {
      const reminder = reminders.create(commitment());
      expect(() => reminders.snooze(reminder.id, {})).toThrow(ReminderError);
      expect(() => reminders.snooze(reminder.id, { minutes: 0 })).toThrow(ReminderError);
      expect(() => reminders.snooze(reminder.id, { until: "tomorrow" })).toThrow(ReminderError);
    });

    it("should return null for a reminder it does not have", () => {
      expect(reminders.snooze("syl:reminder:missing", { minutes: 5 })).toBeNull();
    });
  });

  describe("markFired", () => {
    it("should hold a one-shot at delivered, waiting for the device", () => {
      const reminder = reminders.create(commitment());
      const fired = reminders.markFired(reminder.id, { late: true });

      expect(fired?.deliveryState).toBe("delivered");
      expect(fired?.late).toBe(true);
    });

    it("should roll a recurrence forward by wall clock, not by 24 hours", () => {
      const reminder = reminders.create(
        commitment({ date: null, rrule: "FREQ=DAILY", wallTime: "07:00" }),
      );
      const fired = reminders.markFired(reminder.id);

      expect(fired?.deliveryState).toBe("scheduled");
      expect(localPartsOf(new Date(fired?.nextFireAt ?? ""), CHICAGO).date).toBe("2026-08-11");
      expect(fired?.scheduledFor).toBe(fired?.nextFireAt);
    });

    it("should clear a deferral when the occurrence rolls forward", () => {
      const reminder = reminders.create(commitment({ date: null, rrule: "FREQ=DAILY" }));
      reminders.snooze(reminder.id, { minutes: 30 });
      const fired = reminders.markFired(reminder.id);
      expect(fired?.deferredFrom).toBeNull();
    });

    it("should return null for a reminder it does not have", () => {
      expect(reminders.markFired("syl:reminder:missing")).toBeNull();
    });
  });

  describe("supersede", () => {
    it("should roll a rhythm occurrence forward and count the skip", () => {
      // Yesterday's morning agenda has no business arriving today — but the
      // suppression is counted, not discarded, so the next one can say so.
      const reminder = reminders.create(
        commitment({ kind: "rhythm", date: null, rrule: "FREQ=DAILY", wallTime: "07:00" }),
      );

      const superseded = reminders.supersede(reminder.id);
      expect(superseded?.deliveryState).toBe("scheduled");
      expect(reminders.skippedCount(reminder.id)).toBe(1);

      reminders.supersede(reminder.id);
      expect(reminders.skippedCount(reminder.id)).toBe(2);
    });

    it("should reset the count once the reminder actually speaks", () => {
      const reminder = reminders.create(
        commitment({ kind: "rhythm", date: null, rrule: "FREQ=DAILY" }),
      );
      reminders.supersede(reminder.id);
      reminders.markFired(reminder.id);
      expect(reminders.skippedCount(reminder.id)).toBe(0);
    });

    it("should refuse to supersede a one-shot, which never collapses", () => {
      const reminder = reminders.create(commitment());
      expect(reminders.supersede(reminder.id)).toBeNull();
      expect(reminders.supersede("syl:reminder:missing")).toBeNull();
    });
  });

  describe("update", () => {
    it("should change what a reminder says without moving it", () => {
      const reminder = reminders.create(commitment());
      const updated = reminders.update(reminder.id, { text: "Pharmacy closes at 18:00." });

      expect(updated?.text).toBe("Pharmacy closes at 18:00.");
      expect(updated?.nextFireAt).toBe(reminder.nextFireAt);
    });

    it("should recompute the instant when the wall time moves", () => {
      const reminder = reminders.create(commitment());
      const updated = reminders.update(reminder.id, { wallTime: "18:00" });
      expect(updated?.nextFireAt).toBe("2026-08-09T23:00:00.000Z");
    });

    it("should recompute the instant when the zone moves", () => {
      const reminder = reminders.create(commitment());
      const updated = reminders.update(reminder.id, { tz: "America/New_York" });
      expect(updated?.nextFireAt).toBe("2026-08-09T20:00:00.000Z");
    });

    it("should re-derive a recurrence when the rule changes", () => {
      const reminder = reminders.create(commitment({ date: null, rrule: "FREQ=DAILY" }));
      const updated = reminders.update(reminder.id, { rrule: "FREQ=WEEKLY;BYDAY=SA" });
      expect(localPartsOf(new Date(updated?.nextFireAt ?? ""), CHICAGO).date).toBe("2026-08-15");
    });

    it("should refuse an unsupported rule rather than storing it", () => {
      const reminder = reminders.create(commitment());
      expect(() => reminders.update(reminder.id, { rrule: "FREQ=HOURLY" })).toThrow(ReminderError);
      expect(() => reminders.update(reminder.id, { text: "" })).toThrow(ReminderError);
      expect(() => reminders.update(reminder.id, { wallTime: "99:99" })).toThrow(ReminderError);
    });

    it("should return null for a reminder it does not have", () => {
      expect(reminders.update("syl:reminder:missing", { text: "x" })).toBeNull();
    });
  });

  describe("closing a reminder", () => {
    it("should complete without deleting the row", () => {
      const reminder = reminders.create(commitment());
      const completed = reminders.complete(reminder.id);

      expect(completed?.deliveryState).toBe("completed");
      expect(completed?.completedAt).toBe(new Date(now).toISOString());
      expect(reminders.get(reminder.id)).not.toBeNull();
    });

    it("should cancel without deleting the row", () => {
      const reminder = reminders.create(commitment());
      expect(reminders.cancel(reminder.id)?.deliveryState).toBe("cancelled");
      expect(reminders.get(reminder.id)).not.toBeNull();
    });

    it("should acknowledge only a reminder that was delivered", () => {
      const reminder = reminders.create(commitment());
      // Not yet fired: acknowledging must not invent a delivery.
      expect(reminders.markAcknowledged(reminder.id)?.deliveryState).toBe("scheduled");

      reminders.markFired(reminder.id);
      expect(reminders.markAcknowledged(reminder.id)?.deliveryState).toBe("acknowledged");
    });

    it("should return null for a reminder it does not have", () => {
      expect(reminders.complete("syl:reminder:missing")).toBeNull();
      expect(reminders.cancel("syl:reminder:missing")).toBeNull();
      expect(reminders.markAcknowledged("syl:reminder:missing")).toBeNull();
    });
  });

  describe("list", () => {
    beforeEach(() => {
      reminders.create(commitment());
      now += 1_000;
      const second = reminders.create(commitment({ text: "Second." }));
      reminders.cancel(second.id);
    });

    it("should page newest first", () => {
      const first = reminders.list({ limit: 1 });
      expect(first.items[0]?.text).toBe("Second.");
      expect(first.hasMore).toBe(true);

      const second = reminders.list({ limit: 1, cursor: first.nextCursor });
      expect(second.items).toHaveLength(1);
      expect(second.hasMore).toBe(false);
    });

    it("should filter by state", () => {
      expect(reminders.list({ state: "cancelled" }).items).toHaveLength(1);
      expect(reminders.list({ state: "scheduled" }).items).toHaveLength(1);
    });

    it("should filter by when it is next due", () => {
      expect(reminders.list({ dueBefore: "2026-08-09T20:00:00.000Z" }).items).toHaveLength(0);
      expect(reminders.list({ dueBefore: "2026-08-09T22:00:00.000Z" }).items).toHaveLength(2);
    });

    it("should refuse a cursor it did not issue", () => {
      expect(() => reminders.list({ cursor: "nope" })).toThrow(PagingError);
    });
  });

  it("should expose the delivery states the contract defines", () => {
    expect(ReminderService.states).toContain("acknowledged");
    expect(ReminderService.states).toHaveLength(8);
  });
});
