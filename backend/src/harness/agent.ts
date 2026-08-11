import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { autoMemoryOff, type AutoMemory } from "../memory/auto-memory.js";

import { runTurn, type TurnOptions, type TurnResult, type TurnRunner } from "./session.js";
import { capabilityFromToolsOption } from "./capability.js";
import { composeTurnContext, type Contributor } from "./turn-context.js";

/**
 * A lane is one independent thread of conversation.
 *
 * Syl talks to herself as well as to the Commander, and the question a lane
 * answers is which of those belong in the same transcript. On a single session
 * id everything interleaves and every lane pays for the others' context; on
 * separate ids nothing she thinks on one is available to another.
 *
 * ## Her spare-time turns are HIS thread, and that is the Commander's ruling
 *
 * > *"running the hourly checkin on a different thread is wrong for now —
 * > resume the same session — there will be things in the chat session that
 * > might invoke a reason to send a message and how it should appear — a new
 * > lane invalidates that entirely. The hourly checkin should also use the same
 * > lane. If it causes bloat on that thread we can solve it later, but for
 * > right now much of her personality lives in that thread."*
 * >                                        — the Commander, 2026-08-11
 *
 * This file used to argue the opposite in as many words, and the argument was
 * about *cost*: an inner monologue interleaving with what he actually said, and
 * every later turn paying to re-read it. That cost is real and he has read it
 * and taken it — **the bloat is accepted, not overlooked**, and the note it
 * leaves behind is that if the commander thread becomes expensive the answer is
 * summarisation inside it rather than a second thread beside it.
 *
 * What the separation cost was harder to see, and is why he ruled: the hour
 * that decides whether to say something to him was the one turn with no access
 * to how he had been spoken to. Whether a thing is worth interrupting him with,
 * and what it should sound like when it arrives, are judgements made out of the
 * conversation — and an hour that cannot read the conversation makes them out
 * of nothing. `jobs/unattended-contributor.ts` exists because the separation
 * had already produced its own defect in the other direction: a reminder she
 * filed at 07:04 that the Syl he talks to had never heard of.
 *
 * So all three of her unattended turns — the hourly self-ping
 * (`jobs/heartbeat-job.ts`), the render review (`jobs/render-review-job.ts`)
 * and the morning brief (`jobs/agenda-job.ts`, on his later ruling the same
 * day) — take their turns on {@link LANES.commander}, resuming the session he
 * talks to. **None of them may reset it.** Each used to start a fresh thread
 * for a good reason of its own; on his lane that call now throws his
 * conversation away, so no handler is given a `reset` to make.
 *
 * ## What still gets a lane of its own
 *
 * The two that are not conversation at all. The dream is speculation about the
 * corpus and the extraction turn is a sealed reader over text he may have
 * pasted from anywhere; putting either in his thread would mix a reasoning pass
 * — or an attacker's article — into the transcript he is talking to.
 *
 * ## The protection that used to be a side effect of all this
 *
 * A heartbeat could not pierce quiet hours because `index.ts` recorded "what he
 * said" for the commander lane and no other, and the hour was not that lane.
 * That is no longer a distinction a lane can carry, so it is not keyed on one:
 * see {@link AskOptions.hisWords}, which is set only by the seam that actually
 * holds a message he sent.
 *
 * These are the lanes that exist today; the type is a plain string so a caller
 * can add one (a per-project research thread, say) without touching this file.
 */
export const LANES = {
  /**
   * The Commander's own conversation, and every turn she takes in her spare
   * time. The default.
   *
   * See the note above: the hourly self-ping and the render review resume this
   * session deliberately, so "the commander lane" now means *the thread she
   * lives in* rather than *the turns he started*. It can act; see
   * {@link LANES_WITH_HANDS}.
   */
  commander: "commander",
  /** The nightly review and memory consolidation pass. */
  consolidation: "consolidation",
  /**
   * Reading a settled exchange back to decide what is worth remembering.
   *
   * Its own lane rather than a step inside `commander`: his answer must not
   * wait on filing, a failed extraction must not fail his reply, and only a
   * separate turn can be given a narrow output contract. See `memory/extract.ts`.
   */
  extraction: "extraction",
} as const;

/**
 * The lanes that are handed an MCP surface — the ones that can *act*.
 *
 * Declared here, beside the lanes themselves, because it is a statement about
 * lanes rather than about wiring: `index.ts` reads it to decide what a turn
 * carries, and `ops/container.ts` reads it so the boot notice names exactly the
 * lanes that were given hands. Two places that each wrote the list down would
 * be two places to keep in step, and the one that drifted would be the notice —
 * which is precisely the false security claim `syl-009.9` was about.
 *
 * **`commander`** is the thread she lives in: his own conversation, and the
 * three unattended turns that now resume it. It is the lane `syl-009` was
 * written for, and it is back to being the only entry here — not because
 * anything was taken away, but because the hour, the render review and the
 * morning brief stopped being lanes at all.
 *
 * That is worth stating plainly, because this list shrinking usually means a
 * capability was withdrawn and here it means the opposite. Each of those three
 * was argued onto this list for the same reason: an unattended turn that could
 * only *think* would be a turn that judges something and then has no way to act
 * on the judgement, and there is nobody to report to at 14:00 on a Tuesday.
 * They still act. They act as this lane.
 *
 * **What keeps the widening narrow has never lived here**, which is why merging
 * the lanes did not loosen it: the bounds are in the jobs. One turn per wake,
 * at most `SENDINGS_PER_DAY` reachings a local day counted across every job
 * that can reach him, a bounded number of wakes per render — and, for his
 * sleep, `TurnOptions.hisWords`, which is false for every unattended turn
 * whatever lane it runs on. See {@link AskOptions.hisWords}: that is the
 * protection that used to be a side effect of this list having several entries.
 *
 * **Every other lane has nothing, and that is not an oversight.** The dream
 * must not be able to write a reminder while judging what matters, and the
 * extraction turn is a sealed reader over text he may have pasted from
 * anywhere, which must never hold a capability at all.
 */
export const LANES_WITH_HANDS: readonly Lane[] = [LANES.commander];

/**
 * Lanes that must never write into Claude Code's auto-memory.
 *
 * `consolidation` is the dream. Its entire output is speculation ABOUT the
 * corpus, and Claude Code's auto-memory writes what a turn learned into
 * `MEMORY.md` — an index loaded at the start of every session, including the
 * next dream. Left on, the dream reads its own previous reflections back as
 * though they were experience, and the corpus contaminates itself with its own
 * output. That is what `CLAUDE.md` constraint 7 is about; the constraint's
 * wording forbids writing the dream LOG into the graph, and this is neither the
 * log nor the graph, which is exactly why it went unguarded (QA finding C1).
 *
 * The sharing argument in `memory/auto-memory.ts` is right for every other
 * lane — a fact learned in conversation should reach the morning agenda. It is
 * backwards for this one.
 *
 * **`autoMemoryOff()` rather than simply omitting the option**: auto-memory is
 * ON BY DEFAULT in headless `-p`, so passing nothing lets the CLI write into
 * `~/.claude/projects/<slug>/memory/` instead — outside `.syl/` and not covered
 * by its gitignore. Silence is not refusal here; the lane has to say off.
 *
 * `extraction` is the second, and it is the dream's argument pointed the other
 * way. That turn reads a transcript back — a transcript that may contain an
 * article the Commander pasted, an email he forwarded, a page he quoted. A
 * turn holding attacker-influenceable text must not also hold a writable store
 * that is loaded at the start of every later session: that is how one
 * injection stops being one turn's problem and becomes a standing instruction.
 * `memory/extract.ts` runs it as a reader turn, which switches auto-memory off
 * unconditionally and cannot be told otherwise — this entry is what keeps the
 * guarantee if extraction is ever moved onto `SylAgent` for continuity, and
 * `assertExtractionIsMemoryless` fails loudly if it is removed.
 */
export const MEMORYLESS_LANES: ReadonlySet<string> = new Set<string>([
  LANES.consolidation,
  LANES.extraction,
]);

/** The auto-memory a lane may use — off for {@link MEMORYLESS_LANES}. */
function autoMemoryForLane(lane: Lane, configured: AutoMemory | undefined): AutoMemory | undefined {
  if (MEMORYLESS_LANES.has(lane)) return autoMemoryOff();
  return configured;
}

export type Lane = string;

/**
 * Lane names become file names in the file-backed store, so they are checked
 * rather than trusted: a lane called `../../.ssh/id_rsa` must not be writable.
 */
const LANE_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

function assertLane(lane: string): string {
  if (!LANE_PATTERN.test(lane)) {
    throw new Error(
      `Invalid session lane "${lane}". Lane names must match ${String(LANE_PATTERN)} — ` +
        `they are used as file names.`,
    );
  }
  return lane;
}

/** Where each lane's conversation id lives between turns. */
export interface SessionStore {
  read(lane: Lane): string | undefined;
  write(lane: Lane, sessionId: string): void;
  clear(lane: Lane): void;
}

/**
 * File-backed store so continuity survives restarts: one file per lane inside
 * `dir`, named for the lane.
 */
export function fileSessionStore(dir: string): SessionStore {
  const pathFor = (lane: Lane): string => join(dir, assertLane(lane));

  return {
    read(lane: Lane): string | undefined {
      // Resolved outside the try: a missing file means "no session yet" and is
      // the normal first-run case, but a bad lane name is a programming error
      // and must not be swallowed with it.
      const path = pathFor(lane);
      try {
        const value = readFileSync(path, "utf8").trim();
        return value === "" ? undefined : value;
      } catch {
        return undefined;
      }
    },
    write(lane: Lane, sessionId: string): void {
      const path = pathFor(lane);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, sessionId, "utf8");
    },
    clear(lane: Lane): void {
      rmSync(pathFor(lane), { force: true });
    },
  };
}

/** In-memory store: continuity for the life of the process, and no further. */
export function memorySessionStore(): SessionStore {
  const lanes = new Map<string, string>();
  return {
    read: (lane) => lanes.get(assertLane(lane)),
    write: (lane, sessionId) => {
      lanes.set(assertLane(lane), sessionId);
    },
    clear: (lane) => {
      lanes.delete(assertLane(lane));
    },
  };
}

export interface SylAgentOptions {
  /** Turn runner. Defaults to the real subprocess runner. */
  readonly runner?: TurnRunner;
  /** Session id persistence. Defaults to in-memory (no continuity). */
  readonly store?: SessionStore;
  /** Standing orders, appended to the system prompt on every turn. */
  readonly soul?: string;
  /**
   * What she currently remembers about the Commander.
   *
   * A function, read fresh on EVERY turn, because the projection is rebuilt by
   * the nightly consolidation and this service outlives the night. A string
   * captured at construction would leave her remembering the day she booted,
   * forever.
   *
   * Composed into the system prompt beneath {@link soul} rather than sent as a
   * separate message, and the order is the whole point: identity first, then
   * what she knows. Handed over as a detached block it reads as data she was
   * given; handed over underneath who she is, it reads as memory she holds.
   * That distinction is why she once answered "what is your personality?" by
   * describing her own configuration file.
   */
  readonly recall?: () => string;
  /**
   * Anything else that contributes to the system prompt — tool schemas under
   * `syl-009`, and whatever comes after.
   *
   * A function form because the contributor set is LANE-DEPENDENT: the same
   * argument that makes {@link MEMORYLESS_LANES} exist applies one layer up, and
   * a lane that must not carry a capability is a decision the caller makes per
   * lane rather than per agent.
   *
   * `soul` and `recall` are folded in alongside these as the `identity` and
   * `memory` contributors, and `harness/turn-context.ts` decides the order. Do
   * not pass a second `identity` or `memory` contributor here — it will be
   * refused as a double registration, which is the point.
   */
  readonly contributors?: readonly Contributor[] | ((lane: Lane) => readonly Contributor[]);
  /** Lane used by `ask` when none is named. Defaults to `LANES.commander`. */
  readonly lane?: Lane;
  /**
   * Claude Code's auto-memory, for every turn this agent takes.
   *
   * Shared across lanes on purpose — lanes keep transcripts apart, and memory
   * is the one thing that must not be, or the morning agenda knows nothing the
   * Commander said last night. The reasoning is in `memory/auto-memory.ts`.
   *
   * **With exactly one exception: {@link MEMORYLESS_LANES}.** See there.
   */
  readonly autoMemory?: AutoMemory;
  /**
   * Extra options forwarded to a turn.
   *
   * A function form for the same reason {@link contributors} has one, and under
   * `syl-009` it is no longer a nicety: **the tool surface is lane-dependent.**
   * The lanes named in {@link LANES_WITH_HANDS} are handed an MCP configuration
   * and the rest are not — the dream must not be able to write a reminder while
   * judging what matters, and the extraction turn is a sealed reader. One
   * shared options object cannot express that, and the version of this that
   * could was "give every lane hands and hope none of them use them".
   */
  readonly turnOptions?: TurnOptions | ((lane: Lane) => TurnOptions);
  /**
   * The MCP verbs a lane will really have, named as the CLI presents them.
   *
   * Only for the capability section, and it exists because `--tools ""` empties
   * the **built-ins alone**: a lane can have an empty `tools` string and a full
   * MCP surface at once, and `capabilityFromToolsOption` reading `tools` by
   * itself would tell the commander lane it cannot act while it is holding
   * `remind_me`. See `harness/capability.ts`.
   *
   * Pass what the wiring actually attached. A list written out beside it is a
   * list that disagrees with it, which is the failure that whole module exists
   * to make unrepresentable.
   */
  readonly hands?: readonly string[] | ((lane: Lane) => readonly string[]);
}

/**
 * What a caller can say about a turn beyond its prompt and its lane.
 *
 * Deliberately not part of {@link SylAgentOptions.turnOptions}: everything here
 * is a fact about **this one turn**, and an agent-level option cannot express a
 * fact that changes between two turns on the same lane. That is exactly the
 * distinction that used to be carried by the lane name and no longer can be.
 */
export interface AskOptions {
  /**
   * Whether `prompt` is text the **Commander himself sent**.
   *
   * ## What this defends
   *
   * `harness/urgency.ts` lets a reminder pierce quiet hours only when she
   * quotes a phrase he actually wrote, and the phrase is checked against a file
   * that `index.ts` writes from the prompt of a turn. So whatever decides
   * *which* turns write that file decides whether an unattended turn can wake
   * him at 03:00 by quoting the words it was woken with.
   *
   * That used to be decided by the lane: the commander lane wrote, and the
   * hour, the review and the brief were different lanes, so they could not. The
   * Commander has since merged all three onto his lane — see {@link LANES} —
   * and a lane name now says nothing at all about who spoke. Left keyed on the
   * lane, the merge would have repealed the protection silently, with no line
   * of code mentioning quiet hours.
   *
   * So it is keyed on the thing that is actually true. **Absent means no**, and
   * the only caller that may set it is the one holding a message he sent
   * (`services/conversation-service.ts`, from the message store). A job handler
   * cannot set it by omission, by copying an options object, or by running on
   * his lane; `SylAgent` writes it into `TurnOptions` after the caller's
   * overrides, so a turn cannot claim it either.
   *
   * The failure mode of getting this wrong in the safe direction is a reminder
   * that waits until morning. In the unsafe direction it is his house woken at
   * three by a sentence nobody said.
   */
  readonly hisWords?: boolean;
}

/**
 * One turn at a time per lane, shared by every agent over the same store.
 *
 * ## Why this exists now and did not before
 *
 * A turn is `claude --resume <session id>`, and two of those against one id are
 * two processes reading and appending the same transcript. Nothing used to be
 * able to arrange that: `ConversationService` serialises per conversation, and
 * every other turn was on a lane of its own, so the per-conversation queue was
 * accidentally a per-session queue as well.
 *
 * Merging her unattended turns onto his lane ends that. The hour fires from the
 * job runner and he sends a message from his phone, and neither knows about the
 * other — so the session he is mid-turn on is the session the heartbeat is
 * about to resume. That is a hazard the lanes were absorbing for free, which is
 * the exact shape of "a protection that evaporates because a lane changed".
 *
 * ## Keyed on the STORE
 *
 * `forLane` builds a new `SylAgent` sharing the runner and the store, so a map
 * held on the instance would give each job handler a queue of its own and
 * serialise nothing. The store is what owns session ids, and a session id is
 * what two overlapping turns would collide over — so the store is the honest
 * key. A `WeakMap` because a store belongs to a service and a test builds many.
 *
 * The cost is that an unattended turn can wait behind one of his. That is the
 * right way round: his turn is never delayed by hers, and the job runner
 * already runs one job at a time and already tolerates a turn taking minutes.
 * A job that would rather stand aside than wait can ask {@link SylAgent.busy}
 * — see `jobs/heartbeat-job.ts`, which does exactly that. **That is a reader
 * over this queue and not a second lock**; two locking schemes over one session
 * id would be the bug this one exists to prevent, wearing a hat.
 */
const TURNS_IN_FLIGHT = new WeakMap<SessionStore, Map<Lane, LaneTurns>>();

/** One lane's queue: what to chain behind, and how many turns are on it. */
interface LaneTurns {
  /** The last turn queued. Already-handled, so a failure cannot escape here. */
  tail: Promise<unknown>;
  /**
   * Turns queued and not yet settled, this one included.
   *
   * Counted rather than inferred from {@link tail}, because a settled promise
   * is indistinguishable from a pending one without awaiting it — and `busy`
   * has to answer now.
   */
  depth: number;
}

/** A resume failure means the stored id is unusable — not that Claude is down. */
function isResumeFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no conversation found|session.*not found|invalid session|--resume/i.test(message);
}

/**
 * Syl's conversational front door.
 *
 * Holds the thread of conversation across turns by persisting Claude Code's
 * session id per lane and resuming it. Each turn is its own subprocess (see
 * `runTurn` for why), so there is no daemon to supervise and a crash costs at
 * most the turn in flight.
 */
export class SylAgent {
  readonly #runner: TurnRunner;
  readonly #store: SessionStore;
  readonly #soul: string | undefined;
  readonly #recall: (() => string) | undefined;
  readonly #contributors: SylAgentOptions["contributors"];
  readonly #autoMemory: AutoMemory | undefined;
  readonly #turnOptions: SylAgentOptions["turnOptions"];
  readonly #hands: SylAgentOptions["hands"];
  readonly #lane: Lane;

  constructor(options: SylAgentOptions = {}) {
    this.#runner = options.runner ?? runTurn;
    this.#soul = options.soul;
    this.#recall = options.recall;
    this.#contributors = options.contributors;
    this.#autoMemory = options.autoMemory;
    this.#turnOptions = options.turnOptions;
    this.#hands = options.hands;
    this.#store = options.store ?? memorySessionStore();
    this.#lane = assertLane(options.lane ?? LANES.commander);
  }

  /** The extra options this lane's turns carry. */
  #turnOptionsFor(lane: Lane): TurnOptions {
    if (typeof this.#turnOptions === "function") return this.#turnOptions(lane);
    return this.#turnOptions ?? {};
  }

  /** The MCP verbs this lane really has. Empty for every lane but the one. */
  #handsFor(lane: Lane): readonly string[] {
    if (typeof this.#hands === "function") return this.#hands(lane);
    return this.#hands ?? [];
  }

  /**
   * Who she is, then what she remembers, then what she can do — as one prompt.
   *
   * This agent no longer decides that order, or the budget, or what happens when
   * a memory contradicts a standing order. It *contributes* to
   * `harness/turn-context.ts`, which owns all three. The reason is that three
   * tracks write into this prompt — identity, memory, and tools under
   * `syl-009` — and each will reasonably assume it owns its slice; composition
   * living here, in the file one of those tracks happens to touch, is how the
   * ordering became an accident of string concatenation in the first place.
   *
   * Read fresh on every turn: the projection is rebuilt by the nightly
   * consolidation and this service outlives the night.
   */
  #systemPrompt(lane: Lane): string | undefined {
    const extra =
      typeof this.#contributors === "function" ? this.#contributors(lane) : (this.#contributors ?? []);

    const prompt = composeTurnContext({
      contributors: [
        ...(this.#soul ? [{ id: "soul", kind: "identity", text: this.#soul } as const] : []),
        ...(this.#recall ? [{ id: "working-memory", kind: "memory", text: this.#recall() } as const] : []),
        // Derived from `#turnOptions.tools` — THE SAME VALUE THE CLI IS
        // INVOKED WITH, deliberately, rather than a list maintained beside it.
        //
        // `SOUL.md` told her she owns his to-dos and his reminders before any
        // verb for them existed, so she answered a request for a reminder like
        // an assistant who had set one, and wrote nothing. That is the
        // fabricated `ls` at opposite polarity: capability asserted before it
        // arrived rather than assumed after it left, and both fail as PROSE,
        // where no assertion can see them.
        //
        // A hand-written "she cannot act yet" would be stale the day the tools
        // land — the fourth instance of the bug it was written to fix. Reading
        // the real option makes staleness UNREPRESENTABLE in both directions:
        // there is no second list, so there is nothing to keep in step.
        //
        // Both halves of the surface, because `--tools ""` empties the
        // built-ins and leaves an attached MCP server untouched: a lane can
        // hold `remind_me` and an empty `tools` string at the same time, and
        // reading only `tools` would hand the commander lane NO_HANDS_YET while
        // it is holding hands. Same rule, one more input.
        ...(() => {
          const options = this.#turnOptionsFor(lane);
          const text = capabilityFromToolsOption(options.tools, this.#handsFor(lane));
          return text === undefined ? [] : [{ id: "capability", kind: "capability", text } as const];
        })(),
        ...extra,
      ],
    }).systemPrompt;

    // `undefined` rather than `""`: an empty `--append-system-prompt` is a flag
    // going out for no reason, and `TurnOptions` reads its absence as "nothing
    // to say" everywhere else.
    return prompt === "" ? undefined : prompt;
  }

  /** The lane this agent talks in when `ask` is called without one. */
  get lane(): Lane {
    return this.#lane;
  }

  /** The session id that the next turn on the default lane will resume, if any. */
  get sessionId(): string | undefined {
    return this.#store.read(this.#lane);
  }

  /** The session id stored for a specific lane, if any. */
  sessionIdFor(lane: Lane): string | undefined {
    return this.#store.read(assertLane(lane));
  }

  /**
   * A view of this agent bound to another lane, sharing its runner, store and
   * soul. For a scheduled job that wants one stable handle rather than passing
   * a lane on every call.
   */
  forLane(lane: Lane): SylAgent {
    return new SylAgent({
      runner: this.#runner,
      store: this.#store,
      lane: assertLane(lane),
      // Carried as given — a function stays a function — so a lane view answers
      // the same lane-dependent questions the original does. Collapsing it to
      // one lane's options here would hand the dream whatever the commander
      // lane was given, which is the one thing this shape exists to prevent.
      ...(this.#turnOptions !== undefined ? { turnOptions: this.#turnOptions } : {}),
      ...(this.#hands !== undefined ? { hands: this.#hands } : {}),
      ...(this.#soul !== undefined ? { soul: this.#soul } : {}),
      ...(this.#recall !== undefined ? { recall: this.#recall } : {}),
      // Carried for the same reason as `recall`: a contributor forgotten here is
      // a lane that silently loses part of her prompt.
      ...(this.#contributors !== undefined ? { contributors: this.#contributors } : {}),
      // Shared across lanes on purpose: a lane view is a different transcript,
      // not a different assistant.
      ...(this.#autoMemory !== undefined ? { autoMemory: this.#autoMemory } : {}),
    });
  }

  /**
   * Ask Syl something and return the completed turn.
   *
   * The session id is persisted the moment `runTurn` settles on it — before the
   * subprocess is spawned — rather than when the turn succeeds. A turn that
   * dies between spawn and the init handshake has still created a conversation
   * on Claude Code's side, and an id learned from the result would never arrive
   * for it: the conversation exists and nothing can reach it again.
   *
   * If resuming fails because the stored session is gone, the turn is retried
   * once from a clean session. Without that, a pruned or expired id would wedge
   * the lane permanently — it would keep resuming a conversation that no longer
   * exists and never speak again.
   *
   * Turns on one lane are serialised against each other — see
   * {@link TURNS_IN_FLIGHT} — because his conversation and her unattended turns
   * now share a session id and two `--resume` processes over one transcript is
   * not a thing to find out about in production.
   */
  async ask(prompt: string, lane: Lane = this.#lane, options: AskOptions = {}): Promise<TurnResult> {
    assertLane(lane);
    // Captured before the wait, used after it: `hisWords` is a fact about this
    // prompt and must not be re-derived from anything that could have moved
    // while the lane was busy.
    const hisWords = options.hisWords === true;
    return this.#queued(lane, () => this.#take(prompt, lane, hisWords));
  }

  /**
   * Whether a turn is already running or queued on `lane`.
   *
   * For a caller that would rather stand aside than wait: the hourly self-ping
   * is the lowest-priority thing on the Commander's thread and must not make
   * him — or the morning brief — queue behind it. Asked of the same queue
   * `ask` uses, so there is one answer and not two.
   *
   * True the instant a turn is queued rather than when it starts, because a
   * caller deciding whether to add one more is asking about the queue and not
   * about the subprocess.
   */
  busy(lane: Lane = this.#lane): boolean {
    return (TURNS_IN_FLIGHT.get(this.#store)?.get(assertLane(lane))?.depth ?? 0) > 0;
  }

  /** Run `work` once every turn already queued on `lane` has settled. */
  async #queued<T>(lane: Lane, work: () => Promise<T>): Promise<T> {
    const lanes = TURNS_IN_FLIGHT.get(this.#store) ?? new Map<Lane, LaneTurns>();
    TURNS_IN_FLIGHT.set(this.#store, lanes);
    const queue = lanes.get(lane) ?? { tail: Promise.resolve(), depth: 0 };
    lanes.set(lane, queue);

    queue.depth += 1;
    // Both arms, so a turn that throws still releases the lane. A rejection
    // that only settled the success path would wedge the lane forever, which is
    // a worse failure than the one this queue prevents.
    const next = queue.tail.then(work, work);
    // The tail is stored already-handled, so a failed turn cannot surface as an
    // unhandled rejection on the NEXT caller's chain. The real rejection still
    // reaches this call's own returned promise.
    queue.tail = next.then(
      () => {
        queue.depth -= 1;
      },
      () => {
        queue.depth -= 1;
      },
    );
    return next;
  }

  /** One turn, with the resume retry. Always called with the lane held. */
  async #take(prompt: string, lane: Lane, hisWords: boolean): Promise<TurnResult> {
    const resume = this.#store.read(lane);

    try {
      return this.#remember(
        lane,
        await this.#runner(prompt, this.#buildOptions(lane, resume, hisWords)),
      );
    } catch (error) {
      if (!resume || !isResumeFailure(error)) throw error;

      this.reset(lane);
      return this.#remember(
        lane,
        await this.#runner(prompt, this.#buildOptions(lane, undefined, hisWords)),
      );
    }
  }

  /**
   * Re-persist from the completed turn. The pre-spawn announcement is what
   * survives a crash; this is what keeps the lane correct if the CLI ever
   * declines the id we asked for and mints its own.
   */
  #remember(lane: Lane, result: TurnResult): TurnResult {
    this.#store.write(lane, result.sessionId);
    return result;
  }

  /** Forget a lane's conversation; its next turn starts fresh. */
  reset(lane: Lane = this.#lane): void {
    this.#store.clear(assertLane(lane));
  }

  #buildOptions(lane: Lane, resume: string | undefined, hisWords: boolean): TurnOptions {
    const forLane = this.#turnOptionsFor(lane);
    return {
      // Unattended means pre-authorised: in `-p` mode there is nobody to
      // approve, so the CLI's default denies every call and the assistant burns
      // turns discovering it cannot act. `runTurn` deliberately has no default
      // here — this is the trusted lane opting in, and a turn that reads
      // untrusted content must not (see `runReaderTurn`).
      permissionMode: "bypassPermissions",
      // No ambient MCP. This was missing, and the Commander caught it on the
      // very first live turn: asked to say hello, Syl answered him through
      // `mcp__adjutant__send_message`.
      //
      // Two things were wrong with that. ADJUTANT IS DEVELOPMENT TOOLING — the
      // channel agents use to report to him while building. Syl's reply path is
      // the RETURN VALUE of the turn, which `ConversationService` persists and
      // broadcasts to his phone. Answering through Adjutant means the message
      // never enters her conversation history, never reaches the app, and is
      // invisible to the assistant that has to remember it tomorrow.
      //
      // And she reached for it because it was THERE. `--strict-mcp-config` was
      // off, so every turn inherited the repo's own `.mcp.json`. The cost was
      // not only architectural: "hello" took FOUR turns — ToolSearch, then
      // set_status, then send_message, then an answer — which is the same
      // thrash `CLAUDE.md` measured at 44 turns and $0.39 for one question.
      // Measured here at ~2.5s of pure latency per turn just for attaching it.
      //
      // Scoping the tool surface was already the outstanding follow-up noted in
      // `CLAUDE.md`; it also bounds what `bypassPermissions` can reach, which
      // matters more now that she is a real service on a real tailnet.
      //
      // If Syl should ever push to Adjutant deliberately, that is a NARROW,
      // named capability handed to a specific lane — not an ambient surface
      // every turn inherits.
      strictMcpConfig: true,
      ...forLane,
      // WHICH THREAD, after the spread so it cannot be overridden. A wrapper
      // around the runner sees only a prompt and an options object, and at
      // least one of them has to say which transcript this belongs to — see
      // `TurnOptions.lane`. Never reaches argv.
      lane,
      // WHO IS SPEAKING, and no longer the same question as the one above.
      // After the spread for the same reason and a sharper one: this is what
      // decides whether a prompt is recorded as evidence the Commander said
      // something, and a turn that could set it in its own `turnOptions` could
      // grant itself the quiet-hours bypass. See `AskOptions.hisWords`.
      hisWords,
      // After the spread, not before: if the agent was told where its memory
      // lives, an incidental `turnOptions` must not be able to move it.
      ...((): { autoMemory?: AutoMemory } => {
        const forLane = autoMemoryForLane(lane, this.#autoMemory);
        return forLane === undefined ? {} : { autoMemory: forLane };
      })(),
      ...((): { systemPrompt?: string } => {
        const prompt = this.#systemPrompt(lane);
        return prompt === undefined ? {} : { systemPrompt: prompt };
      })(),
      ...(resume ? { resume } : {}),
      onSessionId: (sessionId) => {
        this.#store.write(lane, sessionId);
        forLane.onSessionId?.(sessionId);
      },
    };
  }
}
