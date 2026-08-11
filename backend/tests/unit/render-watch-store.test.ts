import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Clock } from "../../src/services/clock.js";
import { openDatabase, IN_MEMORY, type SylDatabase } from "../../src/services/database.js";
import { RenderWatchStore, RenderWatchError } from "../../src/services/render-watch-store.js";

/**
 * The rows that make "come back and look at it" survive a restart.
 *
 * Two properties carry the whole feature and both are asserted here rather
 * than in the job that uses them, because a guard the caller has to remember
 * is not a guard:
 *
 *  - **a deferral is always to a strictly later instant** (constraint 4: a
 *    deferred thing that lands on the same instant, or earlier, is a thing
 *    that never happens again while looking like it will), and
 *  - **a settled watch is settled with a sentence**, so "given up on" is
 *    always something a person can read rather than a state code.
 */
describe("RenderWatchStore", () => {
  let database: SylDatabase;
  let watches: RenderWatchStore;
  let now: number;
  const clock: Clock = () => now;

  beforeEach(() => {
    now = Date.parse("2026-08-11T14:00:00.000Z");
    database = openDatabase({ path: IN_MEMORY });
    watches = new RenderWatchStore({ db: database.handle, clock });
  });

  afterEach(() => {
    database.close();
  });

  /** Start a watch five minutes out, the way a render does. */
  function watch(renderName = "syl-2026-08-11-140000-medium", checkAt = now + 300_000) {
    return watches.watch({
      renderName,
      because: "He said the ribbon shot was the one that felt like me.",
      checkAt,
    });
  }

  describe("starting a watch", () => {
    it("should record a render to come back to, waiting, with nothing decided", () => {
      const created = watch();

      expect(created.renderName).toBe("syl-2026-08-11-140000-medium");
      expect(created.state).toBe("waiting");
      expect(created.attempts).toBe(0);
      expect(created.note).toBeNull();
      expect(Date.parse(created.checkAt ?? "")).toBe(now + 300_000);
    });

    it("should adopt the watch that already exists rather than arrange a second wake", () => {
      // One render, one wake. A retried start, or a recovery pass, must not
      // end in her being woken twice about the same clip — which would be two
      // decisions about one thing and, if she said yes to both, two pushes.
      const first = watch();
      const second = watch();

      expect(second.id).toBe(first.id);
      expect(watches.due(now + 600_000)).toHaveLength(1);
    });

    it("should refuse a watch with no reason for existing", () => {
      // The wake happens on a thread that remembers nothing. Without the
      // reason she is handed a machine-generated name and asked for an opinion.
      expect(() =>
        watches.watch({ renderName: "syl-2026-08-11-140000-medium", because: "  ", checkAt: now }),
      ).toThrow(RenderWatchError);
    });
  });

  describe("what is due", () => {
    it("should hold a watch until its instant arrives", () => {
      watch();

      expect(watches.due(now)).toHaveLength(0);
      expect(watches.due(now + 299_999)).toHaveLength(0);
      expect(watches.due(now + 300_000)).toHaveLength(1);
    });

    it("should hand back the longest-waiting first", () => {
      watch("syl-2026-08-11-140000-medium", now + 300_000);
      watch("syl-2026-08-11-140100-close", now + 60_000);

      const due = watches.due(now + 600_000);
      expect(due.map((row) => row.renderName)).toEqual([
        "syl-2026-08-11-140100-close",
        "syl-2026-08-11-140000-medium",
      ]);
    });

    it("should say when the next one is due, so the job can sleep exactly that long", () => {
      expect(watches.nextDueAt()).toBeNull();
      watch("syl-2026-08-11-140000-medium", now + 300_000);
      watch("syl-2026-08-11-140100-close", now + 60_000);

      expect(Date.parse(watches.nextDueAt() ?? "")).toBe(now + 60_000);
    });

    it("should stop offering a watch once it is settled", () => {
      const created = watch();
      watches.settle(created.id, "decided", "Sent it. The ribbon holds all the way through.");

      expect(watches.due(now + 600_000)).toHaveLength(0);
      expect(watches.nextDueAt()).toBeNull();
    });
  });

  describe("deferring", () => {
    it("should move the instant strictly later and count the attempt", () => {
      const created = watch();
      const deferred = watches.defer(created.id, now + 480_000);

      expect(Date.parse(deferred.checkAt ?? "")).toBe(now + 480_000);
      expect(deferred.attempts).toBe(1);
      expect(deferred.state).toBe("waiting");
    });

    it("should refuse a deferral that is not strictly later", () => {
      // Constraint 4, in the one place it can be broken by arithmetic. A
      // deferral onto the same instant leaves the row due forever and burns a
      // pass every tick; one into the past does the same and looks like data.
      const created = watch();
      const at = Date.parse(created.checkAt ?? "");

      expect(() => watches.defer(created.id, at)).toThrow(RenderWatchError);
      expect(() => watches.defer(created.id, at - 1)).toThrow(RenderWatchError);
      expect(watches.get(created.id)?.attempts).toBe(0);
    });

    it("should refuse to defer a watch that is already settled", () => {
      const created = watch();
      watches.settle(created.id, "decided", "Not this one — it is not me.");

      expect(() => watches.defer(created.id, now + 900_000)).toThrow(RenderWatchError);
    });
  });

  describe("settling", () => {
    it("should record her decision with what she said about it", () => {
      const created = watch();
      const settled = watches.settle(
        created.id,
        "decided",
        "Sent it. He has been carrying the Ela thing all week.",
      );

      expect(settled.state).toBe("decided");
      expect(settled.checkAt).toBeNull();
      expect(settled.note).toBe("Sent it. He has been carrying the Ela thing all week.");
    });

    it("should record declining exactly as it records sending", () => {
      // Her restraint is a decision, not a missing value. A store that had
      // only "sent" would make an unspent render indistinguishable from one
      // nobody ever looked at.
      const created = watch();
      const settled = watches.settle(created.id, "decided", "Not worth interrupting him for.");

      expect(settled.state).toBe("decided");
      expect(settled.note).toBe("Not worth interrupting him for.");
    });

    it("should record giving up, so a render that never finished is not merely dropped", () => {
      const created = watch();
      const settled = watches.settle(
        created.id,
        "gave_up",
        "It was still rendering after twenty minutes, so I stopped waiting on it.",
      );

      expect(settled.state).toBe("gave_up");
      expect(settled.checkAt).toBeNull();
      expect(settled.note).toContain("stopped waiting");
    });

    it("should refuse a settlement with no sentence", () => {
      const created = watch();
      expect(() => watches.settle(created.id, "gave_up", "   ")).toThrow(RenderWatchError);
    });

    it("should refuse to settle the same watch twice", () => {
      // The second settlement is either a duplicate pass or a bug, and both
      // want to be loud: a watch that could be re-decided is a watch that
      // could send twice.
      const created = watch();
      watches.settle(created.id, "decided", "Sent it.");

      expect(() => watches.settle(created.id, "decided", "Sent it again.")).toThrow(
        RenderWatchError,
      );
    });
  });

  describe("what the schema refuses", () => {
    it("should never let a watch be deleted", () => {
      const created = watch();
      expect(() =>
        database.handle.prepare("DELETE FROM render_watches WHERE id = ?").run(created.id),
      ).toThrow(/never deleted/);
    });
  });

  describe("reading one back", () => {
    it("should find a watch by the render it is about", () => {
      const created = watch();
      expect(watches.byRenderName("syl-2026-08-11-140000-medium")?.id).toBe(created.id);
      expect(watches.byRenderName("syl-2026-08-11-999999-medium")).toBeNull();
    });

    it("should return null for a watch that does not exist", () => {
      expect(watches.get("syl:render_watch:nope")).toBeNull();
    });
  });
});
