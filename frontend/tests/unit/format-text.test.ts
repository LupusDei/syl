import { describe, expect, it } from "vitest";

import { firstLine, formatCost, humanise, pluralise, shortId } from "../../src/format/text";

describe("shortId", () => {
  it("should keep the type and the head of the uuid", () => {
    expect(shortId("syl:job:0198f2c4-0001-7000-8000-00000000e001")).toBe("job:0198f2c4");
  });

  it("should leave anything that is not a syl id alone", () => {
    expect(shortId("plain")).toBe("plain");
    expect(shortId("syl:job")).toBe("syl:job");
  });

  it("should tolerate an id whose value carries extra colons", () => {
    expect(shortId("syl:run:abcd1234-x:y")).toBe("run:abcd1234");
  });
});

describe("humanise", () => {
  it("should turn the wire's snake_case enums into words", () => {
    expect(humanise("morning_agenda")).toBe("morning agenda");
    expect(humanise("half_open")).toBe("half open");
  });
});

describe("formatCost", () => {
  it("should say $0 for a run that used no turns", () => {
    // `maxTurns: 0` is the strongest statement in the job catalogue; showing
    // it as $0.0000 buries the one fact worth noticing.
    expect(formatCost(0)).toBe("$0");
  });

  it("should keep four places for the cents a turn actually costs", () => {
    // Two places would round most of the job catalogue to the same number.
    expect(formatCost(0.0412)).toBe("$0.0412");
    expect(formatCost(0.8814)).toBe("$0.8814");
  });

  it("should use two places once a run has cost real money", () => {
    expect(formatCost(12.5)).toBe("$12.50");
  });

  it("should render a non-finite cost as an em dash", () => {
    expect(formatCost(Number.NaN)).toBe("—");
  });
});

describe("pluralise", () => {
  it("should agree with the count", () => {
    expect(pluralise(1, "attempt")).toBe("1 attempt");
    expect(pluralise(3, "attempt")).toBe("3 attempts");
    expect(pluralise(0, "attempt")).toBe("0 attempts");
  });

  it("should take an irregular plural", () => {
    expect(pluralise(2, "try", "tries")).toBe("2 tries");
  });
});

describe("firstLine", () => {
  it("should keep a short single line intact", () => {
    expect(firstLine("Two commitments today.")).toBe("Two commitments today.");
  });

  it("should drop everything after the first newline", () => {
    expect(firstLine("first\nsecond")).toBe("first");
  });

  it("should ellipsise past the limit", () => {
    expect(firstLine("abcdef", 4)).toBe("abc…");
  });

  it("should render a null summary as nothing at all", () => {
    expect(firstLine(null)).toBe("");
  });
});
