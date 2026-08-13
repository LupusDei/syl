import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

import type { Goal, HealthStatus, Reminder, ReminderOrigin, Sending, Todo } from "@syl/shared";

import { AdjutantClient } from "../agents/adjutant-client.js";
import { mayReach, notOnTheRoster } from "../agents/roster.js";

import { verifyUrgency } from "../harness/urgency.js";
import { sightingOf } from "../render/pictures.js";

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
       * What this verb has spent of what it is allowed to spend.
       *
       * Renders, in credits, and readings against `READS_PER_DAY`. Optional and
       * additive: every other verb omits it and every existing reader ignores
       * it. It rides on the answer rather than waiting behind a verb she would
       * have to think to call, because the Commander removed the gate and
       * visibility is what is left — same rule as `because`, evidence
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
       *
       * **`sighting` is required, and that is the point.** A picture she cannot
       * name is a picture she cannot choose, so the type makes handing her one
       * unrepresentable rather than leaving it to each code path to remember.
       * Build these with {@link shown} and nothing else.
       */
      readonly images?: readonly Shown[];
    }
  | {
      readonly ok: false;
      readonly action: string;
      /** A complete sentence, addressed to him. Never a code, never empty. */
      readonly reason: string;
      readonly retryable: boolean;
    };

/** A picture she is handed, and the token that names it. */
export interface Shown {
  readonly mimeType: string;
  readonly base64: string;
  /** The digest of exactly these bytes. See {@link shown}. */
  readonly sighting: string;
}

/**
 * A picture, named by the bytes she is about to be shown.
 *
 * **The token is a property of the act of being shown, not of where the picture
 * was stored.** That distinction is the whole of `syl-ate`'s defect: sightings
 * were computed for wardrobe rows, so the one face she could adopt was the one
 * an engineer guessed before anyone knew her, and the still she actually wanted
 * — an unsmiling frame nine and a half seconds into a render — arrived as a
 * picture she could look at and could not promote.
 *
 * Computed **here**, from the base64 that becomes the image block, rather than
 * read off whatever the service said about the file. Upstream describes a file;
 * this describes what crossed. If those ever differ — a resize for the turn, a
 * truncated read — trusting upstream would hand her a token for a picture she
 * did not see, which is the one thing the mechanism exists to prevent. Failing
 * closed, with a token her wardrobe does not recognise, is the safe direction.
 *
 * The guarantee is unchanged and unweakened: `sightingOf` is a digest of image
 * bytes, so it cannot be derived from a filename, guessed from a name, or
 * produced for anything she was not handed.
 */
export function shown(picture: { readonly mimeType?: string; readonly base64: string }): Shown {
  return {
    mimeType: picture.mimeType ?? "image/jpeg",
    base64: picture.base64,
    sighting: sightingOf(Buffer.from(picture.base64, "base64")),
  };
}

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

  // `dueAt` and `pinned` are what the agenda sorts on, and until `syl-74p`
  // neither could be set — every to-do landed undated and unpinned, so a view
  // of his day was empty by construction however well she planned it. Only
  // forwarded when given: `POST /todos` defaults both, and sending an explicit
  // null for every undated to-do would be noise on the wire.
  const created = await context.client.post<Todo>("/todos", {
    text: errand,
    ...todoScheduleFrom(input),
  });
  if (!created.ok) return refused("add_todo", created.failure);

  return readBack("add_todo", context, `/todos/${encodeURIComponent(created.data.id)}`, (row: Todo) => row.updatedAt);
};

/**
 * The `dueAt`/`pinned` half of a to-do write, read off a tool call.
 *
 * **`dueAt` is genuinely three-valued and the route already models all three:**
 * absent means leave it alone, `null` means take the date off, and a string
 * means set it. Collapsing null into absent would make "actually, no date on
 * that" unsayable — and a retraction she cannot say is how his list stops
 * matching what he believes about it.
 */
function todoScheduleFrom(input: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};

  const dueAt = input["dueAt"];
  if (dueAt === null) patch["dueAt"] = null;
  else if (typeof dueAt === "string" && dueAt.trim() !== "") patch["dueAt"] = dueAt;

  if (typeof input["pinned"] === "boolean") patch["pinned"] = input["pinned"];

  return patch;
}

/** Date, move, undate or pin something already on his list. */
const scheduleTodo: ToolHandler = async (input, context) => {
  const id = text(input, "id");
  if (id === null) {
    return missing("schedule_todo", "id", "I need to know which one — ask me what is outstanding.");
  }
  if (text(input, "because") === null) {
    return missing("schedule_todo", "because", "Every change to his list carries its reason.");
  }

  const patch = todoScheduleFrom(input);
  if (Object.keys(patch).length === 0) {
    // Nothing to do is not the same as done. A silent no-op reads to her as
    // success, and she tells him it moved.
    return {
      ok: false,
      action: "schedule_todo",
      reason:
        "I did not catch what to change about that one. " +
        "Tell me the new date, or that the date comes off, or that it should be pinned.",
      retryable: false,
    };
  }

  const path = `/todos/${encodeURIComponent(id)}`;
  const changed = await context.client.patch<Todo>(path, patch);
  if (!changed.ok) return refused("schedule_todo", changed.failure);

  return readBack("schedule_todo", context, path, (row: Todo) => row.updatedAt);
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

  const kept = await context.client.post<{ readonly at: string; readonly created: boolean }>(
    "/memory/remember",
    {
      thought,
      because,
      ...(about.length === 0 ? {} : { about }),
    },
  );
  if (!kept.ok) return refused("remember", kept.failure);

  // **`created` is carried, not dropped. `syl-018`.**
  //
  // This returned a bare `ok: true` whichever happened, so a reused node — the
  // correct, deliberate behaviour when she reaches the same conclusion twice —
  // was reported to her as a fresh write. She found it herself, and only because
  // she went looking:
  //
  // > "That's the dangerous class of failure: not an error, a false
  // >  confirmation. If I hadn't verified, I'd have told you four things were
  // >  saved and two of them would simply not exist tomorrow."
  //
  // The same shape as `syl-y82`, where `remind_me` required a `because` and
  // discarded it: a value computed correctly one layer down, dropped by the
  // layer above, and the caller told something that is not true. `HerOwnMemory`
  // has always returned this honestly.
  //
  // **Reuse is not failure and is not reported as one** — `ok` stays true. What
  // she is owed is which of the two happened, because "I saved that" and "I had
  // already saved that" are different sentences to say to him, and only one of
  // them is true at a time.
  //
  // Nothing is lost when a memory is reused: identity matches the label AND the
  // body exactly (`MEMORY_IDENTITY_SQL`), so a reused node is one she wrote in
  // the same words, not a near-miss quietly collapsed into an older thought.
  return {
    ok: true,
    action: "remember",
    created: kept.data.created,
    ...(kept.data.created
      ? {}
      : {
          note:
            "You had already written this, in these words, and that memory still stands — " +
            "nothing was overwritten and nothing was added.",
        }),
    subject: kept.data,
    at: kept.data.at,
  };
};

/**
 * How he has been, in his own numbers.
 *
 * The verb that was missing (`syl-t9tj.5.4`). Two months of his health data sat
 * on disk and she had no way to reach it mid-conversation, so when he asked she
 * said she could not see it -- correctly, and that was the whole defect.
 *
 * Returns DERIVATIONS, never samples. 28,726 heart-rate rows do not fit in a
 * turn, and an arbitrary slice is worse than none: she would answer confidently
 * from whichever fortnight happened to fit.
 *
 * `silenceIsEvidence` rides on every type, and she must read it before saying a
 * number is missing. `authorised` and empty means nothing happened -- "you took
 * no steps this week". Anything else means WE NEVER LOOKED, and the honest
 * sentence is "I have never been able to see your heart rate variability".
 * Reporting the second as the first is a claim about his body drawn from a
 * permission dialog.
 */
const howHasHeBeen: ToolHandler = async (input, context) => {
  const asked = input["types"];
  const types = (Array.isArray(asked) ? asked : [])
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value !== "");

  const path = types.length === 0 ? "/health/summary" : `/health/summary?types=${encodeURIComponent(types.join(","))}`;
  const looked = await context.client.get<unknown>(path);
  if (!looked.ok) return refused("how_has_he_been", looked.failure);

  return { ok: true, action: "how_has_he_been", subject: looked.data, at: null };
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

  // The two dials, passed through only when she set them. Omitting them is
  // what keeps a render she said nothing about identical to every render made
  // before she could choose — fifteen seconds, opening on the ribbon.
  const seconds = input["seconds"];
  const opening = text(input, "opening");
  const created = await context.client.post<{ record: { id?: string; name: string } }>("/renders", {
    scene,
    framing,
    because: text(input, "because"),
    ...(typeof seconds === "number" ? { seconds } : {}),
    ...(opening === null ? {} : { opening }),
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

/** One kept picture, as the wardrobe hands it over. */
interface WardrobeRow {
  readonly id: string;
  readonly because: string;
  readonly at: string;
  readonly current: boolean;
  readonly ratio: string | null;
  readonly from: { readonly render: string; readonly atSeconds: number } | null;
  readonly mimeType?: string;
  readonly base64?: string;
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
  // `of` widens the same act rather than adding verbs for it (`syl-ate`).
  // Anything she can set she must be able to see, and there are three things
  // she can now set: her likeness, her openings, and what she has made.
  const of = text(input, "of");
  if (of === "faces" || of === "openings") return lookAtWardrobe(of, context);
  if (of === "renders") return readTheLog(context);

  // No required field. Absent means the most recent, and the route resolves it
  // — she should not have to remember a machine-generated name to look at the
  // thing she made ninety seconds ago.
  const which = text(input, "render") ?? "latest";
  const at = input["at"];
  const second = typeof at === "number" && Number.isFinite(at) ? at : undefined;

  const looked = await context.client.get<{
    render: RenderRow;
    frames: readonly FrameRow[];
    verdicts?: readonly { verdict: string; at: string }[];
  }>(
    `/renders/${encodeURIComponent(which)}/frames`,
    second === undefined ? {} : { at: second },
  );
  if (!looked.ok) return refused("see_myself", looked.failure);

  const { render, frames, verdicts } = looked.data;

  // WHAT SHE ALREADY CONCLUDED, arriving with the pictures rather than from a
  // second call. This is the half that makes `judge_render` a loop rather than
  // a diary — "a hundred renders with no record of what I made of them isn't a
  // hundred attempts, it's one attempt made a hundred times".
  const alreadySaid = (verdicts ?? []).map((row) => row.verdict);

  // Every still, named by its own bytes. A picture she is shown and cannot
  // adopt is the defect this closes: the frame she wanted was nine seconds into
  // a render and reachable only through here.
  const pictures = frames.map((frame) => shown(frame));

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
      // What she quotes to `this_is_me`, in the same order as `at`, because the
      // image blocks carry pixels and nothing she can read back. Without this
      // she can look at a still and cannot choose it — which is how the only
      // adoptable face stayed the one he guessed before he knew her.
      sightings: pictures.map((picture) => picture.sighting),
      // Newest first. Empty on the first look, which is honest rather than
      // empty-as-in-broken: she has not judged this one yet.
      alreadySaid,
    },
    at: null,
    images: pictures,
  };
};

/**
 * Look at every face she has had, or every opening she can start from.
 *
 * **The pictures are the point, not the list.** Judging whether a likeness is
 * hers from a name and a date is exactly the thing `see_myself` exists to make
 * impossible, and adopting one is a change to every render she makes
 * afterwards. So this returns image blocks for the ones it can, and the token
 * that names a picture rides on the row *only* where the picture does — which
 * is what keeps `this_is_me` unable to take a picture she has not seen.
 *
 * The rows without pictures are still returned. Her history is not truncated;
 * only the bytes are, because only the bytes are what a turn cannot carry.
 */
async function lookAtWardrobe(
  of: "faces" | "openings",
  context: ToolContext,
): Promise<ToolEnvelope> {
  const role = of === "faces" ? "face" : "opening";
  const looked = await context.client.get<{
    items: readonly WardrobeRow[];
    problems?: readonly string[];
  }>("/renders/wardrobe", { role });
  if (!looked.ok) return refused("see_myself", looked.failure);

  const { items, problems } = looked.data;

  // The picture and its token, made together, so a row can never carry the name
  // of a picture other than the one attached to it — and a row with no picture
  // carries no name, which is the half that keeps her from adopting a face she
  // has only read about.
  const rows = items.map((item) => ({
    row: item,
    picture: item.base64 === undefined ? null : shown({ ...item, base64: item.base64 }),
  }));

  return {
    ok: true,
    action: "see_myself",
    subject: {
      of,
      items: rows.map(({ row, picture }) => ({
        id: row.id,
        because: row.because,
        at: row.at,
        current: row.current,
        // What a render made through this picture comes out as. On an opening
        // it is the whole reason the choice is visible: the opening decides
        // the shape, and she should know that before she picks one.
        ratio: row.ratio,
        from: row.from,
        sighting: picture?.sighting ?? null,
      })),
      // Empty on every ordinary machine. Anything else is a file a person has
      // to go and look at, and until one does she is not told which face is hers.
      problems: problems ?? [],
    },
    at: null,
    images: rows.flatMap(({ picture }) => (picture === null ? [] : [picture])),
  };
}

/**
 * The whole log: what she asked for, what it came out as, and what she said.
 *
 * `SOUL.md`: *"a hundred attempts with no record of what you thought at the
 * time is not a hundred attempts, it is one attempt made a hundred times."* The
 * sidecars have always held what produced each file and the verdicts have held
 * what she made of it; this is the read that puts them in front of her, because
 * a journey she cannot review is not one she can learn from.
 *
 * No images. Four stills of one render is a look; four stills of every render
 * is a turn with nothing left in it. This is the index — she picks one out of
 * it and looks at that.
 */
async function readTheLog(context: ToolContext): Promise<ToolEnvelope> {
  const looked = await context.client.get<{
    items: readonly (RenderRow & {
      readonly ratio: string;
      readonly reference: string;
      readonly anchor: string | null;
      readonly because: string;
      readonly credits: number | null;
    })[];
    unreadable?: readonly { name: string; why: string }[];
    verdicts?: readonly { render: string; verdict: string; at: string }[];
    spend?: unknown;
  }>("/renders");
  if (!looked.ok) return refused("see_myself", looked.failure);

  return {
    ok: true,
    action: "see_myself",
    subject: {
      of: "renders",
      items: looked.data.items.map((record) => ({
        name: record.name,
        status: record.status,
        startedAt: record.startedAt,
        scene: record.scene,
        because: record.because,
        framing: record.framing,
        // Everything she can set, read back. A dial she cannot see is a dial
        // she cannot learn from — which is why `seconds`, the opening and the
        // likeness are all here rather than only in the file on disk.
        duration: record.duration,
        shape: record.ratio,
        opening: record.reference,
        face: record.anchor,
        holdsLikeness: record.holdsLikeness,
        credits: record.credits,
      })),
      unreadable: looked.data.unreadable ?? [],
      verdicts: looked.data.verdicts ?? [],
    },
    at: null,
    spent: looked.data.spend,
  };
}

/**
 * Settle on a picture she has looked at.
 *
 * Both required fields are refused **here**, before anything is asked for. The
 * wardrobe refuses them too, and that is not duplication: a verb whose own
 * contract lets a field through and relies on the layer beneath to object is a
 * verb whose contract says the field is optional.
 */
const thisIsMe: ToolHandler = async (input, context) => {
  const sighting = text(input, "sighting");
  if (sighting === null) {
    return missing(
      "this_is_me",
      "sighting",
      "I can only settle on a picture I have actually looked at. Look at it first — the token " +
        "comes back beside the image — and give me that.",
    );
  }
  const because = text(input, "because");
  if (because === null) {
    return missing(
      "this_is_me",
      "because",
      "Say what is more me about this one than the last. A likeness that changes with no reason " +
        "recorded is the drift he asked me never to have.",
    );
  }

  const as = text(input, "as") === "opening" ? "opening" : "face";
  const name = text(input, "name");
  const kept = await context.client.post<{ kept: WardrobeRow }>("/renders/wardrobe", {
    sighting,
    as,
    because,
    ...(name === null ? {} : { name }),
  });
  if (!kept.ok) return refused("this_is_me", kept.failure);

  return { ok: true, action: "this_is_me", subject: kept.data.kept, at: kept.data.kept.at ?? null };
};

/** Keep what she made of a render, after looking at it. */
const judgeRender: ToolHandler = async (input, context) => {
  const verdict = text(input, "verdict");
  if (verdict === null) {
    return missing(
      "judge_render",
      "verdict",
      "I did not catch what you made of it. Say what was closer and what was wrong.",
    );
  }

  if (text(input, "because") === null) {
    return missing(
      "judge_render",
      "because",
      "Tell me why you were looking — whether he asked, or you came back to it yourself.",
    );
  }

  // Same default as `see_myself`, and for the same reason: she should be able
  // to judge the thing she is looking at without knowing its generated name.
  const which = text(input, "render") ?? "latest";

  const kept = await context.client.post<{ readonly at: string }>(
    `/renders/${encodeURIComponent(which)}/verdicts`,
    { verdict },
  );
  if (!kept.ok) return refused("judge_render", kept.failure);

  return { ok: true, action: "judge_render", subject: kept.data, at: kept.data.at };
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
 * ## A render that is not finished is a refusal, and that is the feature
 *
 * The opposite of what this said until the Commander's ruling of 2026-08-11,
 * and the reversal is the point. A name she half-remembered, or a clip that is
 * still rendering, used to come back `201` with `state: "failed"` on the row —
 * on the grounds that her words had already been said and already carried the
 * notification, so reporting a failure would have her apologising for a message
 * he had read. What that actually produced was **a buzz about a video that did
 * not exist**.
 *
 * So `POST /sendings` now resolves the render first and refuses one that is not
 * `ready`, before a message exists. She gets a sentence saying which render and
 * why, and nothing has reached him — which is a thing she can act on. The
 * ordinary way to reach this verb is `jobs/render-review-job.ts`, which wakes
 * her five minutes after a render starts, on a turn whose whole subject is that
 * clip; by then it is finished and this refusal never fires.
 *
 * Every refusal here still happens before anything is written.
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
  // playable copy is still being compressed out of a render that has already
  // finished. Reporting the write's own optimism would have her describing a
  // clip that is not on the row yet.
  return readBack(
    "show_him",
    context,
    `/sendings/${encodeURIComponent(created.data.id)}`,
    (row: Sending) => row.updatedAt,
  );
};

/**
 * A reading, as the intake route hands it over.
 *
 * Declared here rather than imported from `connections/intake-view.ts`, like
 * `RenderRow` and `WardrobeRow` above it — and on this one the convention is
 * load-bearing rather than tidy. `reader-containment.test.ts` asserts that
 * **nothing under `src/` outside `connections/` imports that module**, which is
 * how "exactly one door out of the quarantine" stays a property a grep can
 * check. A type-only import would still be an import, and would spend that
 * assertion's meaning on a convenience.
 *
 * The same file asserts that nothing under `tools/` imports `intake-store.ts`
 * either. This handler runs holding MCP tools, and the store's row is where
 * `title` and the raw `failure` live.
 *
 * It carries no `title` and no `failure`, and that is the whole shape of the
 * route's answer rather than a subset this file chose. See `intake-view.ts`.
 */
interface ReadingRow {
  readonly id: string;
  readonly url: string;
  readonly stage: string;
  readonly updatedAt: string;
  readonly refusal: { readonly says: string; readonly retryable: boolean } | null;
  readonly read: unknown;
}

/** What both intake operations answer with. */
interface IntakeAnswer {
  readonly reading: ReadingRow;
  readonly reads: unknown;
}

/**
 * Point her reading at a page, and hand back what crossed the gate.
 *
 * `syl-r1t`. Everything underneath this was already built and connected to
 * nothing she could reach: the address guard, the parser, the sealed reader
 * turn, the schema gate, the store. The gap was that her surface was seven
 * paths and `/intake` was not among them, so she read what somebody else had
 * configured and could not say *"read this page"*.
 *
 * ## Nothing raw reaches this turn, and that is the whole design
 *
 * > The model that reads the untrusted text has no tools and no memory. The
 * > model that has tools and memory never reads the untrusted text.
 *
 * This handler runs in the second one. It has her credential and Adjutant's
 * MCP tools, so what it returns is what an attacker gets to put in front of a
 * model that can act. Three things keep that safe and none of them is care:
 *
 * - The route answers with a `Reading`, which has no field the page's `<title>`
 *   could be assigned to. See `connections/intake-view.ts`.
 * - A refusal is a sentence `ArticleIntake` wrote, never one the reply did. See
 *   `safeReason` in `connections/intake.ts`.
 * - `tools/client.ts` never interpolates a response body into a failure
 *   message, so the transport cannot carry one back either.
 *
 * ## Asking twice is how she waits
 *
 * Submission is cheap and synchronous; the fetching and the reading happen in
 * the `content_ingestion` job between her turns. So this does not wait, for the
 * reason `render_me` does not: a turn does not complete until stdin reaches
 * EOF, and waiting means the Commander watching a cursor while a hostile server
 * takes its time. She calls it again with the same link, the submission is
 * idempotent on the canonical URL, and the second answer carries the extract.
 *
 * ## A reading is one act, and it does NOT become a subscription
 *
 * Deliberate, and worth stating because the code invites the opposite reading:
 * the row is called an `IntakeSource`, the mail poller a few files over polls
 * on a cadence, and "source" is exactly the word a feed would use. It is not
 * one. The ladder is `fetch -> read -> graft -> done`, it is terminal, and
 * nothing re-arms it.
 *
 * Making an ad-hoc read recur would be an accumulation nobody chose. He sends
 * her a link on a Tuesday; a year later she is re-fetching it every night, and
 * the cost is invisible because no single decision was ever large enough to
 * notice. It also inverts the ceiling below: `READS_PER_DAY` bounds readings
 * STARTED, and a subscription is a reading that starts itself forever, so ten
 * of them would be a permanent load rather than a day's work.
 *
 * If following something over time is wanted, it should be a verb that says so
 * — asked for once, listed somewhere he can see it, and cancellable. That is a
 * different feature with a different consent, not a flag on this one.
 */
const readThis: ToolHandler = async (input, context) => {
  const url = text(input, "url");
  if (url === null) {
    return missing("read_this", "url", "I did not catch which page to read.");
  }
  if (text(input, "because") === null) {
    return missing(
      "read_this",
      "because",
      "Reading something on his behalf spends his time and his tokens, so it has to say why.",
    );
  }

  const submitted = await context.client.post<IntakeAnswer>("/intake", { url, channel: "link" });
  if (!submitted.ok) return refused("read_this", submitted.failure);

  // Read back from the store rather than reporting what the write said, exactly
  // as every other verb does (`syl-009.3.4`). It matters more here than most:
  // a repeat submission answers with a source that may have finished reading
  // since, and the row is the only thing that knows.
  const stored = await context.client.get<IntakeAnswer>(
    `/intake/${encodeURIComponent(submitted.data.reading.id)}`,
  );
  if (!stored.ok) {
    return {
      ok: false,
      action: "read_this",
      reason: `${stored.failure.message} The reading may well have started — ask again with the same link rather than sending it twice.`,
      retryable: stored.failure.retryable,
    };
  }

  const { reading, reads } = stored.data;

  if (reading.refusal !== null) {
    return {
      ok: false,
      action: "read_this",
      // The refusal verbatim, because it was built to be said out loud and it
      // quotes nothing. `retryable` is the ladder's own answer: a blocked
      // address will be blocked again, and a slow server may not be.
      reason: reading.refusal.says,
      retryable: reading.refusal.retryable,
    };
  }

  return {
    ok: true,
    action: "read_this",
    // The reading whole, including `stage` and a `read` that is null until a
    // chunk has been through the reader. Nothing is summarised on the way past
    // and nothing is claimed on her behalf: a verb that answered "done" while
    // `read` was null would have her telling him about a page nobody has
    // opened yet.
    subject: reading,
    at: reading.updatedAt,
    // Where she stands against the ceiling, riding on the answer rather than
    // waiting behind a verb she would have to think to call. Same rule as
    // `render_me`'s bill: the evidence travels with the action.
    spent: reads,
  };
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
  schedule_todo: scheduleTodo,
  finish_todo: finishTodo,
  drop_todo: dropTodo,
  ask_agent: askAgent,
  set_goal: setGoal,
  change_goal: changeGoal,
  how_has_he_been: howHasHeBeen,
  recall,
  render_me: renderMe,
  this_is_me: thisIsMe,
  judge_render: judgeRender,
  see_myself: seeMyself,
  show_him: showHim,
  read_this: readThis,
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
