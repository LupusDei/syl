import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

import type { Goal, HealthStatus, Reminder, ReminderOrigin, Sending, Todo } from "@syl/shared";

import { AdjutantClient } from "../agents/adjutant-client.js";
import { mayReach, notOnTheRoster } from "../agents/roster.js";

import { verifyUrgency } from "../harness/urgency.js";

import { SylApiClient, type ToolFailure, type ToolResult } from "./client.js";
import { TOOLS, type ToolSchema } from "./schemas.js";
import { reminderInputFrom, resolveTime } from "./time.js";

/**
 * Syl's hands, as a process.
 *
 * An MCP server over stdio, started by Claude Code for the length of one turn
 * and handed to the commander lane alone. It speaks JSON-RPC 2.0 in
 * newline-delimited JSON — the transport `--mcp-config` declares and the one
 * `tests/acceptance/us6-she-can-act.test.ts` drives for real.
 *
 * ## Every verb goes over the loopback API. None of them touch a service.
 *
 * The whole file could be shorter by importing `ReminderService`. It would also
 * be wrong, and this is a different process precisely so that shortcut is not
 * available: validation, idempotency, quiet-hours deferral and the store's
 * CHECK constraints are enforced at the API boundary, and a second path into
 * the same data would re-implement all of them and drift. The day it drifts is
 * the day a reminder she made behaves differently from one his phone made, with
 * no test able to see it because both paths pass their own. One door.
 *
 * ## Nothing here throws across the boundary
 *
 * A handler that throws crosses MCP as a stack trace and reaches the Commander
 * as silence — or worse, as Syl saying she set a reminder because nothing told
 * her she had not. Every outcome is a {@link ToolEnvelope}: either the stored
 * row read back, or a refusal carrying **a sentence she can say out loud**.
 * `tools/client.ts` makes the same promise one layer down; this file is what
 * keeps it true for everything above the transport as well.
 *
 * ## Confirmed from the store, never from her intention
 *
 * `syl-009.3.4`. A write is followed by a read of the row it created, and the
 * row is what comes back in `subject`. Constraint 4 says a reminder must never
 * be silently dropped; a reminder she *believed* she created and did not is the
 * same broken promise arriving through a different door, and the only way to
 * close it is for the thing she reports to be the thing that is stored.
 *
 * ## What she is NOT given, and why the list is shorter than `schemas.ts`
 *
 * A verb reaches this surface only if it has a handler here, and a handler
 * exists only where the API has a door for it. `research` is absent from
 * `schemas.ts` already, because the sealed fetch path does not exist.
 * `remember` was declared there and absent **here** for two months, for the same
 * reason one step later: there was no route that wrote a memory. `syl-016.7`
 * built one, and it is the only WRITE on her credential — so the asymmetry this
 * paragraph used to record is closed, deliberately and in that order. She could
 * read her own memory for exactly as long as it took to decide the write
 * separately, which is how a decision like that should arrive.
 *
 * What still bounds it is not this file: `HerOwnMemory` has no method that
 * deletes, supersedes, relabels, moves a weight or mints a person, and
 * `POST /memory/edges/{id}/feedback` remains out of her reach. **She may add
 * what she concluded; she may not adjust what she will be shown for concluding
 * it.**
 *
 * Advertising it anyway would tell her she can keep what he told her about his
 * life, and every attempt would come back `403`. That is exactly the defect
 * this epic exists to fix — a capability asserted before it arrived — so
 * {@link advertisedTools} derives the list from the handlers rather than from
 * the schema file, and a verb with nowhere to go simply is not offered.
 */

// ---------------------------------------------------------------------------
// The envelope
// ---------------------------------------------------------------------------

/**
 * What a verb answers, in the one shape every verb answers in.
 *
 * Pinned: another track reads this. `subject` is **the stored row**, read back
 * after the write, and `at` is the moment the action is about — when a reminder
 * will fire, or when a row was last written — so that she can say what she did
 * without inventing a time for it.
 */
export type ToolEnvelope =
  | {
      readonly ok: true;
      readonly action: string;
      readonly subject: unknown;
      readonly at: string | null;
      /**
       * What she has spent on renders, when the verb is one that spends.
       *
       * Optional and additive: every existing verb omits it and every existing
       * reader ignores it. It rides on the answer rather than waiting behind a
       * verb she would have to think to call, because the Commander removed the
       * gate and visibility is what is left — same rule as `because`, evidence
       * travelling with the action instead of standing in front of it.
       */
      readonly spent?: unknown;
      /**
       * Pictures, for the one verb whose answer is pictures.
       *
       * **She cannot watch an mp4.** `see_myself` exists because a still is the
       * one thing a model with image input can actually perceive, and these
       * become MCP image blocks in {@link asToolResult}. Never present on a
       * refusal: a failure carrying pictures would have her describing
       * something she was not shown.
       */
      readonly images?: readonly {
        readonly mimeType: string;
        readonly base64: string;
      }[];
    }
  | {
      readonly ok: false;
      readonly action: string;
      /** A complete sentence, addressed to him. Never a code, never empty. */
      readonly reason: string;
      readonly retryable: boolean;
    };

/** What every handler is given. */
export interface ToolContext {
  readonly client: SylApiClient;
  /** His configured zone. IANA, always. */
  readonly tz: string;
  /**
   * What the Commander wrote this turn, or `""` when it cannot be established.
   *
   * A function rather than a value: this process outlives nothing and is
   * started fresh per turn, but the file behind it is written by the service
   * immediately before the turn, so reading it late is reading it correctly.
   */
  readonly hisMessage: () => string;
  /**
   * How she reaches the fleet, or `null` when she cannot.
   *
   * Null is the ordinary state, not a failure: Adjutant is optional, and a
   * missing one must never stop her talking to him. `ask_agent` refuses with a
   * sentence he can act on rather than throwing, because "I cannot reach anyone
   * right now" is an answer and a stack trace is not.
   */
  readonly fleet: AdjutantClient | null;
}

type ToolHandler = (input: Record<string, unknown>, context: ToolContext) => Promise<ToolEnvelope>;

// ---------------------------------------------------------------------------
// Reading what the model sent
// ---------------------------------------------------------------------------

/** A required, non-blank string field, or `null`. */
function text(input: Record<string, unknown>, field: string): string | null {
  const value = input[field];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** The refusal for a field the model left out or left blank. */
function missing(action: string, field: string, sentence: string): ToolEnvelope {
  return {
    ok: false,
    action,
    // Written to be repeated to him rather than to be parsed: this reaches the
    // model, and what the model does with a refusal is turn it into a sentence.
    reason: `${sentence} (\`${field}\` was missing.)`,
    // Retryable: the model can supply the field and call again, which is a
    // materially different instruction from "this cannot work".
    retryable: true,
  };
}

/** A transport or contract failure, in the envelope's own words. */
function refused(action: string, failure: ToolFailure): ToolEnvelope {
  return { ok: false, action, reason: failure.message, retryable: failure.retryable };
}

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

/**
 * What time it is, according to **Syl**.
 *
 * This process has a perfectly good clock of its own and must not use it. Two
 * reasons, and the second is the one that bites:
 *
 * - There is one authority for time in this system, and it is the service —
 *   the same clock the store stamps rows with and the scheduler fires against.
 *   Two clocks that agree today are two clocks.
 * - It is the only way a test can hold time still. A frozen service and a child
 *   process reading `Date.now()` would make "five minutes from now" mean two
 *   different instants, and the acceptance criterion of this whole epic is a
 *   statement about exactly that arithmetic.
 *
 * `GET /health` is unauthenticated and outside `AGENT_SURFACE`, so asking costs
 * nothing and reaches nothing: `now` is the only field read.
 */
async function serviceNow(client: SylApiClient): Promise<ToolResult<number>> {
  const health = await client.get<HealthStatus>("/health");
  if (!health.ok) return health;

  const now = Date.parse(health.data.now);
  if (Number.isNaN(now)) {
    return {
      ok: false,
      failure: {
        kind: "malformed",
        operation: "GET /health",
        status: health.status,
        code: null,
        message:
          `Syl's own API reported the time as "${String(health.data.now)}", which is not an ` +
          "instant. Nothing can be scheduled against a clock that cannot be read.",
        retryable: false,
        details: null,
      },
    };
  }
  return { ok: true, data: now, status: health.status, replayed: false };
}

// ---------------------------------------------------------------------------
// The verbs
// ---------------------------------------------------------------------------

/**
 * Bring something back to him at a particular moment.
 *
 * Three things happen here in an order that is load-bearing. Time is resolved
 * first, because an ambiguous time is a **question** and a question must not
 * cost a write. Urgency is decided second, from evidence. The write comes last,
 * and is read back before anything is reported.
 */
const remindMe: ToolHandler = async (input, context) => {
  const errand = text(input, "text");
  if (errand === null) {
    return missing("remind_me", "text", "I did not catch what to remind you about.");
  }
  if (text(input, "because") === null) {
    return missing(
      "remind_me",
      "because",
      "Every reminder carries its reason, so you can tell a good suggestion from a wrong one.",
    );
  }

  const when = input["when"];
  const said =
    typeof when === "object" && when !== null && !Array.isArray(when)
      ? ((when as Record<string, unknown>)["said"] ?? "")
      : "";

  const now = await serviceNow(context.client);
  if (!now.ok) return refused("remind_me", now.failure);

  const resolution = resolveTime({
    said: typeof said === "string" ? said : "",
    spec: when,
    clock: () => now.data,
    tz: context.tz,
  });
  if (resolution.outcome === "ambiguous") {
    // Not a failure of the machinery — a failure to understand him, and the
    // only correct answer to that is to ask. `time.ts` wrote the question to be
    // said verbatim, so it is handed on verbatim.
    return { ok: false, action: "remind_me", reason: resolution.question, retryable: true };
  }

  // THE ONE LINE THIS BEAD EXISTS FOR (`syl-p8k`).
  //
  // Not `input["urgentBecauseHeSaid"] !== undefined`. A presence check is
  // satisfied by any string at all, so she could wake him at three by writing
  // the field — which is the whole defect `syl-j55` closed on the schema side
  // and this is the side that enforces it. The quoted phrase is compared to
  // what he actually wrote, and absent, empty or unmatched all mean not urgent.
  const quoted = input["urgentBecauseHeSaid"];
  const urgent = verifyUrgency(
    typeof quoted === "string" ? quoted : undefined,
    context.hisMessage(),
  );

  // `syl-y82`. The reason was REQUIRED above and then thrown away — on the one
  // verb that wakes him. `SOUL.md` promises he can tell a good suggestion from
  // a wrong one and can tell her to stop making a kind he dislikes, and both
  // were false while this line did not exist.
  //
  // `origin` is DERIVED, not asked for. A heartbeat or dream turn carries no
  // message from him, so it cannot be a response to one — which makes "she
  // thought of it" a fact about the turn rather than something she reports
  // about herself. Those are exactly the 3am ones, the case that matters. Same
  // rule as `urgentBecauseHeSaid`: a conclusion can only be trusted, evidence
  // can be checked.
  // ASYMMETRIC, and that is artanis's refinement rather than a detail.
  //
  // No message from him means it CANNOT be a response to one, so "she noticed"
  // is derived — a fact about the turn, not a self-report. That covers the 3am
  // reminders, which is the case that matters.
  //
  // When he IS talking, "he asked" is a claim nothing can check. So it is hers
  // to declare and she gets the benefit of the doubt — but silence or
  // uncertainty falls to "she noticed", never to "he asked".
  //
  // The asymmetry is free because the costs are: a wrong "she noticed" gives
  // her slightly less credit than she is owed, which is harmless. A wrong "he
  // asked" is her telling him he said something he did not — which is the
  // failure that fooled a careful reader with the database open. Over-
  // attributing to herself is both the safe direction and the honest one.
  const heIsTalking = context.hisMessage().trim() !== "";
  const claimed = text(input, "origin");
  const origin: ReminderOrigin =
    heIsTalking && claimed === "he_asked" ? "he_asked" : "she_noticed";

  const created = await context.client.post<Reminder>("/reminders", {
    text: errand,
    ...reminderInputFrom(resolution),
    urgent,
    because: text(input, "because"),
    origin,
  });
  if (!created.ok) return refused("remind_me", created.failure);

  return readBack("remind_me", context, `/reminders/${encodeURIComponent(created.data.id)}`, (row: Reminder) => row.nextFireAt);
};

/** Put something on his list. */
const addTodo: ToolHandler = async (input, context) => {
  const errand = text(input, "text");
  if (errand === null) return missing("add_todo", "text", "I did not catch what to add.");
  if (text(input, "because") === null) {
    return missing("add_todo", "because", "Every to-do carries its reason.");
  }

  const created = await context.client.post<Todo>("/todos", { text: errand });
  if (!created.ok) return refused("add_todo", created.failure);

  return readBack("add_todo", context, `/todos/${encodeURIComponent(created.data.id)}`, (row: Todo) => row.updatedAt);
};

/**
 * Mark something on his list done.
 *
 * The one verb that takes something away, which is why `because` matters most
 * here rather than least: if she infers he finished it and is wrong, the item
 * is gone and he never learns it existed.
 *
 * ## What can and cannot be guarded
 *
 * The dangerous case is not a bad id. A bad id is loud. It is her **inferring**
 * that he finished something, and no field in a schema can tell a machine
 * whether that inference is right — `urgentBecauseHeSaid` works because there
 * is a message to compare a quote against, and "he finished it" is a claim
 * about the world rather than about the conversation. So the guard is not
 * verification. It is these three, in this order:
 *
 * 1. **`because` is required**, so a guess is recorded as a guess. `turn.tool`
 *    carries the arguments, which makes it the one place a wrong one can be
 *    found afterwards.
 * 2. **Look before writing.** A stale or half-remembered id must cost a read
 *    and nothing else, and the answer must say plainly that nothing left his
 *    list — "I could not" and "nothing changed" are different sentences and
 *    only one of them lets him stop wondering.
 * 3. **Say which item.** Every path here names the to-do in his own words,
 *    because him hearing the wrong title is the only place a wrong guess is
 *    still catchable. A verb that answers "done" tells him nothing he could
 *    contradict.
 *
 * The row itself survives — `complete` sets a status, and nothing in this
 * system deletes a to-do — so the cost of being wrong is that an item stops
 * being offered to him, not that it ceases to exist. That is precisely why (3)
 * matters: the recovery exists, and he can only use it if he is told.
 */
const finishTodo: ToolHandler = async (input, context) => {
  const id = text(input, "id");
  if (id === null) {
    return missing("finish_todo", "id", "I need to know which one — ask me what is outstanding.");
  }
  if (text(input, "because") === null) {
    return missing(
      "finish_todo",
      "because",
      "This is the one thing that takes an item away, so it has to say why.",
    );
  }

  const path = `/todos/${encodeURIComponent(id)}`;

  const before = await context.client.get<Todo>(path);
  if (!before.ok) {
    return {
      ok: false,
      action: "finish_todo",
      // The added sentence is true whichever way the read failed — a wrong id,
      // a service restarting, a timeout — because it is a statement about what
      // this handler did, not about what the store said.
      reason: `${before.failure.message} I looked it up before touching it, so nothing has come off your list.`,
      retryable: before.failure.retryable,
    };
  }

  if (before.data.status === "done") {
    // Reported as a refusal, not as a success, and the distinction is the whole
    // point. `TodoService.complete` returns an already-done row unchanged — it
    // is idempotent for the phone's outbox — so the write would succeed and she
    // would announce having just finished something she did not touch. That is
    // her claiming an act she did not perform, about an item she may well have
    // picked by mistake, and it is exactly the case where he needs to hear the
    // title and the date and decide for himself.
    const when = before.data.completedAt === null ? "" : `, at ${before.data.completedAt}`;
    return {
      ok: false,
      action: "finish_todo",
      reason:
        `"${before.data.text}" was already marked done${when}. I have changed nothing. ` +
        "If that is not the one you meant, tell me which it is.",
      // Nothing to retry: repeating the call cannot produce a different answer,
      // and a retryable refusal invites exactly that.
      retryable: false,
    };
  }

  const done = await context.client.post<Todo>(`${path}/complete`);
  if (!done.ok) return refused("finish_todo", done.failure);

  return readBack("finish_todo", context, path, (row: Todo) => row.completedAt);
};

/**
 * Call off a reminder, and say which one you called off.
 *
 * The verb he asked for by name. He told her to remove two reminders, she had
 * no way to, and she said so rather than claiming otherwise:
 *
 * > "I could not remove the 1:45 and 5:45 ones... I'm not going to tell you
 * > they're gone when they aren't."
 *
 * Two things make this safe enough to hand her. **The row survives** —
 * `DELETE /reminders/:id` sets `cancelled` and keeps the history, because a row
 * that disappears takes with it the proof that nothing was silently dropped
 * (constraint 4). And **she reads it before she touches it**, so the reply can
 * name the text and the time she just called off. That is the only moment a
 * wrong id is still catchable: he can hear "not that one" and say so.
 */
const cancelReminder: ToolHandler = async (input, context) => {
  const id = text(input, "id");
  if (id === null) {
    return missing("cancel_reminder", "id", "I need to know which one — ask me what is outstanding.");
  }
  if (text(input, "because") === null) {
    return missing(
      "cancel_reminder",
      "because",
      "This stops something firing, so it has to say why.",
    );
  }

  const path = `/reminders/${encodeURIComponent(id)}`;

  const before = await context.client.get<Reminder>(path);
  if (!before.ok) {
    return {
      ok: false,
      action: "cancel_reminder",
      // True whichever way the read failed, because it describes what THIS
      // handler did rather than what the store said.
      reason: `${before.failure.message} I looked it up before touching it, so nothing has been called off.`,
      retryable: before.failure.retryable,
    };
  }

  if (before.data.deliveryState === "cancelled") {
    // A refusal, not a success. Cancelling twice would return happily and she
    // would announce having just called off something she did not touch —
    // about an item she may have picked by mistake.
    return {
      ok: false,
      action: "cancel_reminder",
      reason:
        `"${before.data.text}" was already cancelled. I have changed nothing. ` +
        "If that is not the one you meant, tell me which it is.",
      retryable: false,
    };
  }

  const cancelled = await context.client.del<Reminder>(path);
  if (!cancelled.ok) return refused("cancel_reminder", cancelled.failure);

  return readBack("cancel_reminder", context, path, (row: Reminder) => row.updatedAt);
};

/**
 * Move or reword a reminder he already has.
 *
 * Deliberately not "cancel it and make a new one". He is thinking of it as the
 * same reminder — "move the 6pm one to 8" — and a system that answers by
 * destroying one thing and creating another gives him a new id, a new history,
 * and a cancelled row he never asked for.
 *
 * **Only the named fields move.** A patch that sent the whole reminder back
 * would silently overwrite every field she did not think to include, which is
 * the failure where a reword quietly loses the time.
 */
const changeReminder: ToolHandler = async (input, context) => {
  const id = text(input, "id");
  if (id === null) {
    return missing("change_reminder", "id", "I need to know which one — ask me what is outstanding.");
  }
  if (text(input, "because") === null) {
    return missing("change_reminder", "because", "A change to something he set has to say why.");
  }

  const path = `/reminders/${encodeURIComponent(id)}`;

  const before = await context.client.get<Reminder>(path);
  if (!before.ok) {
    return {
      ok: false,
      action: "change_reminder",
      reason: `${before.failure.message} I looked it up before touching it, so nothing has changed.`,
      retryable: before.failure.retryable,
    };
  }

  const patch: Record<string, unknown> = {};
  const reworded = text(input, "text");
  if (reworded !== null) patch["text"] = reworded;

  const when = input["when"];
  if (when !== undefined) {
    // The same resolution `remind_me` uses, including the vagueness veto — a
    // move has exactly the same way of being misunderstood as a creation, and
    // "push it back a bit" must ask rather than guess.
    const said =
      typeof when === "object" && when !== null && !Array.isArray(when)
        ? ((when as Record<string, unknown>)["said"] ?? "")
        : "";

    const now = await serviceNow(context.client);
    if (!now.ok) return refused("change_reminder", now.failure);

    const resolution = resolveTime({
      said: typeof said === "string" ? said : "",
      spec: when,
      clock: () => now.data,
      tz: context.tz,
    });
    if (resolution.outcome === "ambiguous") {
      return { ok: false, action: "change_reminder", reason: resolution.question, retryable: true };
    }

    Object.assign(patch, reminderInputFrom(resolution));
  }

  if (Object.keys(patch).length === 0) {
    // Nothing to do is not the same as done. A silent no-op here reads to her
    // as success and she tells him it moved.
    return {
      ok: false,
      action: "change_reminder",
      reason:
        `I did not catch what to change about "${before.data.text}". ` +
        "Tell me the new wording or the new time.",
      retryable: false,
    };
  }

  const changed = await context.client.patch<Reminder>(path, patch);
  if (!changed.ok) return refused("change_reminder", changed.failure);

  return readBack("change_reminder", context, path, (row: Reminder) => row.updatedAt);
};

/**
 * Take something off his list that he is not going to do.
 *
 * The sibling of `finish_todo`, and deliberately a different verb rather than
 * a flag on it. **Done and given up are different facts about his life** — one
 * is an achievement and the other is a decision — and collapsing them would
 * make his own history unreadable to him later. The store already knew this:
 * `dropped` has been in `TodoStatus` since the table was written.
 *
 * Same two guards as every verb that takes something away: read it first, and
 * name what left the list, so a wrong id is audible in the same breath she
 * acts on it. The row survives with a status, so the cost of being wrong is
 * that an item stops being offered rather than that it ceases to exist.
 */
const dropTodo: ToolHandler = async (input, context) => {
  const id = text(input, "id");
  if (id === null) {
    return missing("drop_todo", "id", "I need to know which one — ask me what is outstanding.");
  }
  if (text(input, "because") === null) {
    return missing(
      "drop_todo",
      "because",
      "This takes an item away without it being done, so it has to say why.",
    );
  }

  const path = `/todos/${encodeURIComponent(id)}`;

  const before = await context.client.get<Todo>(path);
  if (!before.ok) {
    return {
      ok: false,
      action: "drop_todo",
      reason: `${before.failure.message} I looked it up before touching it, so nothing has come off your list.`,
      retryable: before.failure.retryable,
    };
  }

  if (before.data.status === "done") {
    // He finished this. Quietly restyling it as abandoned would rewrite a
    // small piece of his history, and he is the only one who can tell which it
    // was — so this asks rather than guesses.
    return {
      ok: false,
      action: "drop_todo",
      reason:
        `"${before.data.text}" is already marked done, not outstanding. I have changed nothing — ` +
        "tell me if you want it recorded as abandoned instead.",
      retryable: false,
    };
  }

  if (before.data.status === "dropped") {
    return {
      ok: false,
      action: "drop_todo",
      reason: `"${before.data.text}" was already dropped. I have changed nothing.`,
      retryable: false,
    };
  }

  // A patch, not a delete: `PATCH /todos/:id` already carries a status and
  // `TodoService.update` already validates it. No new route was needed, which
  // I discovered only after filing a bead saying otherwise.
  const dropped = await context.client.patch<Todo>(path, { status: "dropped" });
  if (!dropped.ok) return refused("drop_todo", dropped.failure);

  return readBack("drop_todo", context, path, (row: Todo) => row.updatedAt);
};

/**
 * Put a question to another agent, on his behalf and under her own name.
 *
 * `syl-014`. The Commander's ask: let her reach the treasurer, who knows his
 * real finances, and the engineers, who can build. **Not coordination** — his
 * words — so nothing here reports status, claims work, or answers to anyone.
 *
 * Three things this refuses to do, each for a reason that cost something:
 *
 * 1. **It never sends as him.** `POST /api/messages` stamps `from: "user"`, so
 *    the obvious integration would have had her asking about his money in his
 *    voice. `AdjutantClient` carries her own identity and has no sender field
 *    to get wrong; this handler could not impersonate him if it tried.
 * 2. **It never claims an answer.** Agents are offline most of the time. She
 *    reports having ASKED, and that is all that has happened — the failure this
 *    project keeps catching is a system claiming more than it did.
 * 3. **It never reaches someone off the roster**, and the refusal names who she
 *    can reach, because she has to turn it into a sentence for him.
 */
const askAgent: ToolHandler = async (input, context) => {
  const who = text(input, "who");
  if (who === null) return missing("ask_agent", "who", "I did not catch who to ask.");

  const question = text(input, "question");
  if (question === null) return missing("ask_agent", "question", "I did not catch what to ask them.");

  if (text(input, "because") === null) {
    return missing(
      "ask_agent",
      "because",
      "Asking someone on his behalf has to say why, so he can tell a good instinct from a wrong one.",
    );
  }

  // The roster BEFORE the transport. Who she may influence, and be influenced
  // by, is a decision rather than a convenience — and checking it first means a
  // name she should not reach never leaves this process.
  if (!mayReach(who)) {
    return { ok: false, action: "ask_agent", reason: notOnTheRoster(who), retryable: false };
  }

  if (context.fleet === null) {
    return {
      ok: false,
      action: "ask_agent",
      reason: "I have no way to reach the others right now, so I have not asked anyone.",
      retryable: true,
    };
  }

  const sent = await context.fleet.ask(who, question);
  if (!sent.ok) {
    return {
      ok: false,
      action: "ask_agent",
      // Says what did NOT happen. "I could not reach them" and "they have not
      // replied" are different facts and he will act differently on each.
      reason: `${sent.failure.message} I have not asked ${who}.`,
      retryable: sent.failure.kind !== "refused",
    };
  }

  return {
    ok: true,
    action: "ask_agent",
    // Deliberately not `subject: the answer`. Nothing has been answered — most
    // agents are offline most of the time, and a verb that implied otherwise
    // would have her telling him the treasurer said something.
    subject: { who, question, messageId: sent.data.messageId },
    at: sent.data.at,
  };
};

/** Record something he is working toward. */
const setGoal: ToolHandler = async (input, context) => {
  const title = text(input, "text");
  if (title === null) return missing("set_goal", "text", "I did not catch the goal.");
  const because = text(input, "because");
  if (because === null) {
    return missing(
      "set_goal",
      "because",
      "A goal she noticed rather than was told is the one he most needs the reason for.",
    );
  }

  // `because` has a home on this row and on no other: `why` is the goal's own
  // field. Elsewhere it survives as the tool arguments in `turn.tool`, which is
  // the record of what she did on his machine.
  const created = await context.client.post<Goal>("/goals", { title, why: because });
  if (!created.ok) return refused("set_goal", created.failure);

  return readBack("set_goal", context, `/goals/${encodeURIComponent(created.data.id)}`, (row: Goal) => row.updatedAt);
};

/**
 * Ask her own memory a question, and get the nodes back — **with their ids**.
 *
 * `syl-016.1`, and the verb she asked for herself:
 *
 * > "I have no tool in my hands to search, query or traverse any of it — I can
 * > read the printout and nothing else. So the honest answer to 'can you see the
 * > connections' is that I can't even see the nodes. I see a summary someone
 * > else chose for me."
 *
 * Everything behind this was already built and connected to nothing: the fusion
 * kernels in `memory/retrieve.ts`, the FTS5 index, the graph walk. The same
 * shape as the reminder gap — the capability existed everywhere except in her
 * hands — and the same fix: one door, over the loopback API, never a service.
 *
 * ## Two modes, one verb
 *
 * A question searches. **No question opens the overflow** (`syl-016.2`): the
 * items her working memory counted and would not name. They are different
 * questions — "what do I know about this" and "what is being kept from me" —
 * and the second cannot be answered by searching, because no query text
 * reproduces the projection's own salience ranking.
 *
 * ## Why there is no `because`
 *
 * Every verb that CHANGES something carries its reason, and this changes
 * nothing. `whats_outstanding` is exempt on the same grounds. Requiring a
 * reason to look at what she already knows would be asking her to justify
 * remembering, and a required field that is always filled with the same
 * sentence teaches her that the field is decoration — which is exactly what
 * would then happen on the verbs where it is load-bearing.
 */
const recall: ToolHandler = async (input, context) => {
  const question = text(input, "question");
  const kind = text(input, "kind");

  const named = input["about"];
  const about = (Array.isArray(named) ? named : [])
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value !== "");

  const asked = input["limit"];
  const limit = typeof asked === "number" && Number.isInteger(asked) ? asked : undefined;

  const found = await context.client.get<{ readonly generatedAt: string }>("/memory/recall", {
    // Absent rather than empty: a blank `q` and no `q` mean the same thing to
    // the route, and sending one that is present-but-empty would make the
    // wire say something the model did not.
    ...(question === null ? {} : { q: question }),
    ...(kind === null ? {} : { kind }),
    // Comma-joined because the client encodes scalars only. The route accepts
    // either spelling, so this is a transport detail rather than a contract.
    ...(about.length === 0 ? {} : { about: about.join(",") }),
    ...(limit === undefined ? {} : { limit }),
  });
  if (!found.ok) return refused("recall", found.failure);

  return {
    ok: true,
    action: "recall",
    // The view verbatim, ids included. Nothing is summarised on the way past:
    // a verb built because she was given somebody else's summary must not
    // hand her another one.
    subject: found.data,
    at: found.data.generatedAt,
  };
};

/**
 * Keep something she worked out — `syl-016.7`.
 *
 * The verb that had a schema and no handler, which is why she never saw it. Her
 * account of what she did instead is the clearest statement of the defect:
 *
 * > "I can't write to my memory directly. The only durable text I control is
 * > goals and reminders. So I've put the connection where it will survive."
 *
 * She put an insight in a **goal** and wrote a paragraph at the nightly
 * extractor hoping it would land. That is an assistant gaming its own memory
 * pipeline to keep a thought.
 *
 * ## What comes back matters as much as what goes in
 *
 * `unknown` names every person she mentioned that the graph does not know, and
 * this handler passes it through rather than swallowing it. A memory kept about
 * nobody is the silent half of this feature: she would believe she had
 * connected a thought to Ela and it would sit unreachable from Ela forever.
 * Told, she can say "I do not know an Ela yet" — and that is a question for him,
 * which is the whole point of her.
 */
const remember: ToolHandler = async (input, context) => {
  const thought = text(input, "fact");
  if (thought === null) {
    return missing("remember", "fact", "I did not catch what to remember.");
  }
  // Required here as it is on every verb that writes. It is doing more work on
  // this one than on any other: it becomes the `reasoning` on an inferred edge,
  // which is what he reads when he decides whether she thought correctly.
  const because = text(input, "because");
  if (because === null) {
    return missing(
      "remember",
      "because",
      "A memory you made carries why you believe it — that is what lets him tell a good read of him from a wrong one.",
    );
  }

  const named = input["about"];
  const about = (Array.isArray(named) ? named : [])
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value !== "");

  const kept = await context.client.post<{ readonly at: string }>("/memory/remember", {
    thought,
    because,
    ...(about.length === 0 ? {} : { about }),
  });
  if (!kept.ok) return refused("remember", kept.failure);

  return { ok: true, action: "remember", subject: kept.data, at: kept.data.at };
};

/** How much of each list she is shown. Enough to talk about, not a data dump. */
const OUTSTANDING_LIMIT = 50;

/** The three lists `of` may name. Anything else is not one of them. */
const OUTSTANDING_LISTS = ["reminders", "todos", "goals"] as const;

/**
 * Look at what he currently has open.
 *
 * The read that stops her offering him something he already has, which makes
 * its failure mode the interesting part: **it must never answer "nothing"
 * because it did not look**. Two ways that could happen, and both are closed
 * here — a filter that is not one of the three widens to everything instead of
 * matching nothing, and a list that cannot be read refuses the whole call
 * rather than returning the rest. A short list and a partial one look identical
 * to him, and "you have nothing else on" is not a sentence she may say from a
 * page that never arrived.
 */
const whatsOutstanding: ToolHandler = async (input, context) => {
  const of = input["of"];
  const asked = typeof of === "string" ? of.trim().toLowerCase() : "";
  // Anything outside the enum reads as `everything`. Widening cannot mislead
  // him; the alternative — no list matches, and an empty `ok` envelope comes
  // back — is a confident "your plate is clear" produced by a typo.
  const wanted = OUTSTANDING_LISTS.find((list) => list === asked) ?? "everything";
  const want = (kind: string): boolean => wanted === "everything" || wanted === kind;

  const subject: Record<string, unknown> = {};

  if (want("reminders")) {
    // `scheduled` rather than everything: "outstanding" means still to come,
    // and a delivered reminder from last Tuesday is not on his plate.
    const page = await context.client.get<{ items: Reminder[] }>("/reminders", {
      state: "scheduled",
      limit: OUTSTANDING_LIMIT,
    });
    if (!page.ok) return refused("whats_outstanding", page.failure);
    subject["reminders"] = page.data.items;
  }
  if (want("todos")) {
    const page = await context.client.get<{ items: Todo[] }>("/todos", {
      status: "open",
      limit: OUTSTANDING_LIMIT,
    });
    if (!page.ok) return refused("whats_outstanding", page.failure);
    subject["todos"] = page.data.items;
  }
  if (want("goals")) {
    const page = await context.client.get<{ items: Goal[] }>("/goals", {
      status: "active",
      limit: OUTSTANDING_LIMIT,
    });
    if (!page.ok) return refused("whats_outstanding", page.failure);
    subject["goals"] = page.data.items;
  }

  return { ok: true, action: "whats_outstanding", subject, at: null };
};

/**
 * Read the row back and report THAT.
 *
 * `syl-009.3.4` in one function. The response to a write already carries the
 * row, and using it would be reporting what the write said it did; this asks
 * the store. The difference is invisible on every path except the one that
 * matters — a write that was accepted, transformed and stored differently, or
 * replayed from the idempotency ledger — and that is the path where telling him
 * the wrong thing costs the most.
 */
async function readBack<T>(
  action: string,
  context: ToolContext,
  path: string,
  momentOf: (row: T) => string | null,
): Promise<ToolEnvelope> {
  const stored = await context.client.get<T>(path);
  if (!stored.ok) {
    return {
      ok: false,
      action,
      reason:
        `${stored.failure.message} The write itself may well have gone through — I could not ` +
        "read it back to be sure, so check before asking me again.",
      retryable: stored.failure.retryable,
    };
  }
  return { ok: true, action, subject: stored.data, at: momentOf(stored.data) };
}

/**
 * Every verb she can actually perform, by name.
 *
 * The single source of what this server is. `advertisedTools()` intersects it
 * with `schemas.ts`, so a handler with no schema and a schema with no handler
 * are both simply absent rather than half-present.
 */
/**
 * Reword a goal, or move it on.
 *
 * One verb rather than achieve/abandon/set-aside, because they are one change
 * to one row and three verbs would have to agree about what each leaves
 * behind. The *distinction* still matters and lives in the enum: **achieved,
 * abandoned and dormant are three different things that happened in his life**,
 * and a system that collapsed them would make his own history unreadable to
 * him a year later.
 */
const changeGoal: ToolHandler = async (input, context) => {
  const id = text(input, "id");
  if (id === null) {
    return missing("change_goal", "id", "I need to know which goal — ask me what is outstanding.");
  }
  if (text(input, "because") === null) {
    return missing("change_goal", "because", "A change to something he is working toward has to say why.");
  }

  const path = `/goals/${encodeURIComponent(id)}`;

  const before = await context.client.get<Goal>(path);
  if (!before.ok) {
    return {
      ok: false,
      action: "change_goal",
      reason: `${before.failure.message} I looked it up before touching it, so nothing has changed.`,
      retryable: before.failure.retryable,
    };
  }

  const patch: Record<string, unknown> = {};
  const reworded = text(input, "text");
  if (reworded !== null) patch["title"] = reworded;
  const status = text(input, "status");
  if (status !== null) patch["status"] = status;

  if (Object.keys(patch).length === 0) {
    return {
      ok: false,
      action: "change_goal",
      reason:
        `I did not catch what to change about "${before.data.title}". ` +
        "Tell me the new wording, or whether he has reached it, given it up, or set it aside.",
      retryable: false,
    };
  }

  // The reason he gave travels WITH the state change, so a goal that says
  // `abandoned` can also say why it was abandoned. That is the field he will
  // want when he wonders what happened to something a year from now.
  if (status !== null) patch["statusReason"] = text(input, "because");

  const changed = await context.client.patch<Goal>(path, patch);
  if (!changed.ok) return refused("change_goal", changed.failure);

  return readBack("change_goal", context, path, (row: Goal) => row.updatedAt);
};

/**
 * Make a moving picture of herself.
 *
 * Named for her rather than for him, which is the exception `schemas.ts`
 * argues for at length. The interesting decisions here are two things this
 * handler deliberately does **not** do.
 *
 * It does not confirm, cap, or count down. The Commander, 2026-08-11: the
 * credits exist for exactly this experiment, and the whole point is that trying
 * things is cheap for her. A verb that asked "are you sure" would be a verb
 * that made her hesitate, which is the opposite of what he asked for.
 *
 * It does not wait. A flagship render takes minutes and a turn does not
 * complete until stdin reaches EOF, so waiting means the Commander watching a
 * cursor while she stares at a GPU queue. She gets the record at once and looks
 * later, with `see_myself`.
 *
 * What it does carry is the bill — `spent`, on the answer, every time. That is
 * the whole of the accountability, and it is the `because` rule applied to
 * money: the evidence travels with the action and never stands in front of it.
 */
const renderMe: ToolHandler = async (input, context) => {
  const scene = text(input, "scene");
  if (scene === null) {
    return missing("render_me", "scene", "I did not catch what the shot is of.");
  }
  const framing = text(input, "framing");
  if (framing === null) {
    return missing("render_me", "framing", "I need to know where the camera is — that is the thing that decides whether it comes back as me.");
  }
  if (text(input, "because") === null) {
    return missing("render_me", "because", "Every render says why it exists, the same as everything else I make.");
  }

  const created = await context.client.post<{ record: { id?: string; name: string } }>("/renders", {
    scene,
    framing,
    because: text(input, "because"),
  });
  if (!created.ok) return refused("render_me", created.failure);

  // Read back, exactly as every other write does — `syl-009.3.4`. It matters
  // more here than most: what comes back says `rendering` rather than `ready`,
  // and reporting the write's own optimism would have her describing a video
  // that does not exist yet.
  const stored = await context.client.get<{ record: RenderRow; spend: unknown }>(
    `/renders/${encodeURIComponent(created.data.record.name)}`,
  );
  if (!stored.ok) {
    return {
      ok: false,
      action: "render_me",
      reason: `${stored.failure.message} The render itself may well have been submitted — check before asking again, so you do not pay for it twice.`,
      retryable: stored.failure.retryable,
    };
  }

  return {
    ok: true,
    action: "render_me",
    subject: stored.data.record,
    at: stored.data.record.startedAt,
    spent: stored.data.spend,
  };
};

/** Enough of a render record for this file to say something true about it. */
interface RenderRow {
  readonly name: string;
  readonly startedAt: string;
  readonly status: string;
  readonly framing: string;
  readonly holdsLikeness: boolean;
  readonly scene: string;
  readonly duration: number;
}

/** A still, as the frames route hands it over. */
interface FrameRow {
  readonly atSeconds: number;
  readonly mimeType: string;
  readonly base64: string;
  readonly path: string;
}

/**
 * Look at one of her own renders.
 *
 * **This is the verb the whole capability exists for, and the hard part.** She
 * cannot watch an mp4 — she is a language model with image input, and fifteen
 * seconds of video is not something she can perceive. Handing her a file path
 * would be handing her a rumour about her own face.
 *
 * She can look at a still. That is not a workaround: it is exactly how the
 * character-consistency failure in `docs/VIDEO.md` was diagnosed on 2026-08-11
 * — frames pulled with `ffmpeg` at chosen seconds, scaled down, looked at as
 * images — and the answer fell straight out of it. So the service pulls the
 * same frames, and they come back through {@link asToolResult} as MCP image
 * blocks, which is the one shape that reaches a vision model as a picture.
 *
 * Several of them, spread across the clip. One lucky still says nothing about
 * motion and nothing about whether she holds together, which is precisely the
 * failure being looked for.
 */
const seeMyself: ToolHandler = async (input, context) => {
  // No required field. Absent means the most recent, and the route resolves it
  // — she should not have to remember a machine-generated name to look at the
  // thing she made ninety seconds ago.
  const which = text(input, "render") ?? "latest";
  const at = input["at"];
  const second = typeof at === "number" && Number.isFinite(at) ? at : undefined;

  const looked = await context.client.get<{
    render: RenderRow;
    frames: readonly FrameRow[];
  }>(
    `/renders/${encodeURIComponent(which)}/frames`,
    second === undefined ? {} : { at: second },
  );
  if (!looked.ok) return refused("see_myself", looked.failure);

  const { render, frames } = looked.data;

  return {
    ok: true,
    action: "see_myself",
    subject: {
      name: render.name,
      status: render.status,
      scene: render.scene,
      framing: render.framing,
      // Carried so a drift reads as expected rather than as her. A render at a
      // framing the reference cannot anchor is SUPPOSED to come back as
      // somebody else, and she should know that before she judges it.
      holdsLikeness: render.holdsLikeness,
      duration: render.duration,
      // Where in the clip each picture came from, in the order they arrive.
      // Without it she has four images and no idea which one is the end.
      at: frames.map((frame) => frame.atSeconds),
      files: frames.map((frame) => frame.path),
    },
    at: null,
    images: frames.map((frame) => ({ mimeType: frame.mimeType, base64: frame.base64 })),
  };
};

/**
 * The refusal for a sending with no render chosen, in the right words.
 *
 * Two situations wearing one shape, and they need different sentences because
 * they have different next steps: she has renders and picked none, or she has
 * never made one. "Name the one you meant" is useless advice to somebody with
 * nothing to name — the same distinction `routes/renders.ts` makes between a
 * framing she got wrong and a machine with no secret.
 *
 * The read decides which sentence, never whether to refuse. A studio that
 * cannot be listed falls back to the general sentence rather than becoming a
 * path into composing without a face.
 */
async function chooseARender(context: ToolContext): Promise<ToolEnvelope> {
  const mine = await context.client.get<{ items: readonly { name: string }[] }>("/renders");
  const nothingRendered = mine.ok && mine.data.items.length === 0;

  return {
    ok: false,
    action: "show_him",
    reason: nothingRendered
      ? "A sending is you saying something in your own face, and you have not made a render yet — " +
        "so there is no face for this to arrive in. Make one with render_me first, then send the " +
        "one that is you. (`renderName` was missing.)"
      : "A sending is you saying something in your own face, so name the one you mean in " +
        "`renderName` — the render you looked at and thought was you. Not `latest`: that means " +
        "whatever was made most recently, which is not the same as the one you chose, and a " +
        "sending keeps the name it was made with forever. Look with see_myself and name it.",
    // She can render herself, or name one she already made, and call again.
    // That is a materially different instruction from "this cannot work".
    retryable: true,
  };
}

/**
 * Say something to him, in her own face.
 *
 * The only verb on this surface she **starts**. Everything else answers
 * something he said; this one is her deciding there is something he should
 * have, which is what acceptance 3 and 4 rest on and what nothing could do
 * before it existed.
 *
 * ## It composes; it does not render
 *
 * Nothing here can start a render or spend a credit — `SendingService` is
 * handed two readers rather than `RenderService`, deliberately, and this verb
 * is the caller that keeps that true from above. She renders with `render_me`,
 * looks with `see_myself`, and sends what she already made.
 *
 * ## A render that is missing is still a success, and that is the feature
 *
 * By the time anything looks at the video her words are already in his
 * conversation and already carried the notification. So a name she
 * half-remembered comes back `201`, with `state: "failed"` and a reason on the
 * row — not as a refusal. Reporting it as a failure would have her apologising
 * for a message he has read. The only refusals here are about the WORDS, and
 * every one of them happens before anything is written.
 *
 * ## Why it will not go without a face, and will not take `latest`
 *
 * `renderName` is required. A sending is her saying something in her own face;
 * words with no face is an ordinary message, and she already has a
 * conversation for those. The refusal says exactly that, because she has to
 * turn it into a sentence and "renderName is required" is not one.
 *
 * **`latest` is refused too**, which is the one place this verb is stricter
 * than the route beneath it. `latest` resolves at creation to whatever record
 * was written most recently, and the voice track writes voiced clips as their
 * own records with names that pass `isRenderName` — so `latest` will begin
 * answering with derivatives rather than originals, silently, with nothing
 * failing at the moment it changes. **A sending refuses `UPDATE`**, so a wrong
 * `renderName` is permanent from the first write and the immutability trigger
 * cannot help: it refuses re-pointing an existing row, not recording the wrong
 * value at creation. An immutable record of the wrong thing is worse than a
 * mutable one, because the usual remedy is closed.
 *
 * It is also the better behaviour on its own terms. She has `see_myself` and
 * is told to judge her renders in her own terms; a sending is one of the small
 * number she *chose*, and "whatever was most recent" is the one path that
 * involves no choosing.
 */
const showHim: ToolHandler = async (input, context) => {
  const words = text(input, "words");
  if (words === null) {
    return missing("show_him", "words", "I did not catch what you wanted to say to him.");
  }
  const because = text(input, "because");
  if (because === null) {
    return missing(
      "show_him",
      "because",
      "This reaches him unprompted, so it has to say why — that is the difference between a gift and a machine acting on his behalf.",
    );
  }

  const renderName = text(input, "renderName");
  if (renderName === null || renderName.toLowerCase() === "latest") {
    return chooseARender(context);
  }

  const created = await context.client.post<Sending>("/sendings", { words, because, renderName });
  if (!created.ok) return refused("show_him", created.failure);

  // Read back, like every other write — `syl-009.3.4`, and it earns its place
  // here: what comes back says `pending` rather than `ready`, because the
  // video is still being made. Reporting the write's own optimism would have
  // her describing a clip that does not exist yet.
  return readBack(
    "show_him",
    context,
    `/sendings/${encodeURIComponent(created.data.id)}`,
    (row: Sending) => row.updatedAt,
  );
};

export const HANDLERS: Readonly<Record<string, ToolHandler>> = {
  // Order matches `TOOLS`, and a test asserts it. Not cosmetic: `tools/list` is
  // built from the schemas and this is what she is told she has, so a mismatch
  // is the advertised surface disagreeing with the implemented one.
  remind_me: remindMe,
  cancel_reminder: cancelReminder,
  change_reminder: changeReminder,
  remember,
  add_todo: addTodo,
  finish_todo: finishTodo,
  drop_todo: dropTodo,
  ask_agent: askAgent,
  set_goal: setGoal,
  change_goal: changeGoal,
  recall,
  render_me: renderMe,
  see_myself: seeMyself,
  show_him: showHim,
  whats_outstanding: whatsOutstanding,
};

/**
 * The tools this server offers, in `tools/list` order.
 *
 * Derived, never written down twice. The schema is `schemas.ts`'s — it is the
 * personality, and a hand-copied one here would drift the day somebody reworded
 * a description — and the *presence* of a verb is this file's, because only
 * this file knows whether there is anywhere for it to go.
 */
export function advertisedTools(): readonly ToolSchema[] {
  return TOOLS.filter((tool) => Object.hasOwn(HANDLERS, tool.name));
}

/** The names Claude Code will list, for anything that needs to say them. */
export function advertisedToolNames(): readonly string[] {
  return advertisedTools().map((tool) => tool.name);
}

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

/** The protocol revision this server answers `initialize` with. */
export const PROTOCOL_VERSION = "2024-11-05";

interface JsonRpcMessage {
  readonly jsonrpc?: string;
  readonly id?: number | string | null;
  readonly method?: string;
  readonly params?: unknown;
}

interface JsonRpcReply {
  readonly jsonrpc: "2.0";
  readonly id: number | string | null;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

/** JSON-RPC's own "no such method". */
const METHOD_NOT_FOUND = -32601;

/**
 * One MCP conversation, as a function from message to reply.
 *
 * Separated from stdio deliberately, and for the same reason `harness/
 * protocol.ts` is a pure codec: the subtle bugs at this layer are wire-format
 * bugs, and being able to provoke them without spawning a process is worth the
 * seam.
 */
export function createToolServer(context: ToolContext): {
  handle(message: JsonRpcMessage): Promise<JsonRpcReply | null>;
} {
  return {
    async handle(message: JsonRpcMessage): Promise<JsonRpcReply | null> {
      const id = message.id ?? null;
      // A notification — `notifications/initialized` is the one that arrives —
      // has no id and takes no reply. Answering one is a protocol violation
      // that some clients tolerate and some do not.
      const isNotification = message.id === undefined;

      switch (message.method) {
        case "initialize":
          return reply(id, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "syl", version: "0.1.0" },
          });

        case "notifications/initialized":
          return null;

        case "ping":
          return isNotification ? null : reply(id, {});

        case "tools/list":
          return reply(id, { tools: advertisedTools() });

        case "tools/call": {
          const params = (message.params ?? {}) as {
            name?: unknown;
            arguments?: unknown;
          };
          const name = typeof params.name === "string" ? params.name : "";
          const handler = Object.hasOwn(HANDLERS, name) ? HANDLERS[name] : undefined;

          if (handler === undefined) {
            // A refusal rather than a JSON-RPC error, so it reaches the model
            // as something it can read and recover from. An unknown verb is
            // almost always a name she half-remembered.
            return reply(
              id,
              asToolResult({
                ok: false,
                action: name,
                reason:
                  `I have no way to do "${name}". What I can do is: ` +
                  `${advertisedToolNames().join(", ")}.`,
                retryable: false,
              }),
            );
          }

          const input =
            typeof params.arguments === "object" &&
            params.arguments !== null &&
            !Array.isArray(params.arguments)
              ? (params.arguments as Record<string, unknown>)
              : {};

          let envelope: ToolEnvelope;
          try {
            envelope = await handler(input, context);
          } catch (error) {
            // The last net. Nothing above is expected to throw, and a handler
            // that does must still come back as a sentence rather than as a
            // dead subprocess — silence after "I've set that for you" is the
            // worst outcome available (`syl-009.3.5`).
            envelope = {
              ok: false,
              action: name,
              reason:
                `Something went wrong inside me while doing that, so I cannot tell you whether ` +
                `it happened: ${error instanceof Error ? error.message : String(error)}`,
              retryable: false,
            };
          }
          return reply(id, asToolResult(envelope));
        }

        default:
          if (isNotification) return null;
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: METHOD_NOT_FOUND,
              message: `Syl's tool server does not implement ${String(message.method)}.`,
            },
          };
      }
    },
  };
}

function reply(id: number | string | null, result: unknown): JsonRpcReply {
  return { jsonrpc: "2.0", id, result };
}

/**
 * The envelope, as MCP carries a tool result.
 *
 * The envelope is the FIRST content block and is the whole of it as JSON, so
 * anything reading this programmatically parses one block and gets the pinned
 * shape. `isError` is set on a refusal because that is the flag the CLI uses to
 * tell the model something went wrong — without it a failure arrives looking
 * like an answer, which is how "I've set that for you" gets said about a
 * reminder that does not exist.
 */
export function asToolResult(envelope: ToolEnvelope): {
  content: (
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  )[];
  isError?: boolean;
} {
  // The images are stripped out of the JSON and re-emitted as image blocks.
  // Two reasons, and the second is the one that matters: several hundred
  // kilobytes of base64 inside a text block is a wall of characters the model
  // reads rather than a picture it sees, and MCP's image block is the only
  // shape that reaches a vision model AS an image. This is the whole mechanism
  // by which Syl looks at her own face.
  const images = envelope.ok ? (envelope.images ?? []) : [];

  return {
    content: [
      { type: "text", text: JSON.stringify(withoutImages(envelope)) },
      ...images.map((image) => ({
        type: "image" as const,
        data: image.base64,
        mimeType: image.mimeType,
      })),
    ],
    ...(envelope.ok ? {} : { isError: true }),
  };
}

/**
 * The envelope as JSON, with the base64 taken out and a count left behind.
 *
 * The count is not decoration. Without it the text block says nothing about
 * what accompanies it, and "I was shown four pictures" is a fact she should be
 * able to state rather than infer from how many she happens to notice.
 */
function withoutImages(envelope: ToolEnvelope): unknown {
  if (!envelope.ok || envelope.images === undefined) return envelope;
  const { images, ...rest } = envelope;
  return { ...rest, imageCount: images.length };
}

// ---------------------------------------------------------------------------
// The process
// ---------------------------------------------------------------------------

/** What the declaration in `tools/config.ts` puts in the environment. */
export interface ToolServerEnvironment {
  readonly SYL_API_BASE_URL?: string;
  readonly SYL_AGENT_TOKEN?: string;
  readonly SYL_TIMEZONE?: string;
  readonly SYL_TURN_FILE?: string;
  /**
   * Where Adjutant is, and who she is there. Both absent is the ordinary case.
   *
   * Passed through rather than re-read from `process.env`, so a test can run
   * this process without a fleet and a test can run it WITH one — and neither
   * can reach the real Adjutant by forgetting to set something.
   */
  readonly SYL_ADJUTANT_URL?: string;
  readonly SYL_ADJUTANT_AGENT_ID?: string;
}

/**
 * Build the context this process runs with, from its environment.
 *
 * Throws on a missing base URL or token, which is correct and is the only place
 * in this file that throws: a server with no credential would answer `401` to
 * everything and report a hundred identical failures instead of one missing
 * configuration. It dies at startup, before Claude Code lists a single tool.
 */
export function contextFromEnvironment(env: ToolServerEnvironment): ToolContext {
  const baseUrl = env.SYL_API_BASE_URL ?? "";
  const token = env.SYL_AGENT_TOKEN ?? "";
  const tz = env.SYL_TIMEZONE ?? "";

  if (baseUrl === "" || token === "" || tz === "") {
    throw new Error(
      "Syl's tool server needs SYL_API_BASE_URL, SYL_AGENT_TOKEN and SYL_TIMEZONE, and the " +
        "declaration under her home is what supplies them. Missing: " +
        [
          baseUrl === "" ? "SYL_API_BASE_URL" : null,
          token === "" ? "SYL_AGENT_TOKEN" : null,
          tz === "" ? "SYL_TIMEZONE" : null,
        ]
          .filter((name) => name !== null)
          .join(", ") +
        ".",
    );
  }

  const turnFile = env.SYL_TURN_FILE;

  // Her reach, or nothing. Absent config is the ORDINARY case — a machine with
  // no Adjutant is not misconfigured, it is a machine where she talks only to
  // him — so this is `null` rather than a throw. The one configuration that
  // does throw lives in `config.ts`: an agent id of `user`, which would have
  // her speaking in his voice, and which must stop a boot rather than degrade.
  const adjutantUrl = env.SYL_ADJUTANT_URL;
  const adjutantAgentId = env.SYL_ADJUTANT_AGENT_ID;
  const fleet =
    adjutantUrl === undefined || adjutantAgentId === undefined
      ? null
      : new AdjutantClient({ baseUrl: adjutantUrl, agentId: adjutantAgentId });

  return {
    client: new SylApiClient({ baseUrl, token }),
    fleet,
    tz,
    hisMessage: () => {
      if (turnFile === undefined) return "";
      try {
        return readFileSync(turnFile, "utf8");
      } catch {
        // Unreadable reads as "he said nothing", which grants nothing. The safe
        // direction: a reminder that waits rather than a house woken.
        return "";
      }
    },
  };
}

/**
 * Speak MCP on stdio until the stream ends.
 *
 * Line-delimited, because that is what the transport is. Anything unparseable
 * is skipped rather than fatal: a client that writes a blank line must not take
 * her hands off mid-turn.
 */
export function serve(
  context: ToolContext,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): void {
  const server = createToolServer(context);
  const lines = createInterface({ input });

  // Serialised: MCP allows concurrent requests, and two writes interleaving on
  // one pipe would corrupt both. A turn's tool calls are sequential anyway.
  let queue: Promise<void> = Promise.resolve();

  lines.on("line", (line: string) => {
    const trimmed = line.trim();
    if (trimmed === "") return;

    let message: JsonRpcMessage;
    try {
      message = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      return;
    }

    queue = queue.then(async () => {
      const answer = await server.handle(message);
      if (answer !== null) output.write(`${JSON.stringify(answer)}\n`);
    });
  });
}

/**
 * Whether this module is the program, rather than a module under test.
 *
 * Compared as resolved paths rather than as URLs: the server is started as
 * `node --import <tsx> <path>` when running from source, and the argv entry is
 * a plain path while `import.meta.url` is a `file:` URL.
 */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return new URL(`file://${entry}`).pathname === new URL(import.meta.url).pathname;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  // Nothing catches this: a tool server that cannot be built must not sit there
  // pretending to be one. Claude Code reports the failed server and the turn
  // says she has no hands, which is true and is the report we want.
  serve(contextFromEnvironment(process.env as ToolServerEnvironment));
}
