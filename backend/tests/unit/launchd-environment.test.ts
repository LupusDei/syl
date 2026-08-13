import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Every variable the service READS must be a variable the installer FORWARDS.
 *
 * The plist is generated from one list in `ops/cli/launchd.ts`, and a name
 * missing from that list does not fall back to a default — it vanishes. The
 * service then boots with the variable unset and behaves exactly as though the
 * feature were switched off, which is indistinguishable from it being unbuilt.
 *
 * That is not hypothetical. `SYL_ADJUTANT_URL` was absent, so `config.adjutant`
 * was null on the installed service however the shell was configured,
 * `ToolContext.fleet` was undefined, and every `ask_agent` answered *"I have no
 * way to reach the others right now."* The verb, the roster and the client were
 * all built and correct; the variable that switches them on never reached the
 * process. Nothing reported it, because an unforwarded name produces silence.
 *
 * Editing the installed plist by hand does not fix it either: the next install
 * regenerates the file from this same list.
 *
 * The test reads both files as TEXT rather than importing them. `cli/launchd.ts`
 * does its work at module scope — importing it would write a plist.
 */
const here = fileURLToPath(new URL(".", import.meta.url));
const src = join(here, "..", "..", "src");

const CONFIG = readFileSync(join(src, "config.ts"), "utf8");
const INSTALLER = readFileSync(join(src, "ops", "cli", "launchd.ts"), "utf8");

/** Every `SYL_*` name the config layer reads out of the environment. */
function namesConfigReads(): readonly string[] {
  const found = new Set<string>();
  for (const match of CONFIG.matchAll(/read\(\s*env\s*,\s*"(SYL_[A-Z0-9_]+)"/g)) {
    const name = match[1];
    if (name !== undefined) found.add(name);
  }
  return [...found].sort();
}

/** Every name the installer copies from the shell into the plist. */
function namesInstallerForwards(): readonly string[] {
  // Anchored on `= [`, not on the first `[`. The declaration's own type is
  // `readonly string[]`, whose brackets are closer — matching those captured an
  // empty list and made this scan silently find nothing.
  const block = /FORWARDED_ENV[^=]*=\s*\[([^\]]*)\]/s.exec(INSTALLER);
  if (block === null || block[1] === undefined) {
    throw new Error("FORWARDED_ENV is not a literal array in ops/cli/launchd.ts — this test reads it as text");
  }
  return [...block[1].matchAll(/"(SYL_[A-Z0-9_]+)"/g)]
    .map((m) => m[1])
    .filter((name): name is string => name !== undefined)
    .sort();
}

/** Names the plist generator writes itself, rather than copying from a shell. */
function namesGeneratorSets(): readonly string[] {
  const generator = readFileSync(join(src, "ops", "launchd.ts"), "utf8");
  return [...generator.matchAll(/^\s*(SYL_[A-Z0-9_]+):/gm)]
    .map((m) => m[1])
    .filter((name): name is string => name !== undefined);
}

/**
 * Variables allowed to be absent from the installed service, each because its
 * default is the correct production behaviour rather than a disabled feature.
 *
 * This list is deliberately explicit. Adding a name here is a decision that a
 * variable going missing is harmless — which is exactly the judgement nobody
 * made about `SYL_ADJUTANT_URL`.
 */
const MAY_BE_ABSENT: Readonly<Record<string, string>> = {
  SYL_ATTACHMENT_DIR: "defaults under ~/.syl, which is where attachments belong",
  SYL_APNS_ALLOW_SANDBOX: "a development escape hatch; production must not set it",
};

describe("the installed service's environment", () => {
  it("should get every SYL_ variable the config layer reads, or declare it safe to omit", () => {
    const supplied = new Set([...namesInstallerForwards(), ...namesGeneratorSets()]);

    // Named, not counted. A missing name and a substituted one are different
    // failures and the message has to say which.
    const dropped = namesConfigReads().filter(
      (name) => !supplied.has(name) && MAY_BE_ABSENT[name] === undefined,
    );
    expect(
      dropped,
      `read by config.ts and never reaching the installed service: ${dropped.join(", ")}. ` +
        "Forward it in ops/cli/launchd.ts, or add it to MAY_BE_ABSENT with the reason its default is correct.",
    ).toEqual([]);
  });

  it("should have found something to check, so a broken scan cannot pass quietly", () => {
    // Both halves: a regex that matches nothing would make the assertion above
    // vacuously true, which is the failure this whole file exists to prevent.
    expect(namesConfigReads().length).toBeGreaterThan(5);
    expect(namesInstallerForwards().length).toBeGreaterThan(5);
  });

  it("should forward the fleet variables, which is the case that was missing", () => {
    const forwarded = new Set(namesInstallerForwards());
    expect(forwarded.has("SYL_ADJUTANT_URL")).toBe(true);
    expect(forwarded.has("SYL_ADJUTANT_AGENT_ID")).toBe(true);
  });
});
