import { describe, expect, it } from "vitest";

import type { Ok, Reminder, ReminderPage } from "@syl/shared/types";

import {
  PROVENANCES,
  provenanceLabel,
  provenanceOf,
  provenanceTone,
  reasonOf,
  sortReminders,
  summariseProvenance,
  summaryHeadline,
} from "../../src/features/reminders/reminder-model";
import { fixture } from "../helpers/fixtures";

const page: readonly Reminder[] = (fixture("http/reminders.page") as Ok<ReminderPage>).data.items;

/** The three provenances the shared page fixture carries, one each. */
const asked = page.find((r) => r.origin === "he_asked") as Reminder;
const noticed = page.find((r) => r.origin === "she_noticed") as Reminder;
const unrecorded = page.find((r) => r.origin === null) as Reminder;

describe("the fixture this suite is built on", () => {
  it("should carry all three provenances, or the rest of these tests prove nothing", () => {
    expect(asked).toBeDefined();
    expect(noticed).toBeDefined();
    expect(unrecorded).toBeDefined();
  });
});

describe("provenanceOf", () => {
  it("should call a reminder she offered unprompted hers", () => {
    expect(provenanceOf(noticed)).toBe("hers");
  });

  it("should call a reminder he requested his", () => {
    expect(provenanceOf(asked)).toBe("his");
  });

  it("should call a row with no recorded origin unrecorded, not hers", () => {
    // The distinction the whole bead turns on. Guessing "hers" here would
    // attribute to Syl every reminder written before the column existed —
    // exactly the claim-beyond-the-evidence that `syl-y82` exists to stop.
    expect(provenanceOf(unrecorded)).toBe("unrecorded");
  });

  it("should not treat a reason without an origin as evidence of one", () => {
    // Prose answers "why does this exist" and only sometimes "did he ask".
    // Reading an origin out of it is the mistake, not the fix.
    const half = { ...unrecorded, because: "you mentioned him in March" };
    expect(provenanceOf(half)).toBe("unrecorded");
  });
});

describe("provenanceLabel and provenanceTone", () => {
  it("should name hers plainly, so a list can be scanned for them", () => {
    expect(provenanceLabel("hers")).toBe("Syl noticed");
  });

  it("should say of an unrecorded row that it predates the record", () => {
    // Never "no reason given" and never "missing": both read as Syl having
    // failed to explain herself, when the truth is that nobody was keeping
    // the answer yet.
    expect(provenanceLabel("unrecorded")).toBe("before this was recorded");
  });

  it("should give an unrecorded row a muted tone, never a failing one", () => {
    // `syl-91z`: nothing to show and failed to show must not look alike. A
    // red chip here would be the app reporting its own history as an error.
    expect(provenanceTone("unrecorded")).toBe("muted");
    expect(provenanceTone("hers")).toBe("accent");
    expect(provenanceTone("his")).toBe("muted");
  });

  it("should have a label and a tone for every provenance", () => {
    // Exhaustive by construction: a value added to the contract fails here
    // rather than rendering as a blank chip.
    for (const provenance of PROVENANCES) {
      expect(provenanceLabel(provenance).length).toBeGreaterThan(0);
      expect(provenanceTone(provenance)).toBeDefined();
    }
  });
});

describe("reasonOf", () => {
  it("should hand back the recorded reason verbatim", () => {
    expect(reasonOf(noticed)).toBe(noticed.because);
  });

  it("should return null for a row that predates the record", () => {
    // Null, not "—" and not "no reason given". The caller decides how to say
    // nothing; this function refuses to invent a sentence.
    expect(reasonOf(unrecorded)).toBeNull();
  });

  it("should treat a blank reason as no reason rather than as an empty line", () => {
    expect(reasonOf({ ...noticed, because: "   " })).toBeNull();
  });
});

describe("summariseProvenance", () => {
  it("should count each provenance in the page", () => {
    const summary = summariseProvenance(page);
    expect(summary.hers).toBe(1);
    expect(summary.his).toBe(1);
    expect(summary.unrecorded).toBe(1);
    expect(summary.total).toBe(3);
  });

  it("should count nothing in an empty page", () => {
    expect(summariseProvenance([])).toEqual({ total: 0, hers: 0, his: 0, unrecorded: 0 });
  });
});

describe("summaryHeadline", () => {
  it("should lead with how many she thought of, because that is the number he acts on", () => {
    // The sentence that makes "tell her to stop making a kind I dislike"
    // possible at all: he cannot object to a pattern he cannot count.
    expect(summaryHeadline(summariseProvenance(page))).toContain("1 Syl thought of");
  });

  it("should say plainly when she has thought of none of them", () => {
    const summary = summariseProvenance(page.filter((r) => r.origin !== "she_noticed"));
    expect(summaryHeadline(summary)).toContain("none");
  });

  it("should not describe an empty page as though she had offered nothing", () => {
    // An empty outbox is not a statement about her behaviour.
    expect(summaryHeadline(summariseProvenance([]))).toBe("No reminders.");
  });
});

describe("sortReminders", () => {
  it("should put the soonest next fire first", () => {
    const sorted = sortReminders(page);
    const instants = sorted.map((r) => Date.parse(r.nextFireAt));
    expect(instants).toEqual([...instants].sort((a, b) => a - b));
  });

  it("should not mutate what it was given", () => {
    const before = page.map((r) => r.id);
    sortReminders(page);
    expect(page.map((r) => r.id)).toEqual(before);
  });
});
