import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HEALTH_TYPES, UNITS, isHealthType } from "../../src/health/contract.js";
import {
  AUTHORITIES,
  HEALTH_CHARACTERISTICS,
  HIS_OWN_WORDS,
  HealthCharacteristics,
  REPORTED_BY,
  CharacteristicError,
  hisWordIn,
  renderCharacteristic,
  parseReported,
  type CharacteristicReport,
} from "../../src/health/characteristics.js";
import { MemoryGraph } from "../../src/memory/graph.js";
import { HerOwnMemory } from "../../src/memory/remember.js";
import { IN_MEMORY, openDatabase, type SylDatabase } from "../../src/services/database.js";
import type { Clock } from "../../src/services/clock.js";

/**
 * Date of birth, sex and height — `syl-8ys9.4`.
 *
 * Three facts about his body that are not measurements. HealthKit reads two of
 * them through a different API entirely (`dateOfBirthComponents()`,
 * `biologicalSex()`), and the third does not move. None of them has a series, a
 * watermark or a baseline, and the whole point of this suite is that none of
 * them ever acquires one.
 *
 * The second half is the interesting one and it is not about storage. **He has
 * already told her his birthday**, in his own words, and it is in the live graph
 * today — inside his person node, `"born October 8th 1988"`. Health may
 * disagree. When it does, his word wins, and she has to be able to say which one
 * she used: a silent preference is indistinguishable from not having noticed.
 */

const NOW = Date.UTC(2026, 7, 14, 12, 0, 0, 0);

let database: SylDatabase;
let graph: MemoryGraph;
let hers: HerOwnMemory;
let subject: HealthCharacteristics;

const clock: Clock = () => NOW;

function reported(overrides: Partial<CharacteristicReport> = {}): CharacteristicReport {
  return {
    characteristic: "dateOfBirth",
    value: "1988-10-08",
    readAt: "2026-08-14T11:59:00.000Z",
    ...overrides,
  };
}

/** His person node as the live graph actually holds it, provenance and all. */
function commanderNode(body = "He is Justin Martin, an engineering leader and entrepreneur, born October 8th 1988."): string {
  return graph.addNode({ kind: "person", label: "Justin Martin", body }).id;
}

beforeEach(() => {
  database = openDatabase({ path: IN_MEMORY });
  graph = new MemoryGraph({ db: database.handle, clock });
  hers = new HerOwnMemory({ db: database.handle, graph, clock });
  subject = new HealthCharacteristics({ graph, hers, clock });
});

afterEach(() => {
  database.close();
});

describe("the vocabulary", () => {
  it("should hold exactly the three that are not measurements", () => {
    expect([...HEALTH_CHARACTERISTICS]).toEqual(["dateOfBirth", "biologicalSex", "height"]);
  });

  /**
   * The tripwire for the one decision this phase leaves open.
   *
   * `height` is a HealthKit *quantity* type, so it is the one characteristic
   * that could plausibly be fed to the sample pipeline — and phase 1 of this
   * epic widens `HEALTH_TYPES`. If it ever lands there, this goes red and the
   * question gets answered on purpose rather than by whichever branch merged
   * last: a type in both lists has both a baseline and a fact, and the two can
   * disagree about the same man.
   */
  it("should share no name with HEALTH_TYPES: a thing is a measurement or a fact, never both", () => {
    const both = HEALTH_CHARACTERISTICS.filter((name) => (HEALTH_TYPES as readonly string[]).includes(name));
    expect(both).toEqual([]);
  });

  it("should not be a health type, so nothing can give one a unit, a watermark or a baseline", () => {
    for (const name of HEALTH_CHARACTERISTICS) {
      expect(isHealthType(name)).toBe(false);
      expect(Object.keys(UNITS)).not.toContain(name);
    }
  });

  it("should put his own words above the sensor, in that order, as a value rather than an if", () => {
    expect([...AUTHORITIES]).toEqual([HIS_OWN_WORDS, REPORTED_BY]);
    expect(AUTHORITIES[0]).toBe(HIS_OWN_WORDS);
  });
});

describe("what the phone may report", () => {
  it("should accept a date of birth as an RFC 3339 date", () => {
    expect(parseReported("dateOfBirth", "1988-10-08")).toBe("1988-10-08");
  });

  it("should refuse a date of birth in any other shape rather than guessing at it", () => {
    expect(() => parseReported("dateOfBirth", "10/08/1988")).toThrow(CharacteristicError);
    expect(() => parseReported("dateOfBirth", "October 8th 1988")).toThrow(CharacteristicError);
  });

  it("should accept the four values HealthKit can answer for sex", () => {
    expect(parseReported("biologicalSex", "male")).toBe("male");
    expect(parseReported("biologicalSex", "female")).toBe("female");
    expect(parseReported("biologicalSex", "other")).toBe("other");
    expect(parseReported("biologicalSex", "notSet")).toBe("notSet");
    expect(() => parseReported("biologicalSex", "man")).toThrow(CharacteristicError);
  });

  it("should accept a height in inches and refuse one that is not a positive number", () => {
    expect(parseReported("height", "74")).toBe("74");
    expect(() => parseReported("height", "0")).toThrow(CharacteristicError);
    expect(() => parseReported("height", "six foot")).toThrow(CharacteristicError);
  });

  it("should render a height as he would say it, not as a decimal", () => {
    expect(renderCharacteristic("height", "74")).toBe("6 ft 2 in");
    expect(renderCharacteristic("dateOfBirth", "1988-10-08")).toBe("8 October 1988");
    expect(renderCharacteristic("biologicalSex", "male")).toBe("male");
  });
});

describe("reading what he said", () => {
  it("should find his date of birth in his own person node, as the live graph holds it", () => {
    expect(hisWordIn("dateOfBirth", "He is Justin Martin, an engineering leader and entrepreneur, born October 8th 1988.")).toBe(
      "1988-10-08",
    );
  });

  it("should read the other orderings he might have used", () => {
    expect(hisWordIn("dateOfBirth", "He was born on 8 October 1988.")).toBe("1988-10-08");
    expect(hisWordIn("dateOfBirth", "His date of birth is 1988-10-08.")).toBe("1988-10-08");
  });

  /**
   * The false positive that would have her claim his birthday is his wife's.
   * Every person in his life is described possessively — "his wife", "his son" —
   * so a text carrying one of those is about somebody else's birthday whatever
   * else is in it, and it is discarded whole.
   */
  it("should never take another person's birthday for his", () => {
    expect(hisWordIn("dateOfBirth", "His wife Ela, born April 22nd 1994, is a fiery yogi.")).toBeNull();
    expect(hisWordIn("dateOfBirth", "His daughter Isla was born November 14th 2020.")).toBeNull();
  });

  it("should decline rather than guess when the text names no date", () => {
    expect(hisWordIn("dateOfBirth", "Both he and Ela were born in Illinois.")).toBeNull();
  });

  it("should read a height he stated and a sex he stated", () => {
    expect(hisWordIn("height", "He is 6'2\" and has been lifting since March.")).toBe("74");
    expect(hisWordIn("biologicalSex", "He is male.")).toBe("male");
  });

  it("should not read a sex out of a pronoun, which every sentence about him has", () => {
    expect(hisWordIn("biologicalSex", "He went to the gym.")).toBeNull();
  });
});

describe("recording what Health reported", () => {
  it("should write a memory naming the reporter, and never a fact", () => {
    const outcome = subject.record([reported()]).outcomes[0];
    expect(outcome).toBeDefined();
    const node = graph.getNode(outcome?.nodeId ?? "");
    expect(node?.kind).toBe("memory");
    expect(`${node?.label} ${node?.body ?? ""}`).toContain(REPORTED_BY);
  });

  it("should never write a row into health_samples", () => {
    const before = database.handle.prepare("SELECT count(*) AS n FROM health_samples").get() as unknown as {
      n: number;
    };
    subject.record([reported(), reported({ characteristic: "height", value: "74" })]);
    const after = database.handle.prepare("SELECT count(*) AS n FROM health_samples").get() as unknown as {
      n: number;
    };
    expect(before.n).toBe(0);
    expect(after.n).toBe(0);
  });

  it("should refuse a report whose name is a measurement type", () => {
    expect(() => subject.record([reported({ characteristic: "steps" as never, value: "12000" })])).toThrow(
      CharacteristicError,
    );
  });

  it("should say the sensor is her source when he has never told her", () => {
    const outcome = subject.record([reported()]).outcomes[0];
    expect(outcome?.using).toBe(REPORTED_BY);
    expect(outcome?.hisWord).toBeNull();
    expect(outcome?.why).toContain(REPORTED_BY);
  });

  it("should reuse the memory rather than accumulate one per upload", () => {
    const first = subject.record([reported()]).outcomes[0];
    const second = subject.record([reported()]).outcomes[0];
    expect(second?.nodeId).toBe(first?.nodeId);
    expect(second?.created).toBe(false);
  });
});

describe("when Health and his own words disagree", () => {
  it("should use his, and say so", () => {
    commanderNode();
    const outcome = subject.record([reported({ value: "1989-10-08" })]).outcomes[0];

    expect(outcome?.using).toBe(HIS_OWN_WORDS);
    expect(outcome?.value).toBe("1988-10-08");
    expect(outcome?.agrees).toBe(false);
    expect(outcome?.why).toContain("8 October 1988");
    expect(outcome?.why).toContain("8 October 1989");
  });

  it("should keep what the sensor said rather than drop it", () => {
    commanderNode();
    const outcome = subject.record([reported({ value: "1989-10-08" })]).outcomes[0];
    const node = graph.getNode(outcome?.nodeId ?? "");
    expect(`${node?.label} ${node?.body ?? ""}`).toContain("8 October 1989");
  });

  it("should link the disagreement to the node carrying his word, with its reasoning", () => {
    const his = commanderNode();
    const outcome = subject.record([reported({ value: "1989-10-08" })]).outcomes[0];

    expect(outcome?.contradicts).not.toBeNull();
    const edge = graph.getEdge(outcome?.contradicts ?? "");
    expect(edge?.kind).toBe("inferred");
    expect(edge?.relation).toBe("contradicts");
    expect([edge?.sourceNode, edge?.targetNode]).toContain(his);
    expect(edge?.kind === "inferred" ? edge.reasoning : "").toContain(HIS_OWN_WORDS);
  });

  it("should agree out loud when they agree, and write no contradiction", () => {
    commanderNode();
    const outcome = subject.record([reported()]).outcomes[0];

    expect(outcome?.using).toBe(HIS_OWN_WORDS);
    expect(outcome?.agrees).toBe(true);
    expect(outcome?.contradicts).toBeNull();
  });

  it("should not read a wife's birthday as his and pick a fight with the sensor", () => {
    commanderNode("He is Justin Martin, an engineering leader and entrepreneur.");
    graph.addNode({
      kind: "person",
      label: "Ela — his wife",
      body: "His wife Ela, born April 22nd 1994, is a fiery yogi full of spirit and life.",
    });
    const outcome = subject.record([reported()]).outcomes[0];
    expect(outcome?.hisWord).toBeNull();
    expect(outcome?.using).toBe(REPORTED_BY);
  });
});

describe("a characteristic never acquires a baseline", () => {
  /**
   * `syl-8ys9.4.3`. A deviation detector pointed at a constant produces noise
   * with a mean. The guarantee is structural rather than behavioural: the
   * derivation layer iterates `HEALTH_TYPES`, so a name that is not in that list
   * has no way to reach it — and this module holds no reference to the sample
   * store at all.
   */
  it("should leave nothing for a derivation to read", () => {
    commanderNode();
    subject.record([
      reported(),
      reported({ characteristic: "height", value: "74" }),
      reported({ characteristic: "biologicalSex", value: "male" }),
    ]);

    const rows = database.handle.prepare("SELECT count(*) AS n FROM health_samples").get() as unknown as {
      n: number;
    };
    const marks = database.handle.prepare("SELECT count(*) AS n FROM health_watermarks").get() as unknown as {
      n: number;
    };
    expect(rows.n).toBe(0);
    expect(marks.n).toBe(0);
  });

  it("should be unable to name a characteristic to the sample store", () => {
    for (const name of HEALTH_CHARACTERISTICS) {
      expect(isHealthType(name)).toBe(false);
    }
  });
});
