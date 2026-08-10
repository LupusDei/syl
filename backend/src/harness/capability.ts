/**
 * What she can actually DO this turn, derived from the surface she was handed.
 *
 * ## Why this is a function and not a paragraph in `SOUL.md`
 *
 * Three times in one day an instruction outlived the capability it assumed, and
 * every time the failure was **prose**:
 *
 * - The plugin hooks briefed her, every turn, to report to an orchestrator that
 *   was not there. She was not confused; she was obeying.
 * - Auto-memory told her to keep a memory file after `--tools ""` removed the
 *   tools that needed. She emitted a fabricated `ls` of a directory that does
 *   not exist.
 * - `SOUL.md` told her she owns his to-dos and his reminders before any verb
 *   for them existed. The Commander asked for a reminder in five minutes; she
 *   answered like an assistant who had set one, and nothing was written.
 *
 * The last two are the same bug at opposite polarity — capability removed with
 * the instruction left behind, capability asserted before it arrived — and
 * neither is catchable by assertion, because the artefact is a sentence.
 *
 * The reflex fix is a line saying she cannot act yet. That line is stale the
 * day the tools land, which makes it the fourth instance of the bug it was
 * written to fix. So there is no hand-written line, in either direction:
 * **this sentence is a function of the surface actually attached**, which makes
 * staleness unrepresentable rather than merely unlikely. Nobody has to remember
 * to delete anything, and nobody can forget.
 *
 * ## What belongs here and what belongs in `SOUL.md`
 *
 * `SOUL.md` keeps the **domain** — his to-dos, his goals, his rhythm, the
 * people in his life. That is what she is FOR, and it is true whether or not a
 * single tool is attached; it is the reason she asks about his day.
 *
 * This module keeps the **verbs**. Domain is stable and hand-written; capability
 * changes with deployment and is generated. Merging the two is exactly what put
 * "Reminders that arrive at the right wall-clock moment" in front of her with
 * no way to create one.
 */

/**
 * What she is told when nothing is attached.
 *
 * Note what it does NOT say: nothing about tools, configuration, or a surface.
 * She is not solemn about herself, and "your tool surface is currently empty"
 * is a sentence about her construction rather than her situation. It also has
 * to pre-empt the CLAIM and not merely state the limit — "I've added that to
 * your list" stays a fluent thing to say for a model that has only been told it
 * lacks something.
 */
export const NO_HANDS_YET = [
  "One thing about right now: you can talk with him, and that is all you can do yet.",
  "You have no way to act on any of it — you cannot write a to-do, set a reminder, or change",
  "anything he asks you to change. It is being built and it is close.",
  "",
  "So when he asks for something you cannot do, say so plainly and offer to hold it for him",
  "until you can. Never say you have done it. Never say you will remember to do it later as",
  "though that were the same thing. He would rather hear 'I can't do that yet, but tell me and",
  "I'll keep it' than find out on Thursday that Thursday's reminder was never real.",
].join("\n");

/**
 * The capability section for a turn, given the tools that turn will really have.
 *
 * @param toolNames the surface actually attached — pass what is being handed to
 *   the turn, never a list maintained alongside it. A second list is a list
 *   that disagrees.
 */
export function describeCapability(toolNames: readonly string[]): string {
  if (toolNames.length === 0) return NO_HANDS_YET;

  const named = toolNames.map((name) => `- ${name}`).join("\n");

  return [
    "These are yours to use when they are the right thing:",
    "",
    named,
    "",
    "Use them rather than describing them, and tell him what you did in a sentence — he wants",
    "the outcome, not the mechanism. If one fails, say it failed and what you tried; a thing",
    "you said you did and did not do is the one failure he will never catch.",
  ].join("\n");
}

/**
 * The capability section for a `TurnOptions.tools` value, or `undefined` for
 * "say nothing".
 *
 * Three cases, and the third is the one worth reading twice:
 *
 * - `""` — no tools at all. She is told plainly that she cannot act.
 * - `"a,b"` — exactly those. She is told what they are.
 * - **`undefined` — the CLI's DEFAULT surface, which is every built-in.** Not
 *   "no tools". Emitting {@link NO_HANDS_YET} here would be the same lie in the
 *   other direction, told by the very module written to prevent it, so this
 *   returns `undefined` and adds no section. A turn that has not decided its
 *   surface has nothing honest to say about it.
 *
 * @param tools the value being handed to the turn — read from the same object
 *   the CLI is invoked with, so the description cannot drift from the surface.
 */
export function capabilityFromToolsOption(tools: string | undefined): string | undefined {
  if (tools === undefined) return undefined;

  const names = tools
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");

  return describeCapability(names);
}
