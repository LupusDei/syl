/**
 * The app must be entitled to receive every interruption level the server sends.
 *
 * `syl-tsn`. This test exists because both halves were individually correct and
 * disagreed with each other, which is the only kind of bug this project keeps
 * producing.
 *
 * The Commander set a five minute reminder on 2026-08-10. It was created,
 * scheduled, and delivered 362ms after its due instant. He never saw it, because
 * Focus mode was on. `jobs/deliver-reminders.ts` was doing exactly the right
 * thing — every `commitment` and every urgent reminder goes out with
 * `interruptionLevel: "time-sensitive"`, the level that exists to break through
 * Focus — and `ios/Syl.entitlements` did not carry
 * `com.apple.developer.usernotifications.time-sensitive`.
 *
 * **iOS does not report that mismatch.** It accepts the notification and quietly
 * delivers it at normal priority, which Focus then suppresses. The server logged
 * `delivered`, Apple returned `ok`, the phone showed nothing, and no layer
 * anywhere recorded an error. Constraint 4 — silently lost — in precisely the
 * situation the feature exists for, since Focus is on exactly when interrupting
 * is worth doing.
 *
 * ## Why the test is shaped like this
 *
 * It reads the SOURCE rather than importing a constant, because the failure was
 * a source file and a plist disagreeing and no constant sat between them. A test
 * that imported a shared enum would have passed while the app went unsigned for
 * the capability — it would be asserting that our code agrees with itself, which
 * was never in doubt.
 *
 * So it scans for the interruption levels the server is *capable of emitting* and
 * checks each against what the shipped entitlements permit. Adding
 * `"critical"` to a payload — which needs an entitlement Apple grants by
 * individual request — fails here rather than in the Commander's pocket.
 *
 * It deliberately does NOT assert the exact set of levels in use. That would
 * break every time someone legitimately changed a reminder's urgency, which
 * teaches people to edit the test.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
// backend/tests/unit -> repo root
const root = join(here, "..", "..", "..");

/**
 * Levels that require the app to be signed for them, and the entitlement key
 * each one needs.
 *
 * `passive` and `active` need nothing — they are the defaults every app may
 * send. The two below are the ones Apple gates, and they are gated precisely
 * because they interrupt someone.
 */
const NEEDS_ENTITLEMENT: Readonly<Record<string, string>> = {
  "time-sensitive": "com.apple.developer.usernotifications.time-sensitive",
  critical: "com.apple.developer.usernotifications.critical-alerts",
};

/** Every interruption level this source file is capable of putting on the wire. */
function levelsEmittedBy(relativePath: string): readonly string[] {
  const source = readFileSync(join(root, relativePath), "utf8");
  const found = new Set<string>();
  // `interruptionLevel:` followed by a literal, or by a ternary containing them.
  // Matching the literals directly rather than parsing the expression: the
  // question is "can this string reach APNs from here", and a string that is
  // never reachable is a dead literal somebody should delete anyway.
  for (const match of source.matchAll(/interruptionLevel[\s\S]{0,120}?/g)) {
    const window = source.slice(match.index, match.index + 160);
    for (const level of Object.keys(NEEDS_ENTITLEMENT)) {
      if (window.includes(`"${level}"`)) found.add(level);
    }
  }
  return [...found];
}

describe("entitlements match the notifications we send", () => {
  const entitlements = readFileSync(join(root, "ios", "Syl.entitlements"), "utf8");

  it("should be signed for every gated interruption level the reminder path can emit", () => {
    const emitted = levelsEmittedBy("backend/src/jobs/deliver-reminders.ts");

    // A guard on the guard. If this file stops finding anything, the regex has
    // drifted away from the source and the test would pass vacuously — which is
    // the failure mode it was written to prevent.
    expect(
      emitted.length,
      "found no gated interruption levels in deliver-reminders.ts — either the " +
        "reminder path stopped sending them, or this test stopped being able to see them",
    ).toBeGreaterThan(0);

    for (const level of emitted) {
      const key = NEEDS_ENTITLEMENT[level]!;
      expect(
        entitlements.includes(key),
        `The server sends interruptionLevel "${level}" but ios/Syl.entitlements does ` +
          `not declare ${key}. iOS will NOT reject this — it downgrades the ` +
          `notification to normal priority in silence, and Focus mode suppresses it. ` +
          `Add the key, enable the capability on the App ID so the provisioning ` +
          `profile carries it, and ship a build.`,
      ).toBe(true);
    }
  });

  it("should not claim an entitlement the app never exercises", () => {
    // The mirror of the rule above, and the reason it matters here specifically:
    // critical alerts require Apple to approve the App ID by hand, and asking for
    // a capability we do not use is how a build gets rejected for a feature
    // nobody remembers requesting.
    const emitted = new Set(levelsEmittedBy("backend/src/jobs/deliver-reminders.ts"));

    for (const [level, key] of Object.entries(NEEDS_ENTITLEMENT)) {
      if (emitted.has(level)) continue;
      expect(
        entitlements.includes(key),
        `ios/Syl.entitlements declares ${key}, but nothing in the reminder path ` +
          `sends interruptionLevel "${level}". Remove the entitlement or send the level.`,
      ).toBe(false);
    }
  });
});
