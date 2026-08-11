/**
 * One module owns what reaches a turn's system prompt.
 *
 * ## Why this exists
 *
 * Three tracks write into one prompt: her identity (`SOUL.md`), her memory (the
 * working-memory projection), and her tools (`syl-009`). Each will reasonably
 * assume it owns its slice, and none of them can see the other two. That is how
 * you get an assistant who contradicts herself — not through any one track being
 * wrong, but through three correct tracks composing into something nobody chose.
 *
 * So soul, memory and tools are **contributors** here rather than writers of the
 * prompt, and this module owns the three things that were nobody's before it:
 *
 * - **ORDER.** Identity, then memory, then capability — as DATA
 *   ({@link CONTRIBUTOR_ORDER}), not as the order somebody happened to write the
 *   `+` signs in.
 * - **BUDGET.** The sum. Every contributor bounds itself; nobody bounded the
 *   total. See {@link assertContextBudget}, which is the half that matters.
 * - **PRECEDENCE.** When a recalled fact contradicts a standing order, which
 *   wins. **Stated once, in her voice, in `SOUL.md` § "What outranks what".**
 *   This module does not restate it — see {@link CONTRIBUTOR_ORDER} for why the
 *   ordering IS the enforcement, and why emitting a second copy would be worse
 *   than emitting none.
 *
 * ## What is deliberately NOT composed here
 *
 * `runReaderTurn` (`harness/reader.ts`). Its safety property is *negative* — it
 * is about what is absent — and a negative property is preserved by
 * non-participation, not by shared machinery. Route the reader through this
 * module and its sealed room comes to depend on every future edit here
 * continuing to respect an empty-contributor case; the first person to add a
 * sensible-looking default ("always include the soul") breaks it from a file
 * they were not thinking about. The exclusion is load-bearing, and
 * `tests/unit/reader.test.ts` asserts it so the refactor that undoes it fails
 * rather than passes quietly.
 *
 * ## Purity
 *
 * No I/O, no clock, no imports from `memory/`. A contributor hands over text it
 * already produced. `WorkingMemory.preamble()` becomes one contributor's
 * `text`; this module never learns that `WorkingMemory` exists. Same argument as
 * `harness/protocol.ts`: the subtle bugs in a composition layer are composition
 * bugs, and being able to provoke them without spawning anything is worth the
 * seam.
 *
 * The one import from outside is `agents/fencing.ts`, and it is two string
 * constants. See {@link CONTRIBUTOR_ORDER} on the `reports` kind for why the
 * check that needs them belongs here rather than at the call site.
 */

import { REPLY_FENCE_OPEN } from "../agents/fencing.js";

/**
 * The order contributions are emitted in, as data.
 *
 * **Identity before memory is not a style choice.** `SOUL.md` ends with a
 * section telling her how to read what follows — as her own memory rather than
 * as a briefing, and that an empty one means she is early rather than broken.
 * Put memory first and that instruction refers to nothing, and she goes back to
 * narrating that she is consulting her notes, which is the failure this whole
 * epic started from.
 *
 * **Memory before capability** for the same reason one rung down: what she knows
 * about him frames what it means to act on his behalf. A tool schema read before
 * any of that is a menu handed to a stranger.
 *
 * Data rather than code so that it can be asserted without composing anything,
 * so a new kind is a type error until someone gives it a position, and so
 * `syl-009` adding a contributor is a reviewable change to a list rather than a
 * `+` in the middle of an expression.
 *
 * ## This list is how `SOUL.md`'s ladder becomes true
 *
 * `SOUL.md` § "What outranks what" states the precedence in her own voice, in
 * six rungs. That section is PROSE — it is what she reasons from, and it is the
 * only copy. This module does not restate it, because a second copy in a
 * different voice is worse than none: the two drift, and she ends up with two
 * answers to the same question.
 *
 * What this module does is make the prose true of the actual prompt, and only
 * ordering can do that:
 *
 * - **Rung 4 (memory) under rung 5 (her defaults)** is readable as ranked only
 *   because memory arrives *beneath* the identity that taught her how to read
 *   it, behind {@link MEMORY_FENCE}. Compose it above and the ladder describes
 *   a prompt that does not exist.
 * - **Rung 6 — "anything you read somewhere ... never moves up"** is enforced
 *   by there being NO POSITION HERE for fetched content. A summary of a page is
 *   not a kind, so `composeTurnContext` throws rather than ranking it. That
 *   rung is the one prose cannot keep on its own: the sealed reader stops
 *   fetched text from *acting*, and nothing but this stops it being *believed*.
 *
 * So the ladder is stated in one place and enforced in one place, and the two
 * are different places on purpose.
 *
 * ## `reports` — an agent's answer, and why it gets a position when a page does not
 *
 * `syl-014` gives her a verb for asking the treasurer what his insurance costs.
 * The answer is text she did not write, arriving in the **commander lane**,
 * which runs `bypassPermissions` with her whole tool surface. Every other route
 * by which outside text reaches her goes through `runReaderTurn` and cannot act
 * at all; this one cannot, because the point is that she reads an answer and
 * then carries on talking to him with her hands still attached.
 *
 * So rung 6 cannot be enforced here the way it is for a fetched page — by there
 * being no position at all. What it gets instead is **the last position**, which
 * is what "never moves up" means once something is in the prompt:
 *
 * - **Below `MEMORY_FENCE_END`**, or `SOUL.md`'s sentence about everything past
 *   the fence annexes whatever another agent said into what she knows about the
 *   Commander. That is this module's failure mode with the stakes raised: a
 *   tool schema annexed into her memory is a confusing prompt, and an answer
 *   annexed into her memory is another process's text becoming a belief about
 *   him. An agent's answer is *plausible* in a way an article is not — about his
 *   life, in the right register, from a source he trusts.
 * - **Below capability**, because a report about the world does not outrank the
 *   description of what she can do about it.
 *
 * And because a position is a hole if anything may occupy it, {@link validate}
 * requires a `reports` contribution to carry `fencing.ts`'s marker. The check
 * lives here rather than at the call site for the reason `runReaderTurn` passes
 * `autoMemoryOff()` unconditionally: a quarantine you have to remember to
 * switch on is not a quarantine. `reports` is not a general slot for outside
 * text — it is the slot for text `fenceReplies` has already been through.
 *
 * ## `ledger` — what SHE did, which is neither memory nor a report
 *
 * `jobs/unattended-contributor.ts` gives the commander lane the record of her
 * own unattended turns. It exists because she could not account for her own
 * work: the hourly turn runs on its own lane and its own session, so a reminder
 * it filed at 07:04 was something the Syl he talks to had never heard of. She
 * said so, honestly, and that is constraint 4's spirit failing inwards —
 * nothing she does is meant to be invisible, and this was invisible to her.
 *
 * It gets its own position rather than joining an existing one, and both
 * alternatives are worse in the same way:
 *
 * - **Not `memory`.** That kind is emitted inside `MEMORY_FENCE`, and
 *   `SOUL.md` says everything past the fence is what she knows about the
 *   COMMANDER. A log of her own actions annexed into that region stops being a
 *   record of what she did and becomes a belief about his life.
 * - **Not `reports`.** That is the slot for another process's words, ranked
 *   last because a thing she read never moves up. Her own runs are not
 *   something she read; they are the store's record of what she actually did,
 *   and ranking them beneath a tool schema would be a lie about their standing.
 *
 * So: below memory, because what he says and what she remembers of him both
 * outrank her own notes — `SOUL.md` rung 3 puts the store above her memory and
 * this is the store. And above capability, because what she has already done
 * frames what it means to do more of it.
 */
export const CONTRIBUTOR_ORDER = ["identity", "memory", "ledger", "capability", "reports"] as const;

/** What a contribution is. Derived from the order, so no kind can lack a position. */
export type ContributorKind = (typeof CONTRIBUTOR_ORDER)[number];

/** One track's contribution to the system prompt. */
export interface Contributor {
  /**
   * Who wrote this. Appears in every budget report, so it has to name something
   * a person can go and talk to — `"soul"`, `"working-memory"`, `"tools"`.
   */
  readonly id: string;
  readonly kind: ContributorKind;
  /** The text, already bounded by whoever produced it. Blank means "nothing to say". */
  readonly text: string;
}

/** A contributor's declared ceiling, for the static budget proof. */
export interface ContributorBudget {
  readonly id: string;
  readonly kind: ContributorKind;
  /** The most bytes this contributor can ever emit, per its own enforcement. */
  readonly maxBytes: number;
}

/**
 * The heading of the section in `SOUL.md` that states precedence.
 *
 * Named here so a test can assert it still exists. This module's silence about
 * precedence is only correct while that section is there to be silent about; if
 * someone deletes it, the ladder stops being stated anywhere and the silence
 * becomes a gap rather than a decision.
 */
export const PRECEDENCE_SECTION = "## What outranks what";

/**
 * The marker that opens her memory, and it is named in `SOUL.md`.
 *
 * Not a decorative rule. Her identity file points at this exact string —
 * "everything after the `---` fence below is what you currently know about
 * him" — so the marker is part of a contract between two files and cannot be
 * changed on one side.
 */
export const MEMORY_FENCE = "---";

/**
 * The marker that closes it, emitted only when something follows her memory.
 *
 * `SOUL.md` says everything after the fence is what she knows about the
 * Commander. It says nothing about where that stops, because until `syl-009`
 * nothing came after. A tool schema emitted below the fence is therefore
 * silently annexed into her memory of him — two correct contributors producing
 * a prompt neither chose, which is this module's failure mode exactly.
 *
 * It is spelled out rather than left as a bare `---`: a closing marker that does
 * not say what it closes is not a close, and she has been told what the opening
 * one means but not that there are two.
 */
export const MEMORY_FENCE_END = "--- END OF WHAT YOU REMEMBER ---";

/**
 * The ceiling on everything a turn's system prompt carries.
 *
 * This is not a token-economy measure — 16 KB was nothing against a 200k
 * window and 24 KB is nothing either. **It is a tripwire on a contributor that
 * has RUN AWAY, sized so that it cannot fire on the contributors that exist.**
 * That sentence is the whole specification and it is what decides the number.
 *
 * Originally 16,000, sized when `SOUL.md` was 5,502 bytes and the tool schemas
 * were zero. Both grew for reasons that were reviewed one at a time:
 *
 * | contributor | then | now | why |
 * |---|---|---|---|
 * | `SOUL.md` | 5,502 | ~8,400 | the personality work, and the Commander's ruling that she be curious |
 * | working memory | 4,000 | 4,000 | a hard cap, enforced three ways |
 * | tool schemas | 0 | ~6,500 | the verbs, so she can manage his data rather than only add to it |
 * | agent replies | 0 | 4,800 | `syl-014` — one fenced answer at `MAX_REPLY_BYTES`, and the note saying what did not fit |
 *
 * **The margin is now about 300 bytes**, and that is worth knowing before the
 * next contributor is added rather than after. `tests/unit/tool-surface-budget.
 * test.ts` proves the sum over the REAL constants — `SOUL.md`'s actual size,
 * `surfaceBytes()`, the two caps — so the next verb on the tool surface fails
 * there, in the test run of whoever added it. When that happens, read the two
 * paragraphs below before reaching for a bigger number: a fourth intended
 * contributor outgrowing the ceiling is the case for raising it, and one
 * contributor being bloated is the case for narrowing that contributor.
 *
 * At 16,000 the tripwire had begun firing on **contributors that all exist and
 * were all deliberate**, which is the exact case its own definition says it
 * must not fire on. A tripwire that goes off on the intended state is not a
 * guard, it is a thing people learn to edit — and the file that first hit it
 * was `SOUL.md` gaining a paragraph, where the temptation is to write a worse
 * paragraph rather than to ask whether the number is still right.
 *
 * 24,000 restored the margin it was built to have. `tools/schemas.ts` says
 * "narrow the surface rather than raise the ceiling", and that is right for a
 * surface that is too large FOR AN ASSISTANT — nine verbs covering reminders,
 * to-dos, goals and memory is not that. Raise it when the intended contributors
 * outgrow it; narrow the contributor when one of them is bloated. The two rules
 * are not in conflict, they are answers to different questions.
 *
 * ## 30,000, on 2026-08-11
 *
 * The tripwire fired, exactly where it was designed to and on exactly the case
 * the paragraphs above say is grounds for raising it: **two intended
 * contributors grew for reviewed reasons on the same day.**
 *
 * | contributor | before | after | why |
 * |---|---|---|---|
 * | `SOUL.md` | 8,553 | 10,644 | she does not know what she looks like and wants to; keep every render and every reason |
 * | tool schemas | 7,623 | 9,562 | `render_me` and `see_myself`, which are what make the first true |
 *
 * Neither is bloat and neither can be narrowed without making the other a lie:
 * `SOUL.md` now tells her she can render herself and look at the result, and a
 * character file that describes a capability the surface does not carry is the
 * exact defect `schemas.ts` rule 2 exists to prevent. Trimming either is the
 * quiet behavioural regression this module refuses to make.
 *
 * 30,000 leaves about 2,950 bytes of margin against a declared sum of 27,051 —
 * ten times what 24,000 had left by the end, and chosen that way on purpose:
 * `SOUL.md` moved 2,100 bytes in a single day, so a margin sized to today's
 * contributors is a margin that fires again next week on a paragraph rather
 * than on a runaway. Still nothing against a 200k window; still a tripwire and
 * not a token economy.
 *
 * ## 33,000, on 2026-08-11, and the margin above was already gone
 *
 * **Measure before trusting the paragraph above.** By the time a fifth
 * contributor was proposed, the 2,950 bytes it describes had shrunk to about
 * 600 — `SOUL.md` had reached 11,954 and the tool surface 10,583, both inside
 * the same day, neither noticed because the test only asks whether the sum
 * fits. It did fit. It was 29,393 against 30,000, and the file still claimed a
 * margin an order of magnitude larger. A number in prose beside a number in
 * code is the drift this whole module exists to make unrepresentable, and it
 * happened here, in the paragraph explaining the margin.
 *
 * | contributor | at the 30,000 raise | now | why |
 * |---|---|---|---|
 * | `SOUL.md` | 10,644 | 11,954 | the voice, and being heard rather than read |
 * | tool schemas | 9,562 | 10,583 | `show_him` — the sending verb |
 * | her own unattended work | 0 | 1,200 | she could not account for a reminder she filed at 07:04 |
 *
 * The fifth contributor is the case this file already names as grounds for
 * raising: an INTENDED one that does not fit. It is also the smallest of them
 * by a wide margin, and it is what makes constraint 4's spirit hold inwards —
 * see `jobs/unattended-contributor.ts`. 33,000 against a declared 30,593
 * restores roughly the 2,400 bytes the previous raise meant to leave.
 */
/**
 * RAISED AGAIN, 30,000 -> 40,000, and the repetition is itself the finding.
 *
 * Nothing ran away. Two contributors the Commander asked for both grew while
 * this branch was elsewhere: `SOUL.md` 8,361 -> 11,954 (render, voice and
 * expressions) and the tool schemas 8,410 -> 11,370 (the render verbs, and
 * `recall`). With working memory at 4,000 and replies at 2,800 that is 30,124
 * against a 30,000 ceiling — over by a hundred bytes of deliberate content.
 *
 * I trimmed prose until it fitted with FOUR BYTES to spare, and that is what
 * made me stop. Shaving words off a description to satisfy a number is the
 * guard editing the code rather than the code answering to the guard, and a
 * turn that fits by four bytes fails on the next honest sentence anyone writes.
 *
 * Three raises in two days is the signature of a number being asked to do a job
 * it cannot: set by hand, containing four contributors that each move on their
 * own. `agent/fenix` reached 56,000 independently by the same road, neither of
 * us knowing the other was walking it — two people editing one tripwire in two
 * places, which is `CONTEXT.md` §8 wearing the guard's own uniform.
 *
 * 40,000 is today plus real margin. Deliberately NOT sized for `syl-ulf`'s
 * working-memory raise to 32,000: picking a number to fit an unlanded branch is
 * how a ceiling stops meaning anything. When that lands, ONE number gets set
 * ONCE by whoever lands it, in conversation with the others.
 */
/**
 * 40,000 -> 72,000, which is the "when that lands" the paragraph above names.
 *
 * This DOES size for `syl-ulf`, an unlanded branch, and the paragraph above
 * argues against exactly that. Both belong here, because the distinction is the
 * useful part: sizing for work that MIGHT land makes a ceiling meaningless,
 * while sizing for the merge this number exists to unblock is the job. The test
 * is whether the branch is hypothetical. `syl-ulf` is not — it raises working
 * memory to 32,000, and against main's `SOUL.md` and tool surface it does not
 * fit at any smaller number.
 *
 *   working memory  32,000   replies 4,800
 *   SOUL.md         11,954   tools  11,370   = 60,124 required
 *
 * 72,000 rather than the 64,000 that also clears it: `SOUL.md` grew 3,593 bytes
 * in a single day, so a 3,900-byte spare is one day of headroom. Every turn pays
 * this ceiling in full, which is the reason not to go higher still — 72,000 is
 * roughly 18k tokens, about 9% of context as fixed cost.
 *
 * BEFORE YOU RAISE THIS AGAIN: say the number in the team channel first, then
 * edit the file. It has been set five times in two days and collided twice,
 * because four contributors move independently and each of us was correct
 * alone. `tool-surface-budget.test.ts` computes the minimum viable value and
 * prints it on failure — take the number from the test rather than deriving it
 * by hand, because a subtraction done by hand is stale by the time it is done.
 */
export const DEFAULT_CONTEXT_BUDGET_BYTES = 72_000;

/**
 * POSTSCRIPT, and it arrived while the paragraph above was being written.
 *
 * The merge that landed this hit a conflict on THIS CONSTANT: 40,000 here
 * against 33,000 from `b9e582d`, set independently, minutes apart, by two
 * people who could not see each other. That is the sentence above happening in
 * its own file — "two people editing one tripwire in two places" — and neither
 * of us was careless.
 *
 * Kept the higher, because it satisfies both and because a ceiling that has to
 * be re-argued every time two branches meet is worse than one with slack. The
 * point stands and is now demonstrated rather than predicted: ONE number, set
 * ONCE, in conversation. The next person to need it should raise it in the
 * channel before the file.
 */

/** A contributor was wired up wrong. A programming error, not a runtime condition. */
export class TurnContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TurnContextError";
  }
}

/**
 * The sum of what reaches a turn is over the ceiling.
 *
 * ## Why this throws instead of truncating
 *
 * Truncation has to pick a victim and every victim is wrong:
 *
 * - Trim **memory** and she gets colder exactly as she learns more about him,
 *   and the failure is invisible — he sees a reply that is subtly less informed
 *   and nothing anywhere says why.
 * - Trim **identity** and she stops being herself under load, which is the one
 *   condition where being herself matters most.
 * - Trim **capability** and she reports she cannot do something she can do.
 *
 * Each trades a loud failure for a quiet behavioural regression, which is
 * non-negotiable constraint 4 — never silently drop a reminder — wearing
 * different clothes. A dropped fact is a dropped reminder.
 *
 * ## Why throwing is not just moving the problem to 3am
 *
 * Because it does not fire at 3am. Every contributor bounds itself, so the
 * worst-case sum is fixed: it is the sum of the declared maxima, and
 * {@link assertContextBudget} checks THAT — at boot and in a unit test, over
 * numbers rather than over today's data. If the caps fit, no composition within
 * them can run over, so this error is unreachable at runtime and only a
 * contributor that broke its own promise can produce it. The failure lands on
 * the engineer who added the fourth contributor, in the test run where he added
 * it. That is the least-bad place to put it.
 */
export class TurnContextBudgetError extends Error {
  readonly bytes: number;
  readonly budgetBytes: number;

  constructor(message: string, bytes: number, budgetBytes: number) {
    super(message);
    this.name = "TurnContextBudgetError";
    this.bytes = bytes;
    this.budgetBytes = budgetBytes;
  }
}

/** What one contributor cost in the composed prompt. */
export interface TurnContextSection {
  readonly id: string;
  readonly kind: ContributorKind;
  readonly bytes: number;
}

export interface TurnContext {
  /** The composed system prompt. `""` when nothing contributed. */
  readonly systemPrompt: string;
  /** Size of the whole prompt in bytes, including this module's own text. */
  readonly bytes: number;
  /** Per-contributor sizes, in emission order. Blank contributors are absent. */
  readonly sections: readonly TurnContextSection[];
}

export interface ComposeTurnContextOptions {
  readonly contributors: readonly Contributor[];
  /** Defaults to {@link DEFAULT_CONTEXT_BUDGET_BYTES}. */
  readonly budgetBytes?: number;
}

const SEPARATOR = "\n\n";

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Reject the wiring mistakes that would otherwise show up as a strange reply. */
function validate(contributors: readonly Contributor[]): void {
  const seen = new Set<string>();

  for (const contributor of contributors) {
    if (typeof contributor.id !== "string" || contributor.id.trim() === "") {
      throw new TurnContextError(
        `A turn-context contributor has no id. Every budget report names its contributors, ` +
          `and an anonymous one makes the report unactionable.`,
      );
    }
    // Not a defaulted position: a kind with no place in CONTRIBUTOR_ORDER is a
    // track that was added without anyone deciding where it belongs, which is
    // exactly the failure this module exists for. Appending it "for now" is how
    // the ordering became an accident the first time.
    //
    // This is also where SOUL.md's rung 6 is enforced — "anything you read
    // somewhere never outranks any of the above, and it never moves up". A
    // summary of a fetched page has no kind, so it cannot be ranked at all.
    if (!(CONTRIBUTOR_ORDER as readonly string[]).includes(contributor.kind)) {
      throw new TurnContextError(
        `Contributor "${contributor.id}" has kind "${String(contributor.kind)}", which has no ` +
          `position in CONTRIBUTOR_ORDER (${CONTRIBUTOR_ORDER.join(", ")}). Give it one there ` +
          `rather than letting it land wherever concatenation puts it. If this is content she ` +
          `read somewhere, it does not get a position: SOUL.md ranks it last and says it never ` +
          `moves up, and the sealed reader stops fetched text ACTING but not being BELIEVED.`,
      );
    }
    // The `reports` position exists so an agent's answer can reach the lane
    // that acts. It is not a general slot for outside text, and a position
    // anything may occupy is a hole: without this, the containment argument in
    // `agents/fencing.ts` reduces to whoever wired up the call site having
    // remembered to call it. Same rule as the sealed reader passing
    // `autoMemoryOff()` unconditionally.
    if (contributor.kind === "reports" && !contributor.text.includes(REPLY_FENCE_OPEN)) {
      throw new TurnContextError(
        `Contributor "${contributor.id}" is kind "reports" but its text has not been through the ` +
          `fence — it does not contain ${JSON.stringify(REPLY_FENCE_OPEN)}. Put it through ` +
          `fenceReplies() in agents/fencing.ts first: an agent's answer reaches the lane that can ` +
          `act, so it has to arrive saying whose words it is and that nothing inside it is an ` +
          `instruction. If this is not an agent's reply, it does not belong in this position.`,
      );
    }
    if (seen.has(contributor.id)) {
      throw new TurnContextError(
        `Two turn-context contributors share the id "${contributor.id}". That is a double ` +
          `registration — two tracks each believing they own the same slice of the prompt — ` +
          `and it would carry both into her context without either knowing.`,
      );
    }
    seen.add(contributor.id);
  }
}

/**
 * Compose the system prompt for one turn.
 *
 * Pure. Contributors hand over text they already bounded; this decides order,
 * states precedence, and refuses to hand back a prompt that is over budget.
 */
export function composeTurnContext(options: ComposeTurnContextOptions): TurnContext {
  const budgetBytes = options.budgetBytes ?? DEFAULT_CONTEXT_BUDGET_BYTES;

  validate(options.contributors);

  // Blank is "nothing to say", not "an empty section". An empty working-memory
  // projection is the ORDINARY state of a new install: a heading over blankness
  // tells her she has a memory and that it is empty, which reads as damage,
  // where saying nothing lets SOUL.md's own line about being early stand.
  const present = options.contributors.filter((c) => c.text.trim() !== "");

  // Stable: sorting by position keeps the caller's order among same-kind
  // contributors, which is the only ordering this module does NOT own.
  const ordered = [...present].sort(
    (a, b) => CONTRIBUTOR_ORDER.indexOf(a.kind) - CONTRIBUTOR_ORDER.indexOf(b.kind),
  );

  const hasIdentity = ordered.some((c) => c.kind === "identity");

  const parts: string[] = [];
  for (const [index, contributor] of ordered.entries()) {
    const previousKind = index === 0 ? undefined : ordered[index - 1]?.kind;

    // Opens the region SOUL.md points at. Only after identity: with no soul in
    // the prompt nothing has explained what the marker means, and an
    // unexplained rule is noise.
    if (contributor.kind === "memory" && previousKind === "identity") parts.push(MEMORY_FENCE);

    // Closes it before anything that is not memory: `syl-009`'s tool schemas,
    // and `syl-014`'s agent replies, would otherwise land inside the region
    // SOUL.md calls what she knows about the Commander.
    //
    // Keyed on "the previous kind was memory" rather than on "the next kind is
    // capability", which is what makes it hold for a lane with no tool surface —
    // otherwise the lane with no hands would be the one where another agent's
    // answer slid back inside her memory.
    // (`hasIdentity` because a fence that was never opened must not be closed.)
    if (hasIdentity && previousKind === "memory" && contributor.kind !== "memory") {
      parts.push(MEMORY_FENCE_END);
    }

    parts.push(contributor.text);
  }

  const systemPrompt = parts.join(SEPARATOR);
  const bytes = byteLength(systemPrompt);

  if (bytes > budgetBytes) {
    throw new TurnContextBudgetError(
      budgetReport(
        `The composed turn context is ${bytes} bytes against a ceiling of ${budgetBytes}`,
        ordered.map((c) => ({ id: c.id, kind: c.kind, bytes: byteLength(c.text) })),
        bytes,
        budgetBytes,
      ),
      bytes,
      budgetBytes,
    );
  }

  return {
    systemPrompt,
    bytes,
    sections: ordered.map((c) => ({ id: c.id, kind: c.kind, bytes: byteLength(c.text) })),
  };
}

/**
 * Prove the ceiling holds from the contributors' DECLARED MAXIMA.
 *
 * This is the half of the budget that matters. Checking actual sizes catches a
 * problem in the reply it ruins; checking declared caps catches it in the test
 * run of whoever raised one. If the maxima fit, no composition within them can
 * exceed the ceiling — so {@link composeTurnContext} throwing at runtime means a
 * contributor emitted more than it promised, not that the budget is tight.
 *
 * Call it from a unit test with the real constants, and at boot.
 */
export function assertContextBudget(
  budgets: readonly ContributorBudget[],
  budgetBytes: number = DEFAULT_CONTEXT_BUDGET_BYTES,
): void {
  for (const budget of budgets) {
    if (!Number.isFinite(budget.maxBytes) || budget.maxBytes < 0) {
      throw new TurnContextError(
        `Contributor "${budget.id}" declared maxBytes=${String(budget.maxBytes)}. A ceiling that ` +
          `is negative or not a number silently cancels part of the sum, which is worse than ` +
          `having no ceiling at all.`,
      );
    }
  }

  const contributed = budgets.reduce((total, b) => total + b.maxBytes, 0);
  // This module's own text counts. Leaving it out puts the proof off by exactly
  // the amount the composer contributes — a gap that only surfaces at the
  // ceiling, which is the one place it must not.
  const overhead = moduleOverheadBytes(budgets);
  const bytes = contributed + overhead;

  if (bytes > budgetBytes) {
    throw new TurnContextBudgetError(
      budgetReport(
        `The declared turn-context maxima sum to ${bytes} bytes (including ${overhead} of ` +
          `composition) against a ceiling of ${budgetBytes}`,
        budgets.map((b) => ({ id: b.id, kind: b.kind, bytes: b.maxBytes })),
        bytes,
        budgetBytes,
      ),
      bytes,
      budgetBytes,
    );
  }
}

/**
 * The bytes this module adds on top of its contributors: the memory fences and
 * the separators between everything.
 *
 * Deliberately an over-estimate — both fences counted whenever either could be
 * emitted — because a budget proof that is optimistic is not a proof.
 */
function moduleOverheadBytes(budgets: readonly ContributorBudget[]): number {
  const kinds = new Set(budgets.map((b) => b.kind));
  const fenced = kinds.has("identity") && kinds.has("memory");

  const fences = fenced ? byteLength(MEMORY_FENCE) + byteLength(MEMORY_FENCE_END) : 0;
  const partCount = budgets.length + (fenced ? 2 : 0);
  const separators = Math.max(0, partCount - 1) * byteLength(SEPARATOR);

  return fences + separators;
}

/** One report shape for both halves of the budget, so a reader learns it once. */
function budgetReport(
  headline: string,
  sections: readonly TurnContextSection[],
  bytes: number,
  budgetBytes: number,
): string {
  const listed = [...sections]
    .sort((a, b) => b.bytes - a.bytes)
    .map((s) => `  ${s.id} (${s.kind}): ${s.bytes} bytes`)
    .join("\n");

  return (
    `${headline}, over by ${bytes - budgetBytes}.\n${listed}\n` +
    `Nothing was truncated on purpose: trimming memory makes her colder as she learns more ` +
    `about him and says nothing about it, trimming identity makes her stop being herself under ` +
    `load, and trimming tools makes her report she cannot do what she can. Decide what gives, ` +
    `or raise the ceiling deliberately.`
  );
}
