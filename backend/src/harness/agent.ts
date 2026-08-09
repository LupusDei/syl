import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { runTurn, type TurnOptions, type TurnResult, type TurnRunner } from "./session.js";

/** Where the current conversation id lives between turns. */
export interface SessionStore {
  read(): string | undefined;
  write(sessionId: string): void;
  clear?(): void;
}

/** File-backed store so continuity survives restarts. */
export function fileSessionStore(path: string): SessionStore {
  return {
    read(): string | undefined {
      try {
        const value = readFileSync(path, "utf8").trim();
        return value === "" ? undefined : value;
      } catch {
        return undefined;
      }
    },
    write(sessionId: string): void {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, sessionId, "utf8");
    },
    clear(): void {
      try {
        writeFileSync(path, "", "utf8");
      } catch {
        // Nothing to clear.
      }
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
 * session id and resuming it. Each turn is its own subprocess (see
 * `runTurn` for why), so there is no daemon to supervise and a crash costs at
 * most the turn in flight.
 */
export class SylAgent {
  readonly #runner: TurnRunner;
  readonly #store: SessionStore;
  readonly #soul: string | undefined;
  readonly #turnOptions: TurnOptions;

  constructor(options: SylAgentOptions = {}) {
    this.#runner = options.runner ?? runTurn;
    this.#soul = options.soul;
    this.#turnOptions = options.turnOptions ?? {};

    let memory: string | undefined;
    this.#store =
      options.store ??
      {
        read: () => memory,
        write: (id) => {
          memory = id;
        },
        clear: () => {
          memory = undefined;
        },
      };
  }

  /** The session id that the next turn will resume, if any. */
  get sessionId(): string | undefined {
    return this.#store.read();
  }

  /**
   * Ask Syl something and return the completed turn.
   *
   * If resuming fails because the stored session is gone, the turn is retried
   * once from a clean session. Without that, a pruned or expired id would wedge
   * the agent permanently — it would keep resuming a conversation that no
   * longer exists and never speak again.
   */
  async ask(prompt: string): Promise<TurnResult> {
    const resume = this.#store.read();
    const options = this.#buildOptions(resume);

    try {
      const result = await this.#runner(prompt, options);
      this.#store.write(result.sessionId);
      return result;
    } catch (error) {
      if (!resume || !isResumeFailure(error)) throw error;

      this.reset();
      const result = await this.#runner(prompt, this.#buildOptions(undefined));
      this.#store.write(result.sessionId);
      return result;
    }
  }

  /** Forget the current conversation; the next turn starts fresh. */
  reset(): void {
    this.#store.clear?.();
    this.#store.write("");
  }

  #buildOptions(resume: string | undefined): TurnOptions {
    return {
      ...this.#turnOptions,
      ...(this.#soul ? { systemPrompt: this.#soul } : {}),
      ...(resume ? { resume } : {}),
    };
  }
}
