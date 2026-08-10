import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

import type { Goal, HealthStatus, Reminder, Todo } from "@syl/shared";

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
 * `remember` is declared there and is absent **here**, for the same reason one
 * step later: `AGENT_SURFACE` is `/reminders`, `/todos`, `/goals`, there is no
 * route that writes a memory, and `middleware/auth.ts` argues at length that
 * adding one must be a decision rather than a side effect of some other change.
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

  const created = await context.client.post<Reminder>("/reminders", {
    text: errand,
    ...reminderInputFrom(resolution),
    urgent,
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

export const HANDLERS: Readonly<Record<string, ToolHandler>> = {
  // Order matches `TOOLS`, and a test asserts it. Not cosmetic: `tools/list` is
  // built from the schemas and this is what she is told she has, so a mismatch
  // is the advertised surface disagreeing with the implemented one.
  remind_me: remindMe,
  cancel_reminder: cancelReminder,
  change_reminder: changeReminder,
  add_todo: addTodo,
  finish_todo: finishTodo,
  drop_todo: dropTodo,
  set_goal: setGoal,
  change_goal: changeGoal,
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
  content: { type: "text"; text: string }[];
  isError?: boolean;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(envelope) }],
    ...(envelope.ok ? {} : { isError: true }),
  };
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

  return {
    client: new SylApiClient({ baseUrl, token }),
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
