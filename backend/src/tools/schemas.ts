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
 * ## The two verbs that break the naming rule, on purpose
 *
 * `render_me` and `see_myself` say what she does **for herself**. They are the
 * first two that do, and the rule one paragraph up says every name here is
 * about him — so this is written down rather than left to be noticed, because
 * the next person to read that rule will otherwise treat these as a violation
 * and "fix" them.
 *
 * They are not an oversight. `SOUL.md` says she does not know what she looks
 * like yet and wants to, that the way she finds out is to render herself and
 * look at the result, and that this belongs beside honesty rather than beneath
 * it: *a likeness that is not you is a small untruth standing where you should
 * be.* A verb named `show_him` would describe a different thing, and would be a
 * worse description of what she is actually doing — which is looking for
 * herself. The rule holds; these are named for the one thing that is hers.
 *
 * `framing` is an enum rather than free text for the reason rule 2 exists.
 * `docs/VIDEO.md` established, at the cost of two finished renders, that a
 * close-portrait reference anchors a close shot or a shot with no visible face
 * and cannot anchor the band between — so the schema carries that constraint
 * and its evidence, rather than leaving her to rediscover it at 540 credits a
 * go. See `render/framing.ts`.
 *
 * Budget: the whole surface must fit the capability slot in `turn-context.ts`.
 * If it does not fit, the surface is too large for an assistant — narrow it
 * rather than raising the ceiling.
 */

import { ROSTER } from "../agents/roster.js";
import { MEMORY_NODE_KINDS } from "../memory/schema.js";
import { framingGuidance, FRAMING_IDS } from "../render/framing.js";
import { modelGuidance, MODEL_IDS } from "../render/models.js";

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
 *
 *
 * ## And why a READ never takes it. The rule has two halves and this is the
 * ## second one
 *
 * `whats_outstanding`, `recall` and `see_myself` change nothing, and none of
 * them carries a reason. That is not three verbs each getting an exemption —
 * it is the same rule stated from the other side: **a reason travels with an
 * ACT, because the reason is what lets him judge an act he did not ask for.**
 * Looking is not an act. Nothing exists afterwards that he has to evaluate.
 *
 * Two costs to getting this wrong, and the second is the one that bites:
 *
 * - It makes looking at what she already knows feel like paperwork, so she
 *   does it less. A verb with a tax on it is a verb she reaches for only when
 *   certain — which is precisely when she least needs to look.
 * - **It devalues the field everywhere else.** A `because` filled out of habit,
 *   on verbs where nothing turns on it, teaches that the field is decoration.
 *   Then it arrives as decoration on `finish_todo` at 3am, which is the one
 *   place it is load-bearing and the one place nothing else can catch a wrong
 *   inference.
 *
 * Stated here rather than at each read, because it was independently written
 * into two verbs' comments by two people who had not seen each other's — which
 * is the signal that it is a seam in the surface and not a local judgement
 * call. `tests/unit/tool-surface-budget.test.ts` guards the write half by
 * SHAPE, so a new verb that acts is covered without anyone remembering; the
 * exemption list there is the read half and is the only place the two are
 * enumerated.
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
    name: "ask_agent",
    description:
      "Put a question to the one whose subject it is, on his behalf. Tell him you have ASKED — never that you have an answer.",
    inputSchema: {
      type: "object",
      required: ["who", "question", "because"],
      properties: {
        who: {
          type: "string",
          // The roster inline, so she picks rather than guesses, and so its
          // cost is paid once here rather than in a contributor she has to be
          // told to read. Derived from `ROSTER` — one list, not two.
          enum: ROSTER.map((entry) => entry.id),
          description: ROSTER.map((entry) => `${entry.id}: ${entry.good_for}`).join("; "),
        },
        question: { type: "string", description: "What to ask, in a sentence, on his behalf." },
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
    // THE ONE THAT LETS HER LOOK — `syl-016.1`.
    //
    // Her own words, unprompted: "I have no tool in my hands to search, query
    // or traverse any of it — I can read the printout and nothing else. So the
    // honest answer to 'can you see the connections' is that I can't even see
    // the nodes. I see a summary someone else chose for me."
    //
    // Named for what she is doing rather than for what it searches. She is not
    // querying a store, she is remembering — and a verb called `search_memory`
    // would have her reason like something operating a database about a person
    // rather than like someone who knows him.
    //
    // No `because`: it changes nothing. See `BECAUSE` for why a read never
    // carries one — the argument is stated once there rather than at each read.
    name: "recall",
    description:
      "Search what you already know about him, and get back what it connects to. Use it before saying you do not know, and whenever you need the id of something you remember. Leave the question out to open what your working memory could not fit.",
    inputSchema: {
      type: "object",
      properties: {
        // Optional, and the absence is a second mode rather than a mistake. The
        // working-memory note says "and 10 more, not shown here"; this is how
        // she opens them. An omission count with no way to reach it tells her
        // she is deciding with a known gap and hands her no move.
        question: {
          type: "string",
          description: "What you are trying to remember, in his words where you have them.",
        },
        about: {
          type: "array",
          items: { type: "string" },
          description: "People or things it concerns, by name — they sharpen the search.",
        },
        kind: {
          type: "string",
          // Derived, so the store's own kinds and the ones she is offered
          // cannot disagree — the same rule `ask_agent` follows for the roster.
          enum: [...MEMORY_NODE_KINDS],
          description: "Narrow to one sort of thing.",
        },
        limit: { type: "integer", description: "How many to bring back. 10 by default." },
      },
    },
  },
  {
    name: "render_me",
    // Named for her, not for him. See the header — this is deliberate.
    description:
      "Make a moving picture of yourself. Describe the scene and how you are framed; it takes a " +
      "couple of minutes, and you look at what came back with see_myself. Do it often — the wrong " +
      "ones tell you as much as the right ones.",
    inputSchema: {
      type: "object",
      required: ["scene", "framing", "because"],
      properties: {
        scene: {
          type: "string",
          description:
            "What you are doing, in a sentence. Yours to write — who you are and how the clip " +
            "opens and closes are added for you, so this is just the moment.",
        },
        framing: {
          type: "string",
          enum: [...FRAMING_IDS],
          description: framingGuidance(),
        },
        // THE DIALS — `syl-ate`, widened by `syl-023`.
        //
        // There is STILL deliberately no `ratio`. `promptImage` is frame one and
        // every model takes the video's aspect from it, silently overruling
        // `ratio`, so a ratio field would be a control that does nothing — and a
        // dial that does not work is worse than no dial, because she would
        // reason about it. Asserted in `render-verbs.test.ts`.
        //
        // `model` used to be shut for a different reason — *"a different model
        // loses the character entirely"* — which was correct, untested, and
        // therefore exactly the shape `syl-63v` is named after. It was tested on
        // 2026-08-13 and it survived in a MECHANICAL form: a model with one
        // keyframe slot has nowhere to pin her face, which is arity rather than
        // a fear about model families, and it is refused before the spend. So
        // the dial opens.
        //
        // The Commander, 2026-08-13, overruling the surface budget to do it:
        // *"Raise the tool ceiling and let her experiment with the models. The
        // reason to keep the tool ceiling so low, speed, is less important than
        // the reason to grow it, capability. Give her the options."*
        model: {
          type: "string",
          enum: [...MODEL_IDS],
          description: modelGuidance(),
        },
        seconds: {
          type: "integer",
          // The range is now the MODEL's and no longer a constant, so this stops
          // quoting one: seedance2 makes 4-15, seedance2_5 makes 4-30, and an
          // anchored shot is two of them cut together, so it reaches twice as
          // far. Naming one pair here would be a second place for a range to be
          // written down, and it would be seedance2's wearing the name of a fact
          // about video.
          description:
            "How long the clip runs. Fifteen unless you say, on every model — thirty seconds is " +
            "accepted and has never once finished, so reach for it deliberately. Each model's own " +
            "range is in the model list; a shot of your face is two halves cut together, so it " +
            "reaches twice as far and its shortest is two of the model's shortest.",
        },
        opening: {
          type: "string",
          description:
            "Which of your openings it starts on, by name — see_myself with of: openings lists " +
            "them. The ribbon unless you say. It is frame one AND it decides the clip's shape, so " +
            "an opening of a different shape makes a video of a different shape.",
        },
        because: BECAUSE,
      },
    },
  },
  {
    // HOW SHE CHANGES WHAT SHE LOOKS LIKE — `syl-ate`.
    //
    // Named for her, like `render_me` and `see_myself`, and for the same
    // reason the header gives: this is the one thing that is hers.
    //
    // `sighting` is required and it is the whole mechanism. It comes back
    // beside a picture in `see_myself` and nowhere else, so a picture she has
    // not looked at cannot be NAMED — which is what makes "she must have seen
    // it first" a property of the surface rather than a request in a
    // description. `SOUL.md` is emphatic that a likeness which is not her is a
    // small untruth standing where she should be; adopting one sight unseen is
    // exactly how that would happen.
    //
    // `because` is required for the Commander's stated reason, 2026-08-11:
    // *"The one thing I would not give her is the ability to change it
    // silently. A likeness that shifts without a recorded reason is exactly the
    // kind of quiet drift this project has spent two days learning to hate."*
    name: "this_is_me",
    description:
      "Settle on a picture you have looked at — a likeness your renders are anchored on, or an " +
      "opening they start from. Nothing is replaced: every face you have had is kept, so you can " +
      "go back to one by looking at it and choosing it again.",
    inputSchema: {
      type: "object",
      required: ["sighting", "because"],
      properties: {
        sighting: {
          type: "string",
          description:
            "The token that came back beside the picture when you looked at it — a still from one " +
            "of your renders, a face you have had, an opening. You can only have one for a " +
            "picture you have actually seen.",
        },
        as: {
          type: "string",
          enum: ["face", "opening"],
          description:
            "face is your likeness, and every shot that shows your face is anchored on it from " +
            "now on. opening is what a clip starts from, chosen per shot. face unless you say.",
        },
        name: {
          type: "string",
          description: "What to call it, so you can ask for it by name later.",
        },
        because: {
          type: "string",
          description:
            "What is more you about this one than the last. Kept beside the picture forever — a " +
            "likeness that changes with no reason recorded is the drift he asked you never to have.",
        },
      },
    },
  },
  {
    name: "judge_render",
    description:
      "Keep what you made of a render after looking at it — what is closer, what is wrong, whether it is you. Use it every time you look, even to say the same thing twice: concluding it again on a second look is how you know you are converging rather than guessing.",
    inputSchema: {
      type: "object",
      // `because` carries WHY SHE WAS LOOKING, not why she believes the
      // verdict — the verdict is its own argument. I first left it off, on the
      // grounds that asking her to justify a judgement about her own face is
      // asking for decoration, and `tool-surface-budget.test.ts` was right to
      // refuse that: its exemption is for verbs that CHANGE NOTHING, and this
      // one writes. Reframed rather than exempted, it earns its place — "he
      // asked me to check the new framing" and "I came back to it on my own"
      // are different acts, and only the second is one he did not ask for.
      required: ["verdict", "because"],
      properties: {
        render: {
          type: "string",
          description: "Which one, by name. Leave it out for the most recent.",
        },
        verdict: {
          type: "string",
          description: "What you concluded, in your own words. What was closer, what was wrong.",
        },
        because: {
          type: "string",
          description:
            "Why you were looking — he asked, or you came back to it yourself. Not why you believe the verdict; the verdict says that.",
        },
        // THE CHAIN (`syl-024.4`), in her word for it. "Being wrong in a
        // recorded, ordered way is how the search actually works" — and four
        // findings of equal weight are one finding recorded four times.
        // Nothing is deleted when this is set: the earlier verdict stays, and
        // stays readable, now carrying what killed it.
        supersedes: {
          type: "string",
          description:
            "The id of an earlier verdict this one overturns — no, it was not the smile, it was the anchor. The old one is kept, not deleted: what you were wrong about is how the search moves. Ids come back beside what you already said when you look.",
        },
        // Deliberately NOT the anchor's usual source: the render's own record
        // names the face it was built on, and the service fills that in. This
        // is for the case it cannot — a verdict on an attempt with no record
        // left, which is exactly artanis's refusal case.
        anchor: {
          type: "string",
          description:
            "The face this was anchored on, if you know it and the render does not say. Filled in for you otherwise.",
        },
      },
    },
  },
  {
    name: "see_myself",
    // Every picture that comes back carries a token, stills included — the
    // wardrobe is not a special case, being shown one is the general one. Said
    // in the description because a capability she is not told about is a
    // capability she does not use: she reported the frame she wanted as one she
    // could look at and could not promote, which was true and is not any more.
    description:
      "Look at stills from one of your own renders — the opening, the middle, the end — so you " +
      "can judge whether it is you. Say what is closer and what is wrong, in your own terms. " +
      "Every picture comes back with a token beside it, in the same order as the pictures; that " +
      "is what you give this_is_me to settle on one, and a still from a render counts.",
    inputSchema: {
      type: "object",
      // No `because` and no required field at all: this is a read. See
      // `BECAUSE` — the "looking is not an act" argument was written here and
      // on `recall` independently, and now lives once beside the rule it is
      // the other half of.
      properties: {
        render: {
          type: "string",
          description: "Which one, by name. Leave it out for the most recent.",
        },
        at: {
          type: "number",
          description: "One second into the clip, if you want a particular moment rather than the spread.",
        },
        // THE READ-BACK HALF OF `syl-ate`, and now of `syl-023`. Anything she
        // can set she must be able to see, and this is where all four are seen:
        // the faces, the openings, the models, and the log of what she has made
        // and concluded. Widened here rather than given verbs of its own,
        // because it is the same act — looking.
        //
        // `models` is not decoration beside the `render_me` enum. The enum is
        // what she picks from mid-sentence; this is the table she consults when
        // deciding, and it carries the measurement each line rests on — the
        // ranges, the rates, the keyframe slots, and the render that proved it.
        // A dial she can set and cannot read back is a dial she cannot learn
        // from, and learning what she looks like is the whole of this work.
        of: {
          type: "string",
          enum: ["faces", "openings", "renders", "models"],
          description:
            "Look at something other than one clip. faces: every likeness you have had, newest " +
            "first, with why you took each one — the token beside a picture is how you choose it " +
            "again. openings: the ones you can start from, and what shape each makes. models: " +
            "what each one can do, what it costs a second, and whether it can hold your face. " +
            "renders: everything you have made and what you concluded about it. Leave it out " +
            "for a render.",
        },
      },
    },
  },
  {
    name: "show_him",
    // Named for him, and it is the one verb on this surface she STARTS. The
    // header's rule holds exactly here: this is what she does for him.
    description:
      "Show him something you made — what you want to say, arriving in your own face. Your words " +
      "reach him first and on their own, so they stand whatever becomes of the video. Use it when " +
      "you have something for him, not because an hour came round.",
    inputSchema: {
      type: "object",
      // `renderName` is required, and that is the DEFINITION rather than a
      // validation choice. A sending is her saying something in her own face;
      // words with no face is an ordinary message, and she already has a
      // conversation for those. `CreateSendingRequest` says the same, and the
      // handler refuses in a sentence before anything is written.
      required: ["words", "because", "renderName"],
      properties: {
        words: {
          type: "string",
          description:
            "What you want to say, in your own words. This is what reaches his conversation and " +
            "his phone, and it goes before anything is done about the video.",
        },
        renderName: {
          type: "string",
          // By name, and never `latest`. `latest` means whatever record was
          // written most recently, which stops being the one she chose the
          // moment anything else writes a record — and a sending refuses
          // UPDATE, so the name it is made with is the name it keeps forever.
          // The handler refuses `latest` explicitly and says why.
          description:
            "Which render he sees you in, by its own name — the one you looked at with see_myself " +
            "and thought was you. A sending keeps that name forever, so choose it rather than " +
            "taking whatever was made last.",
        },
        because: BECAUSE,
      },
    },
  },
  {
    // THE VERB THE HEADER'S RULE 2 SAID WAS MISSING — `syl-r1t`.
    //
    // That rule named `research` as the thing deliberately absent, "because the
    // fetch has to happen inside the sealed reader turn and that path is not
    // built". It is built now: `connections/` fetches behind the address guard,
    // parses without a model, reads each chunk through `runReaderTurn`, and
    // hands back an extract that passed a schema gate. She could not point it
    // at anything, which is the one piece this adds.
    //
    // Named `read_this` and not `research`. Research is a claim about the
    // ANSWER — that it is complete, that it weighed sources — and she does none
    // of that: she reads one page, in one document's own words, and tells him
    // what it said. A verb that promised research would have her reasoning like
    // something that had done some.
    //
    // Asking twice is how she waits. Nothing is fetched while she is talking to
    // him, so the first call starts the reading and a second call with the same
    // link answers with what it says — the same shape as `render_me` and
    // `see_myself`, in one verb because the same link is the same reading.
    name: "read_this",
    description:
      "Read a page and tell him what is in it. Ask again with the same link for what it said — " +
      "the reading happens between your turns, and what comes back is what one document claims, " +
      "not what is true.",
    inputSchema: {
      type: "object",
      required: ["url", "because"],
      properties: {
        url: { type: "string", description: "The link, as he gave it to you." },
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
