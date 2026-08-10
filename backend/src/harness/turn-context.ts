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
 *   wins. See {@link PRECEDENCE_CLAUSES}.
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
 */

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
 */
export const CONTRIBUTOR_ORDER = ["identity", "memory", "capability"] as const;

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
 * How a conflict between a standing order and a remembered fact resolves.
 *
 * **The Commander has not ruled.** This type is the seam that holds the answer
 * as a policy instead of leaving it an emergent property of concatenation, and
 * {@link DEFAULT_PRECEDENCE} is the one line to change when he does.
 */
export type PrecedencePolicy =
  /** Rules hold, defaults yield. The shape proposed in the design exchange. */
  | "rules-outrank-memory"
  /** `SOUL.md` wins outright; memory never amends it. */
  | "identity-outranks-memory"
  /** Memory wins outright; the standing orders are a starting point. */
  | "memory-outranks-identity";

/**
 * The default, and the shape proposed before the ruling: `SOUL.md`'s **rules**
 * outrank memory — "never drop a reminder silently" is not negotiable by a
 * remembered preference — while its **defaults** do not: "be brief" is exactly
 * the sort of thing a year of knowing him should be allowed to overrule.
 *
 * **Change this one constant when the Commander rules.** Nothing else.
 */
export const DEFAULT_PRECEDENCE: PrecedencePolicy = "rules-outrank-memory";

/**
 * What each policy actually says to her.
 *
 * There is no runtime that can arbitrate between a standing order and a memory —
 * the model is the only thing that reads both — so a precedence policy is only
 * real to the extent it is stated in the prompt. A policy nobody tells her is a
 * comment.
 *
 * Emitted only when identity AND memory both contributed: a clause about a
 * conflict needs two parties, and on a first run — when she remembers nothing —
 * a paragraph about how to weigh her memories tells her she has some.
 */
export const PRECEDENCE_CLAUSES: Readonly<Record<PrecedencePolicy, string>> = {
  "rules-outrank-memory": [
    "On a conflict between a standing order above and something you remember: a",
    "standing order that is a RULE holds, and nothing you have learned amends it —",
    '"never drop a reminder silently" is not negotiable by a remembered preference.',
    "A standing order that is a DEFAULT yields, because what you have learned about",
    "him is better information than a general default. If you cannot tell which one",
    "a standing order is, treat it as a rule and say that you did.",
  ].join("\n"),
  "identity-outranks-memory": [
    "On a conflict between a standing order above and something you remember, the",
    "standing order holds. A remembered preference does not amend it. Say which",
    "memory you set aside, so it can be corrected if it was right.",
  ].join("\n"),
  "memory-outranks-identity": [
    "On a conflict between a standing order above and something you remember, what",
    "you have learned about him holds. The standing orders are where you start, not",
    "where you finish. Say which one you set aside and why.",
  ].join("\n"),
};

/**
 * The marker that opens her memory, and it is named in `SOUL.md`.
 *
 * Not a decorative rule. Her identity file points at this exact string to say
 * what follows it is her own memory, so the marker is part of the contract
 * between two files and cannot be changed on one side.
 */
export const MEMORY_FENCE = "---";

/**
 * The ceiling on everything a turn's system prompt carries.
 *
 * Measured today: `SOUL.md` is 5,502 bytes, the working-memory projection is
 * capped at 4,000 (enforced three ways in `memory/working.ts`), tool schemas are
 * zero and grow under `syl-009`. 9,502 against 16,000 leaves real headroom for
 * the tools track without the ceiling being so generous it never fires.
 *
 * This is not a token-economy measure — 16 KB is nothing against a 200k window.
 * It is a tripwire on a contributor that has run away, sized so that it cannot
 * fire on the contributors that exist.
 */
export const DEFAULT_CONTEXT_BUDGET_BYTES = 16_000;

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
  /** The policy that was stated to her. */
  readonly precedence: PrecedencePolicy;
}

export interface ComposeTurnContextOptions {
  readonly contributors: readonly Contributor[];
  /** Defaults to {@link DEFAULT_PRECEDENCE}. */
  readonly precedence?: PrecedencePolicy;
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
    if (!(CONTRIBUTOR_ORDER as readonly string[]).includes(contributor.kind)) {
      throw new TurnContextError(
        `Contributor "${contributor.id}" has kind "${String(contributor.kind)}", which has no ` +
          `position in CONTRIBUTOR_ORDER (${CONTRIBUTOR_ORDER.join(", ")}). Give it one there ` +
          `rather than letting it land wherever concatenation puts it.`,
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
  const precedence = options.precedence ?? DEFAULT_PRECEDENCE;
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
  const hasMemory = ordered.some((c) => c.kind === "memory");
  // The clause names "a standing order above", so it needs both parties present.
  const clause = hasIdentity && hasMemory ? PRECEDENCE_CLAUSES[precedence] : undefined;

  const parts: string[] = [];
  for (const [index, contributor] of ordered.entries()) {
    const previousKind = index === 0 ? undefined : ordered[index - 1]?.kind;

    // Opens the region SOUL.md points at. Only after identity: with no soul in
    // the prompt nothing has explained what the marker means, and an
    // unexplained rule is noise.
    if (contributor.kind === "memory" && previousKind === "identity") parts.push(MEMORY_FENCE);

    // Closes it. SOUL.md tells her everything past the marker is what she knows
    // about him — so a tool schema emitted after it is silently annexed into her
    // memory of the Commander. That is this module's failure mode made concrete:
    // two correct contributors, and a prompt neither of them chose.
    // (`hasIdentity` because a fence that was never opened must not be closed.)
    if (hasIdentity && previousKind === "memory" && contributor.kind !== "memory") {
      parts.push(MEMORY_FENCE);
    }

    parts.push(contributor.text);
  }

  if (clause !== undefined) {
    if (ordered[ordered.length - 1]?.kind === "memory") parts.push(MEMORY_FENCE);
    parts.push(clause);
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
    precedence,
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
  precedence: PrecedencePolicy = DEFAULT_PRECEDENCE,
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
  const overhead = moduleOverheadBytes(budgets, precedence);
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
 * The bytes this module adds on top of its contributors: the precedence clause,
 * the memory fences, and the separators between everything.
 *
 * Deliberately an over-estimate — every fence that could be emitted, counted —
 * because a budget proof that is optimistic is not a proof.
 */
function moduleOverheadBytes(
  budgets: readonly ContributorBudget[],
  precedence: PrecedencePolicy,
): number {
  const kinds = new Set(budgets.map((b) => b.kind));
  const clause = kinds.has("identity") && kinds.has("memory") ? PRECEDENCE_CLAUSES[precedence] : "";

  const fenceCount = kinds.has("memory") && kinds.has("identity") ? 2 : 0;
  const partCount = budgets.length + fenceCount + (clause === "" ? 0 : 1);
  const separators = Math.max(0, partCount - 1) * byteLength(SEPARATOR);

  return byteLength(clause) + fenceCount * byteLength(MEMORY_FENCE) + separators;
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
