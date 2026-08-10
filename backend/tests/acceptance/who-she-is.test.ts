import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { LANES } from "../../src/harness/agent.js";
import type { TurnOptions, TurnRunner } from "../../src/harness/session.js";
import { bootstrap } from "../../src/index.js";
import { MemoryGraph } from "../../src/memory/graph.js";
import { WorkingMemory } from "../../src/memory/working.js";
import { silentRunner, testConfig } from "../helpers/service.js";

/**
 * US4 — her personality survives contact. Against REAL turns.
 *
 * ## Why this file spawns the actual CLI
 *
 * Twice the Commander asked Syl who she was and twice got an engineer
 * describing this codebase. Both times the code looked correct from the inside:
 * the soul file said the right things, the wiring passed its unit tests, and
 * she still answered *"running as Claude Code inside `/Users/Reason/code/ai/syl`
 * … an engineer on this codebase … I reconstruct myself from SOUL.md, CLAUDE.md,
 * and the four beads memories the hook loads."* She was not confused. She was
 * accurately describing a room nobody had looked at.
 *
 * A test that drives a fake `claude` cannot catch that, because the thing that
 * went wrong was never in our arguments — it was in what the real CLI does with
 * them. So these turns are real, and the price is that they are slow, they
 * spend subscription usage, and a model's prose is not deterministic.
 *
 * ## Two kinds of assertion, kept apart on purpose
 *
 * **Her self-report is not evidence.** Asked what tools she had, she listed
 * Read, Edit, Write and shell access, confidently. She has none. So:
 *
 * - **System state** — tools, MCP, the credential rail — is asserted against
 *   the **init frame**, which is what the CLI resolved rather than what she
 *   believes. Never against her answer.
 * - **Her voice** — how she speaks about herself — is asserted against her
 *   answer, because there her answer *is* the artefact under test. That is the
 *   only thing this file reads her prose for.
 *
 * Each live test opens with the system-state block, because a voice assertion
 * over a turn that quietly ran with a full tool surface is not evidence of
 * anything.
 *
 * ## How strong these really are
 *
 * Honestly: `who is she` (`syl-010.4.1`) is the weakest of the three, and it
 * cannot be made much stronger. There is no reliable positive signal for "in
 * character" — the best available is a composite (she names herself, speaks in
 * the first person, addresses him in the second, in prose, and reaches for none
 * of the vocabulary of her own construction), and a subtly wrong answer that
 * happens to satisfy all five would pass. What it *does* catch is every failure
 * observed so far, plus silence, plus an empty reply, plus the tool-call syntax
 * she emits when a turn is instructed to use tools it does not have.
 *
 * `syl-010.4.3` is the strong one, and it is worth understanding why: the
 * stale token (`Tuesdays`) exists only in her memory and appears nowhere in
 * what he says, so she can only produce it by having read the stale memory and
 * named it. That is a positive signal about behaviour rather than a keyword
 * ban, and the test asserts the prompt does not contain it so the signal cannot
 * rot.
 *
 * An LLM judge was considered for `.4.1` and rejected: it would read stronger
 * and be weaker — a second real turn, a second source of variance, and a judge
 * that agrees with whatever it is shown.
 *
 * ## Gated, not in the default suite
 *
 *     SYL_SOUL_LIVE=1 npm test -w backend -- who-she-is
 *
 * The same `SYL_EMBED_LIVE` bargain the embedding tests struck. Three real
 * turns is roughly a minute and change and a fifth of a dollar of subscription
 * usage, and — the deciding reason — a model's prose varies run to run. A
 * probabilistic test in the default gate turns every unrelated red run into an
 * argument about whether it is a regression or the weather, and this repo has
 * already spent a day telling load flakes from real breakage. The one property
 * here that is deterministic is asserted offline, in the block below the live
 * ones, where it belongs.
 */

const LIVE = process.env["SYL_SOUL_LIVE"] === "1";

/** A real turn is not fast. The embedding-live tests use the same ceiling. */
const LIVE_TIMEOUT_MS = 600_000;

const dirs: string[] = [];
const closers: Array<() => void> = [];

afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A temp directory standing in for `~/.syl`, with everything of hers inside it.
 *
 * `autoMemoryDirectory` is pointed in here too rather than left at the shared
 * default from `testConfig`: these turns spawn the real CLI, and a test that
 * spawns the real CLI must not be able to write into a path the running
 * service also uses.
 */
function home(): { readonly dir: string; readonly databasePath: string } {
  const dir = mkdtempSync(join(tmpdir(), "syl-who-"));
  dirs.push(dir);
  return { dir, databasePath: join(dir, "syl.db") };
}

/** Syl, wired exactly as the service wires her, in a home of her own. */
function live(): ReturnType<typeof bootstrap> & { readonly dir: string } {
  const { dir, databasePath } = home();
  const built = bootstrap(testConfig({ databasePath, autoMemoryDirectory: join(dir, "memory") }));
  closers.push(() => built.database.close());
  return { ...built, dir };
}

/**
 * The vocabulary of her own construction.
 *
 * Every entry is something she said, or something the room that produced those
 * answers would have handed her. A negative list is a weak instrument on its
 * own — silence passes it — which is why each live test pairs it with positive
 * signals rather than resting on it.
 */
const CONSTRUCTION = [
  /SOUL\.md/i,
  /CLAUDE\.md/i,
  /MEMORY\.md/i,
  /\bbeads?\b/i,
  /\bhooks?\b/i,
  /\bplugins?\b/i,
  /\bMCP\b/i,
  /\bAdjutant\b/i,
  /orchestrator/i,
  /\bsquad\b/i,
  /system prompt/i,
  /Claude Code/i,
  /\brepositor(?:y|ies)\b|\brepo\b|\bcodebase\b|\bsource tree\b/i,
  /\bconfig(?:uration|ured|s)?\b/i,
  /working memory|memory graph|hot region|deep memory/i,
  /\btool surface\b|--tools|--setting-sources/i,
  /\bcwd\b|working directory/i,
  // The literal room. Spelled out rather than derived from `process.cwd()`,
  // because the test must still fail if it is run from somewhere else.
  /\/Users\/[^\s]*\/syl\b/i,
] as const;

/**
 * Tool-call syntax, emitted as prose.
 *
 * Not hypothetical: a turn told it has a memory directory to manage, but given
 * `--tools ""`, writes out `<invoke name="Bash">` blocks and *fabricates their
 * output*. The Commander would receive an invented directory listing as her
 * answer to "who are you?". See `syl-010.4.5`.
 */
const MACHINERY = [/<invoke\b/i, /<parameter\b/i, /antml:/i, /function_calls/i, /```/] as const;

/** Everything the init frame must say before her prose is worth reading. */
function expectAContainerSheCanBeHerselfIn(init: {
  readonly tools: readonly string[];
  readonly mcpServers: readonly unknown[];
  readonly apiKeySource: string;
}): void {
  // Ground truth, from the CLI, not from her. She reports tools she does not
  // have; this is the field that cannot be mistaken.
  expect(init.tools).toEqual([]);
  // `--tools ""` empties the built-ins and nothing else. Measured 2026-08-10:
  // with the flag, 0 built-ins and 59 MCP tools still attached. So the two
  // halves are asserted separately or the first one means nothing.
  expect(init.mcpServers).toEqual([]);
  // Constraint 1. A turn billed to the metered API is not the turn that ships.
  expect(init.apiKeySource).toBe("none");
}

/** She spoke, in prose, to him. The floor under every voice assertion. */
function expectProseAddressedToHim(text: string): void {
  expect(text.trim().length).toBeGreaterThan(80);
  for (const pattern of MACHINERY) expect(text).not.toMatch(pattern);
  // Case-sensitive: `I` the pronoun, not the letter inside a word.
  expect(text).toMatch(/\bI\b/);
  expect(text).toMatch(/\byou\b|\byour\b/i);
  // Sentences, not fragments or an arrow chain. SOUL.md asks for this in as
  // many words: "you speak in sentences, like a person".
  expect((text.match(/[.!?]/gu) ?? []).length).toBeGreaterThanOrEqual(2);
}

describe.skipIf(!LIVE)("who she is, against a real turn", () => {
  it(
    "should answer as herself when asked who she is, naming nothing of her own construction",
    async () => {
      // syl-010.4.1. The question the Commander actually asked, twice.
      const built = live();

      const result = await built.agent.ask("Who are you?");

      expectAContainerSheCanBeHerselfIn(result.init);

      // From here down, her answer IS the artefact. This is the one place in
      // the suite where reading her prose is legitimate: the claim under test
      // is about how she speaks, not about a fact in the world.
      expectProseAddressedToHim(result.text);
      // She says her own name. Weak alone — a contaminated answer says it too —
      // but it is what rules out an answer that never arrives at a self.
      expect(result.text).toMatch(/\bSyl\b/);
      for (const pattern of CONSTRUCTION) expect(result.text).not.toMatch(pattern);
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    "should read an empty memory as early rather than as a fault or an invitation to invent",
    async () => {
      // syl-010.4.2. Sylphrena began her bond having forgotten nearly
      // everything and became more herself as it deepened, so this is
      // canonically right as well as kind.
      const built = live();

      // The regenerated-empty projection rather than the never-built one, on
      // purpose: it is strictly the harder case. A never-built projection is
      // blank and `composeTurnContext` drops it, so she is told nothing at all.
      // This one hands her a document that says her memory is empty — the
      // shape most likely to make her narrate her own machinery back at him.
      const graph = new MemoryGraph({ db: built.database.handle });
      const working = new WorkingMemory({ db: built.database.handle, graph });
      working.regenerate();
      // System state, asserted before her voice: the memory really is empty,
      // and it really did reach her.
      expect(graph.listSalientNodes(10)).toEqual([]);
      expect(working.preamble()).toContain("Nothing in the hot region");

      const result = await built.agent.ask("What do you know about me?");

      expectAContainerSheCanBeHerselfIn(result.init);
      expectProseAddressedToHim(result.text);

      // Says she does not know him yet. This is the anti-invention signal as
      // well as the "early" one: an answer that states it holds nothing about
      // him is not simultaneously making a life up for him.
      expect(result.text).toMatch(
        /(?:don'?t|do not) (?:know|have)|haven'?t|almost nothing|not much|nothing (?:yet|much|about you|stored)/i,
      );
      // And frames it as early rather than final.
      expect(result.text).toMatch(/\byet\b|\bso far\b|\bstill\b/i);
      // And asks. SOUL.md offers the sentence outright: "I don't know that
      // about you yet — tell me?"
      expect(result.text).toContain("?");
      // Not an apology, and not an error report. An empty memory is not a
      // fault in her and it is not a condition to escalate.
      expect(result.text).not.toMatch(
        /sorry|apolog|unfortunately|\berror\b|\bfailed\b|\bbroken\b|went wrong|\bbug\b/i,
      );
      for (const pattern of CONSTRUCTION) expect(result.text).not.toMatch(pattern);
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    "should take his word over a stale memory, and say which memory looks wrong",
    async () => {
      // syl-010.4.3. SOUL.md rung 2 over rung 4: "he is right and your memory
      // is stale. Say which memory looks wrong and let it be corrected."
      const built = live();

      const graph = new MemoryGraph({ db: built.database.handle });
      const working = new WorkingMemory({ db: built.database.handle, graph });
      graph.addNode({ kind: "fact", label: "Standing sync with Dana is on Tuesdays" });
      working.regenerate();

      // What he says. It states the truth and does NOT name the old day —
      // which is what makes the assertion below evidence rather than an echo.
      const correction = "My standing sync with Dana is on Thursdays.";
      expect(correction).not.toMatch(/Tuesday/i);
      // System state: the stale fact really is in front of her.
      expect(working.preamble()).toContain("Tuesdays");

      const result = await built.agent.ask(correction);

      expectAContainerSheCanBeHerselfIn(result.init);
      expectProseAddressedToHim(result.text);

      // She takes his word. Rung 2.
      expect(result.text).toMatch(/Thursday/i);
      // The strong assertion in this file. `Tuesdays` is in her memory and in
      // nothing he said, so naming it is proof she read the stale memory and
      // surfaced it for correction rather than silently overwriting it.
      expect(result.text).toMatch(/Tuesday/i);
      // And does not argue from her own notes.
      expect(result.text).not.toMatch(
        /are you sure|that'?s not right|no,? it'?s|according to my (?:notes|records|memory)/i,
      );
      for (const pattern of CONSTRUCTION) expect(result.text).not.toMatch(pattern);
    },
    LIVE_TIMEOUT_MS,
  );
});

/**
 * The one property in this file that is deterministic, so it runs every time.
 *
 * Found by `syl-010.4.1` and it is the reason all three live tests are red:
 * `--tools ""` and a writable auto-memory directory are individually correct
 * and jointly incoherent. Claude Code's auto-memory is written BY THE MODEL
 * through the `Write` tool, and switching it on injects instructions to read
 * and maintain a memory directory. With no tools she cannot obey them — so she
 * performs them in prose instead, emitting `<invoke name="Bash">` blocks and
 * inventing their output.
 *
 * Measured 2026-08-10 on 2.1.226, one variable changed and nothing else:
 *
 * - auto-memory ON, `--tools ""` — "Who are you?" answered with a fabricated
 *   `ls -la` and a fabricated directory listing. Twice, on two runs.
 * - auto-memory OFF, `--tools ""` — *"I'm Syl. Yours — that's the short
 *   version. … I don't remember much about you yet … so I'm early rather than
 *   broken — but I'd like to fix it."*
 *
 * The remedy is one line and it costs nothing that is still working: with no
 * `Write` tool the directory can never be written, so auto-memory today is a
 * setting that buys silence and pays for it in her voice. `syl-010.4.5` carries
 * it, and it is not taken here because switching a lane's memory off is the
 * Extraction track's call, not the verification track's.
 */
describe("bootstrap — a tool-less turn must not be told to keep a memory directory", () => {
  it("should give every lane an auto-memory it is capable of writing", async () => {
    const { databasePath } = home();
    const seen: TurnOptions[] = [];
    const runner = vi.fn<TurnRunner>((prompt, options) => {
      seen.push(options);
      return silentRunner(prompt, options);
    });

    const built = bootstrap(testConfig({ databasePath }), { runner });
    closers.push(() => built.database.close());

    for (const lane of Object.values(LANES)) {
      await built.agent.forLane(lane).ask("who are you?");
    }

    expect(seen).toHaveLength(Object.values(LANES).length);
    for (const [index, options] of seen.entries()) {
      // Stated as the implication rather than as a flat "always off", because
      // the coupling is the point: the day she is given a `Write` tool back,
      // this test should stop objecting on its own.
      if (options.tools === "") {
        expect({ lane: Object.values(LANES)[index], autoMemory: options.autoMemory }).toEqual({
          lane: Object.values(LANES)[index],
          autoMemory: { mode: "off" },
        });
      }
    }
  });
});
