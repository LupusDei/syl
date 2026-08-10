/**
 * Syl's hands, as she reads them.
 *
 * These names and descriptions are **personality**, not documentation. A model
 * infers what it is for from its verbs: give it `Read` and `Bash` and it
 * reasons like something that reads files and runs commands, whatever its
 * character file says. So every name here says what she does FOR HIM rather
 * than what it does to an API — `remind_me`, not `POST /reminders`.
 *
 * Three rules they follow, all of them learned the hard way this week:
 *
 * 1. **They say what she DOES, never what she cannot.** The containment tests
 *    say what she cannot, and neither restates the other. Prose that says "you
 *    may not X" goes stale the day X is allowed, and a stale instruction does
 *    not fail loudly — it gets acted out.
 *
 * 2. **Nothing here claims a capability that is not wired.** `research` is
 *    deliberately absent: the fetch has to happen inside the sealed reader turn
 *    and that path is not built. Shipping the verb first would tell her she can
 *    do something she cannot, which is exactly the defect that made her answer
 *    "remind me in five minutes" like an assistant and write nothing.
 *
 * 3. **Time is described, never computed.** The model gives a structured
 *    interpretation and repeats his words in `said`; `time.ts` decides whether
 *    that is usable and refuses ambiguity rather than guessing. The schema
 *    therefore asks for a shape, not for an instant.
 *
 * Budget: the whole surface must fit the capability slot in `turn-context.ts`.
 * If it does not fit, the surface is too large for an assistant — narrow it
 * rather than raising the ceiling.
 */

/** A JSON Schema fragment, as the MCP `tools/list` reply carries it. */
export interface ToolSchema {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

/**
 * How the model expresses *when*, mirroring `TimeSpec` in `time.ts`.
 *
 * `said` is separate and required: the vagueness veto runs on his actual words
 * and on nothing else. A model asked for structure always produces structure —
 * ask it about "remind me later" and it returns a confident thirty minutes — so
 * his phrase has to survive alongside the interpretation for that to be caught.
 */
const WHEN = {
  type: "object",
  required: ["said", "kind"],
  properties: {
    said: {
      type: "string",
      description: "His own words for when, and only that part — 'in five minutes', 'tomorrow morning'.",
    },
    kind: {
      type: "string",
      enum: ["relative", "time_of_day", "date_time", "part_of_day", "recurring"],
    },
    minutes: { type: "integer", description: "relative: how many minutes from now." },
    wallTime: { type: "string", description: "24-hour HH:MM, local to him." },
    date: { type: "string", description: "date_time: YYYY-MM-DD." },
    day: { type: "string", enum: ["today", "tomorrow"] },
    part: { type: "string", enum: ["morning", "afternoon", "evening", "night"] },
    rrule: { type: "string", description: "recurring: an RRULE, e.g. FREQ=WEEKLY;BYDAY=TU." },
  },
} as const;

const TEXT = (what: string): Readonly<Record<string, unknown>> => ({
  type: "object",
  required: ["text"],
  properties: { text: { type: "string", description: what } },
});

/**
 * Why every write takes `because`.
 *
 * The Commander asked to be anticipated — a friend's birthday, something to
 * send his wife — and the rule that makes that a gift rather than a machine
 * acting on his behalf is that **every unprompted thing carries its reason**.
 * "Dave's birthday is Thursday, you mentioned him in March" is a gift; "I made
 * you a reminder" is not. He cannot tell a good suggestion from a wrong one, or
 * tell her to stop making a kind he dislikes, without it.
 *
 * Required rather than optional, because an optional field for the thing that
 * makes the feature trustworthy is a field that goes unfilled at 3am.
 */
const BECAUSE = {
  type: "string",
  description:
    "Why this exists, in his terms. If he asked, say so. If you noticed it, say what you noticed.",
} as const;

export const TOOLS: readonly ToolSchema[] = [
  {
    name: "remind_me",
    description:
      "Have Syl bring something back to him at a particular moment. Use it whenever he says he must not forget a thing, or when you notice one he would want brought back.",
    inputSchema: {
      type: "object",
      required: ["text", "when", "because"],
      properties: {
        text: { type: "string", description: "What to bring back, in his words where you have them." },
        when: WHEN,
        because: BECAUSE,
        urgent: {
          type: "boolean",
          description: "Reaches him inside quiet hours. For things that are worse late than unwelcome.",
        },
      },
    },
  },
  {
    name: "remember",
    description:
      "Keep something he told you about his life — a person, a preference, a date, something he is worried about. Use it when a detail is worth having in a month, not for what is already in front of you.",
    inputSchema: {
      type: "object",
      required: ["fact", "because"],
      properties: {
        fact: { type: "string", description: "The thing itself, in one sentence." },
        because: BECAUSE,
      },
    },
  },
  {
    name: "add_todo",
    description: "Put something on his list. For a thing he has to do, with no particular hour attached.",
    inputSchema: {
      type: "object",
      required: ["text", "because"],
      properties: {
        text: { type: "string", description: "The task, at the level he would describe it." },
        because: BECAUSE,
      },
    },
  },
  {
    name: "finish_todo",
    description: "Mark something on his list done, when he tells you it is.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string", description: "The to-do's id, from whats_outstanding." } },
    },
  },
  {
    name: "set_goal",
    description:
      "Record something he is working toward, at the level he actually thinks about it — not a task, a direction.",
    inputSchema: TEXT("The goal, in his words."),
  },
  {
    name: "whats_outstanding",
    description:
      "Look at what he currently has open — reminders, to-dos, goals. Use it before telling him what is on his plate, and before offering something he may already have.",
    inputSchema: {
      type: "object",
      properties: {
        of: { type: "string", enum: ["reminders", "todos", "goals", "everything"] },
      },
    },
  },
];

/** Bytes this surface costs the turn, counted the way the budget counts it. */
export function surfaceBytes(tools: readonly ToolSchema[] = TOOLS): number {
  return Buffer.byteLength(JSON.stringify(tools), "utf8");
}
