import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runTurn, type TurnOptions, type TurnResult, type TurnRunner } from "./session.js";

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
  /** Scheduled "is anything wrong?" checks. Notice, do not nag. */
  heartbeat: "heartbeat",
  /** The morning agenda. */
  agenda: "agenda",
  /** The nightly review and memory consolidation pass. */
  consolidation: "consolidation",
} as const;

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
  /** Lane used by `ask` when none is named. Defaults to `LANES.commander`. */
  readonly lane?: Lane;
  /** Extra options forwarded to every turn. */
  readonly turnOptions?: TurnOptions;
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
  readonly #turnOptions: TurnOptions;
  readonly #lane: Lane;

  constructor(options: SylAgentOptions = {}) {
    this.#runner = options.runner ?? runTurn;
    this.#soul = options.soul;
    this.#turnOptions = options.turnOptions ?? {};
    this.#store = options.store ?? memorySessionStore();
    this.#lane = assertLane(options.lane ?? LANES.commander);
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
      turnOptions: this.#turnOptions,
      ...(this.#soul !== undefined ? { soul: this.#soul } : {}),
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
      ...this.#turnOptions,
      ...(this.#soul ? { systemPrompt: this.#soul } : {}),
      ...(resume ? { resume } : {}),
      onSessionId: (sessionId) => {
        this.#store.write(lane, sessionId);
        this.#turnOptions.onSessionId?.(sessionId);
      },
    };
  }
}
