import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { autoMemoryOff, type AutoMemory } from "../memory/auto-memory.js";

import { runTurn, type TurnOptions, type TurnResult, type TurnRunner } from "./session.js";
import { capabilityFromToolsOption } from "./capability.js";
import { composeTurnContext, type Contributor } from "./turn-context.js";

/**
 * A lane is one independent thread of conversation.
 *
 * Syl talks to herself as well as to the Commander: a heartbeat asking whether
 * anything needs attention, a morning agenda, a nightly consolidation pass. On
 * a single session id all of that lands in one transcript, so her inner
 * monologue interleaves with what he actually said and every lane pays for the
 * others' context. Lanes are what keep them apart.
 *
 * These are the lanes that exist today; the type is a plain string so a caller
 * can add one (a per-project research thread, say) without touching this file.
 */
export const LANES = {
  /** The Commander's own conversation. The default. */
  commander: "commander",
  /**
   * The hourly self-ping. Notice, do not nag.
   *
   * An hour that is hers, in which she decides whether anything is worth doing
   * — and in which the expected answer, most hours, is nothing. It is the one
   * lane besides `commander` that can act; see {@link LANES_WITH_HANDS} and
   * `jobs/heartbeat-job.ts`.
   */
  heartbeat: "heartbeat",
  /** The morning agenda. */
  agenda: "agenda",
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
 * **`commander`** is his own conversation: the lane `syl-009` was written for.
 *
 * **`heartbeat`** is the widening, and it is a considered one rather than a
 * relaxation. The Commander asked for an hourly turn that "wakes her up and
 * lets her decide what to do" — the entire point of which is that she can do
 * it. An hour that could only think would be an hour that could only report,
 * and there is nobody to report to at 14:00 on a Tuesday. What keeps it narrow
 * is not the absence of hands but the bounds on the hour: `jobs/heartbeat-job.ts`
 * spends at most one turn, may put something in front of him at most twice a
 * day, and cannot pierce quiet hours because no heartbeat turn ever records
 * words as HIS — so `harness/urgency.ts` has nothing to verify a claim against
 * and the Outbox holds everything until morning.
 *
 * **Every other lane has nothing, and that is not an oversight.** The dream
 * must not be able to write a reminder while judging what matters; the agenda
 * reads rather than acts; and the extraction turn is a sealed reader over text
 * he may have pasted from anywhere, which must never hold a capability at all.
 */
export const LANES_WITH_HANDS: readonly Lane[] = [LANES.commander, LANES.heartbeat];

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
   * The commander lane is handed an MCP configuration and the other three are
   * not — the dream must not be able to write a reminder while judging, and the
   * heartbeat and agenda read rather than act. One shared options object cannot
   * express that, and the version of this that could was "give every lane hands
   * and hope none of them use them".
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
   */
  async ask(prompt: string, lane: Lane = this.#lane): Promise<TurnResult> {
    assertLane(lane);
    const resume = this.#store.read(lane);

    try {
      return this.#remember(lane, await this.#runner(prompt, this.#buildOptions(lane, resume)));
    } catch (error) {
      if (!resume || !isResumeFailure(error)) throw error;

      this.reset(lane);
      return this.#remember(lane, await this.#runner(prompt, this.#buildOptions(lane, undefined)));
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

  #buildOptions(lane: Lane, resume: string | undefined): TurnOptions {
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
      // WHO IS SPEAKING, after the spread so it cannot be overridden. A wrapper
      // around the runner sees only a prompt and an options object, and at
      // least one of them has to tell his lane from hers — see
      // `TurnOptions.lane`. Never reaches argv.
      lane,
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
