import { describe, expect, it } from "vitest";

import {
  acPower,
  assessPower,
  describePower,
  parsePmset,
  powerProblems,
  REQUIRED_POWER_SETTINGS,
} from "../../src/ops/power.js";

/**
 * The power check, against real `pmset` output.
 *
 * Captured verbatim from the Commander's machine on 2026-08-09 — including its
 * actual, wrong values (`sleep 15`, `autorestart 0`) and the parenthetical
 * suffix that a naive split mangles. Building this fixture from our own idea of
 * the format would test the parser against itself; the whole point is to catch
 * drift between what we expect and what the tool emits.
 */
const REAL_PMSET_CUSTOM = `AC Power:
 Sleep On Power Button 1
 standbydelayhigh     86400
 standbydelaylow      86400
 proximitywake        1
 standby              1
 ttyskeepawake        1
 hibernatemode        3
 powernap             1
 gpuswitch            2
 hibernatefile        /var/vm/sleepimage
 highstandbythreshold 50
 displaysleep         0
 womp                 1
 networkoversleep     0
 sleep                15
 tcpkeepalive         1
 halfdim              1
 autorestart          0
 disksleep            10
`;

/** The same machine's `pmset -g`, where `sleep` carries a parenthetical. */
const REAL_PMSET_G = `System-wide power settings:
Currently in use:
 standby              1
 autorestart          0
 sleep                15 (sleep prevented by caffeinate, coreaudiod)
 disksleep            10
`;

/** A laptop: two sections, and only the AC one decides anything. */
const TWO_SECTIONS = `Battery Power:
 sleep                1
 autorestart          0
AC Power:
 sleep                0
 autorestart          1
`;

describe("parsePmset", () => {
  it("should read the real AC Power section", () => {
    const settings = acPower(parsePmset(REAL_PMSET_CUSTOM));
    expect(settings?.source).toBe("AC Power");
    expect(settings?.values["sleep"]).toBe("15");
    expect(settings?.values["autorestart"]).toBe("0");
  });

  it("should keep a setting whose name contains spaces", () => {
    // `Sleep On Power Button 1` — the last token is the value, everything
    // before it is the key.
    const settings = acPower(parsePmset(REAL_PMSET_CUSTOM));
    expect(settings?.values["Sleep On Power Button"]).toBe("1");
  });

  it("should drop the parenthetical pmset appends to a suppressed setting", () => {
    const settings = acPower(parsePmset(REAL_PMSET_G));
    expect(settings?.values["sleep"]).toBe("15");
  });

  it("should prefer AC Power when a machine reports both", () => {
    const settings = acPower(parsePmset(TWO_SECTIONS));
    expect(settings?.source).toBe("AC Power");
    expect(settings?.values["sleep"]).toBe("0");
  });

  it("should return nothing for output with no sections", () => {
    expect(acPower(parsePmset(""))).toBeNull();
  });
});

describe("powerProblems", () => {
  it("should object to a Mac configured to sleep", () => {
    // The Commander's machine, as found. A sleeping Mac fires no reminders.
    const problems = powerProblems(acPower(parsePmset(REAL_PMSET_CUSTOM)));
    expect(problems.join("\n")).toContain("sleep is 15");
    expect(problems.join("\n")).toContain("sudo pmset -c sleep 0");
  });

  it("should object to a Mac that stays off after a power cut", () => {
    const problems = powerProblems(acPower(parsePmset(REAL_PMSET_CUSTOM)));
    expect(problems.join("\n")).toContain("autorestart is 0");
    expect(problems.join("\n")).toContain("sudo pmset -c autorestart 1");
  });

  it("should be satisfied by the settings the runbook asks for", () => {
    expect(powerProblems(acPower(parsePmset(TWO_SECTIONS)))).toEqual([]);
  });

  it("should say so when pmset did not report a setting at all", () => {
    const problems = powerProblems({ source: "AC Power", values: { sleep: "0" } });
    expect(problems.join("\n")).toContain("autorestart");
  });

  it("should say so when there is nothing to read", () => {
    expect(powerProblems(null)).toHaveLength(1);
  });

  it("should require exactly the two settings that matter", () => {
    expect(REQUIRED_POWER_SETTINGS).toEqual({ sleep: "0", autorestart: "1" });
  });
});

describe("assessPower", () => {
  it("should check nothing on a platform with no pmset", () => {
    const assessment = assessPower({ platform: "linux" });
    expect(assessment).toEqual({ ok: true, checked: false, problems: [] });
  });

  it("should report the problems it found", () => {
    const assessment = assessPower({ platform: "darwin", read: () => REAL_PMSET_CUSTOM });
    expect(assessment.checked).toBe(true);
    expect(assessment.ok).toBe(false);
    expect(assessment.problems).toHaveLength(2);
  });

  it("should be quiet about a correctly configured machine", () => {
    const assessment = assessPower({ platform: "darwin", read: () => TWO_SECTIONS });
    expect(assessment.ok).toBe(true);
  });

  it("should not take the service down when pmset itself fails", () => {
    // A diagnostic that can stop the service is worse than no diagnostic.
    const assessment = assessPower({
      platform: "darwin",
      read: () => {
        throw new Error("spawn ENOENT");
      },
    });
    expect(assessment.ok).toBe(false);
    expect(assessment.problems[0]).toContain("ENOENT");
  });

  it("should really run pmset on this machine without throwing", () => {
    // The one case that executes the actual `execFileSync`. It asserts nothing
    // about this machine's settings — that is the Commander's to change — only
    // that the call itself works, which is the part that would otherwise first
    // run in production.
    expect(() => assessPower()).not.toThrow();
  });
});

describe("describePower", () => {
  it("should say nothing at all on a platform it cannot check", () => {
    expect(describePower({ ok: true, checked: false, problems: [] })).toEqual([]);
  });

  it("should warn once per problem, in words that name the fix", () => {
    const lines = describePower(assessPower({ platform: "darwin", read: () => REAL_PMSET_CUSTOM }));
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => line.includes("WARNING"))).toBe(true);
    expect(lines.join("\n")).toContain("pmset -c");
  });

  it("should confirm a machine that is configured correctly", () => {
    const lines = describePower(assessPower({ platform: "darwin", read: () => TWO_SECTIONS }));
    expect(lines.join("\n")).toContain("will not sleep");
  });
});
