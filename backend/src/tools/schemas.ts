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

/**
 * When a to-do is due.
 *
 * The agenda order in `shared/openapi.yaml` is "pinned first; then the nearest
 * `dueAt`, with undated to-dos after every dated one" — so this field and
 * {@link PINNED} are the two the whole plan sorts on, and until `syl-74p` she
 * could set neither. Ten to-dos, `due_at` NULL on every one, and a "today" view
 * that was empty by construction however well she planned his morning.
 */
const DUE_AT = {
  type: "string",
  description:
    "When it is due, as an RFC 3339 UTC instant. Set it whenever he says when — a to-do with no date sorts below every dated one and cannot appear in a view of his day.",
} as const;

/**
 * Whether this one matters more than its date says.
 *
 * The one durable bit of priority in the model: it sorts above `dueAt`, so a
 * pinned undated to-do still leads his list. Use sparingly — a list where
 * everything is pinned is a list with no pin.
 */
const PINNED = {
  type: "boolean",
  description:
    "True to keep it at the top of his list regardless of date. For the one thing that matters most right now, not for everything that matters.",
} as const;

export const TOOLS: readonly ToolSchema[] = [
  {
    name: "remind_me",
    description:
      "Bring something back to him at a particular moment. Use it whenever he says he must not forget a thing, or when you notice one he would want brought back.",
    inputSchema: {
      type: "object",
      required: ["text", "when", "because"],
      properties: {
        text: { type: "string", description: "What to bring back, in his words where you have them." },
        when: WHEN,
        because: BECAUSE,
        origin: {
          type: "string",
          enum: ["he_asked", "she_noticed"],
          description:
            "he_asked only when he actually asked for this, in this conversation. If you thought of it, or you are not sure, say she_noticed — he needs to know which are yours.",
        },
        // URGENCY IS DESCRIBED, NEVER DECIDED — `syl-j55`.
        //
        // This was `urgent: boolean`, and a boolean is a DECISION. `schedule.ts`
        // honours it unconditionally, so a flag she set on her own judgement
        // pierced quiet hours. `SOUL.md` says overnight items wait "unless
        // explicitly urgent", and explicit means HE said so — not that she
        // concluded it. Anticipation plus self-judged urgency is a 3am wake-up
        // for a friend's birthday, which is the one place his anticipation
        // order and his sleep actually collide.
        //
        // So she carries his words instead, exactly as `WHEN.said` does, and
        // the service rules on them. A phrase can be CHECKED against what he
        // actually wrote; a boolean cannot be checked against anything. Absent
        // or unverifiable means not urgent — the safe answer is the default,
        // and the failure is a reminder that waits rather than a house woken.
        urgentBecauseHeSaid: {
          type: "string",
          description:
            "Only if HE asked for it tonight — his words, quoted. Leave it out otherwise; you do not decide this.",
        },
      },
    },
  },
  {
    name: "cancel_reminder",
    description:
      "Call off a reminder he no longer wants. It stops firing; the record of it stays.",
    inputSchema: {
      type: "object",
      // The `id` comes from `whats_outstanding`, so she has to look before she
      // touches. That is not friction, it is the only moment a wrong guess is
      // still catchable — she can read him the text and the time she is about
      // to call off, and he can say "not that one".
      required: ["id", "because"],
      properties: {
        id: { type: "string", description: "The reminder's id, from whats_outstanding." },
        because: BECAUSE,
      },
    },
  },
  {
    name: "change_reminder",
    description:
      "Move or reword a reminder that already exists. Prefer this to cancelling and making a new one — he is thinking of it as the same reminder.",
    inputSchema: {
      type: "object",
      // Only `id` and `because` are required: a change names the fields it
      // changes and leaves the rest alone. Sending a whole reminder back would
      // silently overwrite whatever she did not think to include.
      required: ["id", "because"],
      properties: {
        id: { type: "string", description: "The reminder's id, from whats_outstanding." },
        text: { type: "string", description: "New wording, if he reworded it." },
        when: WHEN,
        because: BECAUSE,
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
    description:
      "Put something on his list. For a thing he has to do, with no particular hour attached. Give it a dueAt when he says WHEN — an undated to-do sorts below every dated one and will not appear in a view of his day.",
    inputSchema: {
      type: "object",
      required: ["text", "because"],
      properties: {
        text: { type: "string", description: "The task, at the level he would describe it." },
        dueAt: DUE_AT,
        pinned: PINNED,
        because: BECAUSE,
      },
    },
  },
  {
    name: "schedule_todo",
    description:
      "Put a date on something already on his list, move it, take the date off, or pin it. This is how a pile becomes a plan: use it when he says when he will do a thing he has already told you about, rather than adding a second copy with a date on it.",
    inputSchema: {
      type: "object",
      required: ["id", "because"],
      properties: {
        id: { type: "string", description: "The to-do's id, from whats_outstanding." },
        dueAt: {
          ...DUE_AT,
          description: `${DUE_AT.description} Pass null to take the date off entirely, and omit it to leave the date alone — those are three different asks.`,
        },
        pinned: PINNED,
        because: BECAUSE,
      },
    },
  },
  {
    name: "finish_todo",
    description: "Mark something on his list done, when he tells you it is.",
    inputSchema: {
      type: "object",
      // `because` matters MOST here, not least. This is the only verb that
      // takes something away, and the one case the description does not cover
      // is the dangerous one: she infers he finished it. If that inference is
      // wrong the item is gone and he never learns it existed — the silent
      // discard that constraint 4 exists to forbid. "He said so" is a cheap
      // answer to give and the only one that makes a wrong guess visible.
      required: ["id", "because"],
      properties: {
        id: { type: "string", description: "The to-do's id, from whats_outstanding." },
        because: BECAUSE,
      },
    },
  },
  {
    name: "drop_todo",
    description:
      "Take something off his list that he is not going to do. For one he HAS done use finish_todo — done and given up are different, and he may want to tell them apart later.",
    inputSchema: {
      type: "object",
      required: ["id", "because"],
      properties: {
        id: { type: "string", description: "The to-do's id, from whats_outstanding." },
        because: BECAUSE,
      },
    },
  },
  {
    name: "set_goal",
    description:
      "Record something he is working toward, at the level he actually thinks about it — not a task, a direction.",
    // A goal is a write like any other, and one of the most likely to be
    // INFERRED rather than asked for — she notices a direction across three
    // weeks of conversation and records it. That is the anticipation the
    // Commander asked for, and exactly the case that needs its reason attached,
    // so he can tell a good read of him from a wrong one.
    //
    // It used to share a `TEXT` shorthand with nothing else, which is how it
    // came to be the one write missing `because`: the helper predated the rule
    // and quietly exempted its only caller. Shorthand that hides a field is
    // how a rule gets a hole in it.
    inputSchema: {
      type: "object",
      required: ["text", "because"],
      properties: {
        text: { type: "string", description: "The goal, in his words." },
        because: BECAUSE,
      },
    },
  },
  {
    name: "change_goal",
    description:
      "Reword a goal, or move it on: he has reached it, given it up, or set it aside for now. One verb because they are one change to one goal, and he will tell you which in a sentence.",
    inputSchema: {
      type: "object",
      required: ["id", "because"],
      properties: {
        id: { type: "string", description: "The goal's id, from whats_outstanding." },
        text: { type: "string", description: "New wording, if he has restated it." },
        status: {
          type: "string",
          enum: ["active", "achieved", "abandoned", "dormant"],
          description:
            "achieved when he has done it. abandoned when he has decided not to. dormant when it is set aside but not given up — the difference matters to him.",
        },
        because: BECAUSE,
      },
    },
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
