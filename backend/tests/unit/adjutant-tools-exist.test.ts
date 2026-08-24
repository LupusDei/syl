import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ADJUTANT_TOOLS } from "../../src/agents/adjutant-client.js";

/**
 * **Our two halves shipped separately, and nothing noticed for a day.**
 *
 * ## The defect this guard exists for
 *
 * `AdjutantClient.ask` calls `direct_message`. The running Adjutant does not
 * register it, so every `ask_agent` failed — seven attempts, hourly, 19:55
 * through 00:11 — with findings queued behind them that could not get out.
 *
 * **Syl's client is not wrong.** It calls the right tool, for the reason
 * documented at the call site, with the right arguments. `direct_message` is
 * built, tested and correct — on the Adjutant branch
 * `feat/syl-j8fa-direct-message`, six commits, merging to main with zero
 * conflicts. Adjutant's main has the delivery *service* and the *skill
 * document*, and `messaging.ts` registers the tool **zero** times. One half of
 * a feature shipped and the other half did not.
 *
 * That is what makes this different from the vendor guard it is modelled on.
 * `face-page-vendor-props.test.ts` catches *the vendor changed under us*. This
 * catches *we changed only one side of ourselves*, which is the eighth
 * instance today of calling something the other side does not have and the
 * first where the other side is our own system. No compiler, no lockfile and
 * no type can see across that gap: two services, two deploys, one string.
 *
 * It was red for exactly as long as that was true, declared against
 * `syl-uqfy`, and went green when Adjutant merged the branch and restarted —
 * the fixture below is the re-capture that recorded it, 63 tools becoming 64.
 * That is the shape this guard is meant to have: it states what should be true,
 * stays red while it is not, and is resolved by fixing reality.
 *
 * ## Refreshing the fixture, and why that is not a way to cheat
 *
 * **Adjutant is ours and it changes under us.** That makes this fixture
 * different from the vendor declaration `face-page-vendor-props.test.ts`
 * captures: it goes stale in the ordinary course of work, so it will need
 * re-capturing, and a fixture that needs regular regeneration invites "just
 * regenerate it" as the reflex for making red go away.
 *
 * Here that reflex is harmless, and structurally so rather than by discipline.
 * The fixture is captured FROM A LIVE ADJUTANT, so regenerating it against an
 * Adjutant that lacks the tool reproduces exactly the same red. **Regeneration
 * tracks reality; it cannot fake it.** The refresh is the correct response to
 * this test failing *and* it is incapable of hiding a genuine break — those
 * are the same command, which is what makes the guard safe to hand to someone
 * in a hurry.
 *
 *     node backend/scripts/capture-adjutant-tools.mjs        # Adjutant on :4201
 *
 * The capture refuses to write an empty or non-Adjutant list, so a failed
 * capture cannot quietly produce a fixture that makes every assertion here
 * vacuous by having nothing to check.
 *
 * The one thing that WOULD break all of this is hand-editing the JSON. Don't.
 * It is captured output in the sense this project already means, and a
 * hand-written fixture asserts our idea of Adjutant against our idea of
 * Adjutant.
 *
 * ## What appearing in the fixture does NOT prove
 *
 * That she may CALL it. `tools/list` is not filtered by caller, and Adjutant
 * gates some tools on identity — `nudge_agent` is advertised to everyone and
 * answers *"Coordination tools are restricted to the adjutant agent"* for Syl,
 * verified live on 2026-08-24. So this catches a tool that does not exist,
 * which is the failure that happened. It cannot catch one that exists and
 * refuses her, and nothing here should be read as claiming it does.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

interface ToolsFixture {
  readonly capturedFrom: string;
  readonly capturedAt: string;
  readonly serverName: string | null;
  readonly serverVersion: string | null;
  readonly capturedAs: string;
  readonly toolNames: readonly string[];
}

const fixture = JSON.parse(
  readFileSync(path.join(HERE, "..", "fixtures", "adjutant-tools-list.json"), "utf8"),
) as ToolsFixture;

const CLIENT_SOURCE = readFileSync(
  path.join(HERE, "..", "..", "src", "agents", "adjutant-client.ts"),
  "utf8",
);

describe("the Adjutant tools Syl calls", () => {
  it("should have been captured from a real Adjutant, with tools in it", () => {
    // A fixture that is an error page, an empty list, or somebody's guess makes
    // every assertion below vacuous. Checked against a name known to be there
    // rather than only a length, so a file of 63 empty strings still fails.
    expect(fixture.serverName).toBe("adjutant");
    expect(fixture.toolNames.length).toBeGreaterThan(10);
    expect(fixture.toolNames).toContain("send_message");
  });

  it("should have been captured as SYL, not as the coordinator", () => {
    // Identity decides the surface on some of Adjutant's tools. A capture taken
    // as `adjutant` would record a surface she cannot reach, and would make
    // this guard attest to the wrong thing.
    expect(fixture.capturedAs).toBe("syl");
  });

  it("should name at least one tool, so an empty constant cannot pass", () => {
    // `[].every(...)` is true. An `ADJUTANT_TOOLS` that lost its entries would
    // sail through the assertion below while the client called whatever it
    // liked.
    expect(Object.values(ADJUTANT_TOOLS).length).toBeGreaterThan(0);
  });

  it("should be the only names the client can reach tools/call with", () => {
    // The constant is worth checking only if it is what the code uses. A bare
    // literal at a call site would bypass every assertion in this file, so the
    // source is scanned the way `quiet-window.test.ts` scans for a second
    // window literal: a module may USE the constant; a module that writes a
    // tool name down beside it is declaring a second surface.
    const literals = [...CLIENT_SOURCE.matchAll(/#callTool\(\s*["'`]([^"'`]+)["'`]/gu)].map(
      (match) => match[1],
    );

    expect(
      literals,
      `adjutant-client.ts passes ${literals.join(", ")} to #callTool as a bare string. Route it ` +
        "through ADJUTANT_TOOLS so the guard in this file can see it.",
    ).toEqual([]);
  });

  it("should every one of them be advertised by Adjutant", () => {
    // THE assertion. Red for a day while `direct_message` sat unmerged, green
    // since Adjutant landed it. If this fails, the question to ask is not "is
    // our name wrong" — it may well be right, as it was that whole day — but
    // "has the other half shipped?"
    const advertised = new Set(fixture.toolNames);
    const missing = Object.values(ADJUTANT_TOOLS).filter((name) => !advertised.has(name));

    expect(
      missing,
      `Syl calls ${missing.join(", ")}, which Adjutant ${String(fixture.serverVersion)} at ` +
        `${fixture.capturedFrom} does not advertise (captured ${fixture.capturedAt}). Every ` +
        `ask_agent using it fails with an unknown-tool error. If Adjutant has since merged the ` +
        `tool, re-capture: node backend/scripts/capture-adjutant-tools.mjs`,
    ).toEqual([]);
  });
});
