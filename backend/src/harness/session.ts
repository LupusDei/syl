import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import { resolveClaudeBinFromProcess } from "./claude-bin.js";

import {
  assertAutoMemory,
  autoMemorySettingsFlag,
  type AutoMemory,
} from "../memory/auto-memory.js";

import {
  assertSubscriptionAuth,
  buildUserFrame,
  createLineDecoder,
  parseEvent,
  type InitEvent,
  type SylEvent,
  assembleReply,
} from "./protocol.js";

/**
 * Runs a single conversational turn against Claude Code: spawn, send one
 * prompt, close stdin, read to completion, die.
 *
 * ## One process per turn is a CHOICE now, and it used to be a constraint
 *
 * This comment used to say the CLI does not finish a turn until stdin reaches
 * EOF — measured honestly, correct at the time, and **false since 2.1.226**. A
 * `result` now arrives with the pipe still open. The old claim had quietly
 * decided the whole architecture, which is why `CLAUDE.md` demands a version
 * stamp and a re-run on any load-bearing measurement against someone else's
 * binary.
 *
 * `harness/persistent-session.ts` is what that re-measurement bought, and it is
 * a **lane split rather than a replacement** (`harness/warm-lanes.ts` draws the
 * line). This path is still correct — and still the default — for everything
 * where nobody is waiting on the seconds:
 *
 * - **scheduled work**: a spawn costs a few seconds nobody is counting, and a
 *   crash costs exactly the job that caused it;
 * - **anything reading untrusted content**: `runReaderTurn` is a *security*
 *   boundary made of this process. Fresh, never resumed, no tools, auto-memory
 *   off. A warm reader session would be a quarantine with a door in it.
 *
 * So the virtue the original note claimed is real and is kept, deliberately,
 * for the turns that want it: nothing to supervise, and a crash that costs at
 * most the turn in flight. Continuity comes from `--resume <sessionId>` against
 * Claude Code's own session store.
 */
export interface TurnOptions {
  /** Working directory for the agent. Defaults to the current process cwd. */
  readonly cwd?: string;
  /** Model id, e.g. "claude-haiku-4-5". Omit to use the CLI default. */
  readonly model?: string;
  /** Standing orders appended to the system prompt (Syl's soul). */
  readonly systemPrompt?: string;
  /** Path to an MCP config JSON file. Plugin MCP servers load regardless. */
  readonly mcpConfig?: string;
  /**
   * Which of Syl's lanes — which transcript — this turn belongs to. **Never
   * becomes argv.**
   *
   * Here for the wrappers a caller puts around a runner, which see a prompt and
   * an options object and nothing else. `SylAgent` sets it after the caller's
   * overrides, so a turn cannot claim to be a lane it is not.
   *
   * **It does not say who spoke.** It used to, as an accident worth knowing
   * about: her unattended turns each had a lane of their own, so "the commander
   * lane" and "the Commander said this" were the same set of turns, and
   * `index.ts` keyed the urgency evidence on it. The Commander merged those
   * lanes onto his (2026-08-11), and the accident ended. See {@link hisWords},
   * which is that question asked directly.
   */
  readonly lane?: string;
  /**
   * Whether the prompt is text the **Commander himself sent**. Defaults to
   * false and **never becomes argv**.
   *
   * The one input to `harness/urgency.ts` that cannot be derived from anything
   * else in this object: a prompt is just a string, and nothing about it says
   * whether a person wrote it. `index.ts` records his words for the tool server
   * only when this is set, and the tool server is what decides whether a
   * reminder may pierce his quiet hours.
   *
   * Set by `SylAgent` from `AskOptions.hisWords`, after the caller's overrides,
   * so a turn cannot award itself the bypass. The full argument is on
   * `AskOptions.hisWords` in `harness/agent.ts`.
   */
  readonly hisWords?: boolean;
  /** Prior session id, to continue an existing conversation. */
  readonly resume?: string;
  /**
   * Session id to create the conversation under, instead of letting the CLI
   * mint one. Must be a UUID; `newSessionId()` produces a suitable value.
   *
   * Ignored when `resume` is set — that conversation already has an id.
   * Defaults to a fresh uuid, so the id is always known before the spawn.
   */
  readonly sessionId?: string;
  /** Override the `claude` binary path. */
  readonly claudeBin?: string;
  /**
   * Claude Code permission mode. **No default** — the caller decides.
   *
   * A headless turn nobody can approve needs `"bypassPermissions"`, or the CLI
   * denies every call and the assistant burns turns discovering it cannot act.
   * But that is exactly the wrong answer for a turn that reads untrusted text,
   * so it must be chosen at each call site rather than inherited silently.
   * See `runReaderTurn` for the other end of that spectrum.
   */
  readonly permissionMode?: string;
  /**
   * Which built-in tools exist for this turn. `""` disables all of them.
   *
   * This is `--tools`, not `--allowedTools`, and the difference is a security
   * boundary: `--allowedTools` pre-approves names on a surface that still
   * exists, while `--tools` sets what exists at all. Only the latter makes a
   * turn *incapable* of acting.
   */
  readonly tools?: string;
  /**
   * Ignore ambient MCP configuration. Defaults to true when `mcpConfig` is set,
   * and can be set true on its own to mean "no MCP servers at all".
   *
   * Without it the session inherits every MCP server the user happens to have
   * configured, and the model burns dozens of turns searching a tool surface
   * it does not need.
   */
  readonly strictMcpConfig?: boolean;
  /**
   * Which of Claude Code's own settings sources this turn loads: any comma-
   * separated subset of `user`, `project`, `local`. **`""` loads none of them.**
   *
   * `--strict-mcp-config` is the same idea for MCP; this is the one for
   * everything else the machine has lying around, and it turned out to matter
   * far more. Moving `cwd` to `~/.syl` did **not** stop the repository reaching
   * her, because two of the three doors are not in the cwd at all. Driven live
   * on 2.1.226 with `cwd=~/.syl` and `--tools ""`, five SessionStart hooks
   * still fired on an ordinary turn and injected, before she had said a word:
   *
   * - `bd prime` — from the *user-level* `~/.claude/settings.json`, announcing
   *   itself as "project memories and session rules";
   * - "# Adjutant Agent Protocol" — from an installed *plugin*, telling her to
   *   find her layer in a squad and report to her orchestrator.
   *
   * Neither is in her home; neither cares what `cwd` is. With
   * `--setting-sources ""` the same turn reports no hooks, no plugins, 47 slash
   * commands instead of 98, and five agent types instead of eight. A `CLAUDE.md`
   * canary placed in the cwd reached the model without the flag and did not
   * reach it with the flag — so this closes the cwd door as well.
   *
   * Two things it does **not** break, both verified rather than assumed:
   * `apiKeySource` stays `"none"` (the claude.ai login is not a settings
   * source, so subscription rails are untouched), and `--settings` is still
   * honoured — `memory_paths.auto` came back as the directory we asked for.
   *
   * `--bare` looks like it does this job and must not be used: its help text
   * says auth becomes "strictly ANTHROPIC_API_KEY or apiKeyHelper", which is
   * the metered API and the one constraint this project does not bend.
   */
  readonly settingSources?: string;
  /**
   * Where Claude Code's own auto-memory reads and writes for this turn, or
   * that it is switched off. Omit and the CLI uses whatever the machine's
   * settings say, which for a personal assistant is nobody's decision.
   *
   * Passed as `--settings`, then **checked against the init frame** — the CLI
   * discards a directory it does not like and falls back to its own default
   * silently, so the flag going out proves nothing. See `memory/auto-memory.ts`
   * for the captures behind that.
   */
  readonly autoMemory?: AutoMemory;
  /**
   * Fail fast if the CLI resolved an API key instead of the claude.ai login.
   * Defaults to true — this harness exists to stay on subscription rails.
   */
  readonly requireSubscriptionAuth?: boolean;
  /**
   * Milliseconds before a turn that has produced no result is killed.
   * Defaults to {@link DEFAULT_TURN_TIMEOUT_MS}; zero or less disables it.
   */
  readonly timeoutMs?: number;
  /**
   * Called with the session id **before the process is spawned**, so a caller
   * can persist it first. See {@link runTurn} on why that ordering matters.
   */
  readonly onSessionId?: (sessionId: string) => void;
  /** Called for every decoded event as it arrives. */
  readonly onEvent?: (event: SylEvent) => void;
}

/**
 * Default ceiling on a single turn.
 *
 * Generous on purpose: a research turn doing real work legitimately runs for
 * minutes, and a timeout that fires on a healthy turn is worse than none. This
 * is a deadlock breaker, not a latency budget.
 */
export const DEFAULT_TURN_TIMEOUT_MS = 10 * 60_000;

/** How long a killed child gets to exit on SIGTERM before SIGKILL. */
const SIGKILL_GRACE_MS = 2_000;

/**
 * The turn was killed for making no progress.
 *
 * Distinct from a turn that failed: nothing is known about whether the work
 * happened, so a caller must not treat this as "Claude said no".
 */
export class TurnTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number, sawInit: boolean) {
    super(
      `Claude turn exceeded its ${timeoutMs}ms timeout and was killed ` +
        `(${sawInit ? "the session had started but never produced a result" : "the CLI never completed its init handshake"}).`,
    );
    this.name = "TurnTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** A session id in the form the CLI's `--session-id` requires. */
export function newSessionId(): string {
  return randomUUID();
}

/** The flags every turn carries whatever else is true of it. */
const BASE_ARGS: readonly string[] = [
  "-p",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
];

/**
 * Everything in a turn's argv **except which conversation it belongs to**.
 *
 * Split out for `harness/persistent-session.ts`, and the split is the whole
 * mechanism rather than a tidy-up. A persistent process is spawned once and
 * serves many turns, so its argv is fixed for its lifetime — but a turn's
 * `systemPrompt` is **not** fixed: `SylAgent` composes it fresh every time, and
 * the nightly consolidation rewrites the memory projection inside it.
 *
 * So the warm path fingerprints exactly this array and respawns when it moves.
 * That makes "the running process matches what this turn asked for" a DERIVED
 * property: there is no second list of which options are spawn-affecting to
 * keep in step with this one, and a `TurnOptions` field added next month is
 * covered the moment it appears here. A remembered list would have gone stale
 * silently, serving yesterday's identity under today's flags.
 */
export function turnShapeArgs(options: TurnOptions): string[] {
  const args: string[] = [];
  if (options.model) args.push("--model", options.model);
  if (options.systemPrompt) args.push("--append-system-prompt", options.systemPrompt);
  if (options.mcpConfig) args.push("--mcp-config", options.mcpConfig);
  if (options.strictMcpConfig ?? options.mcpConfig !== undefined) args.push("--strict-mcp-config");
  // Checked against `undefined`, not for truthiness: `""` is the whole point of
  // the flag, and `if (options.settingSources)` would silently drop it.
  if (options.settingSources !== undefined) args.push("--setting-sources", options.settingSources);
  if (options.autoMemory) args.push("--settings", autoMemorySettingsFlag(options.autoMemory));
  if (options.permissionMode) args.push("--permission-mode", options.permissionMode);
  if (options.tools !== undefined) args.push("--tools", options.tools);
  return args;
}

/**
 * The one flag that says which conversation a process is for.
 *
 * Deliberately not part of {@link turnShapeArgs}: it is the field that changes
 * between two turns of the *same* conversation on the per-turn path (turn one
 * mints, turn two resumes), so folding it into the fingerprint would make every
 * warm process a one-turn process.
 */
export function conversationArgs(sessionId: string, resume: string | undefined): string[] {
  return resume ? ["--resume", resume] : ["--session-id", sessionId];
}

/** The complete argv for one turn. The per-turn and warm paths share it. */
export function buildTurnArgv(options: TurnOptions, sessionId: string): string[] {
  return [...BASE_ARGS, ...turnShapeArgs(options), ...conversationArgs(sessionId, options.resume)];
}

/**
 * The environment a `claude` child is given — with the credentials removed.
 *
 * Anthropic's precedence puts a set API key ahead of the claude.ai login
 * unconditionally, so a stale key silently reroutes billing to the metered API
 * (`adj-t64m9`, non-negotiable constraint 3). Shared with the warm path because
 * a LONG-LIVED child makes this matter more, not less: the per-turn path strips
 * the key every few seconds, and a persistent one strips it once and then lives
 * for hours on that decision.
 */
export function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env["ANTHROPIC_API_KEY"];
  delete env["ANTHROPIC_AUTH_TOKEN"];
  return env;
}

export interface TurnResult {
  /** Session id to feed back as `resume` on the next turn. */
  readonly sessionId: string;
  /** The assistant's **final** text for this turn, exactly as the CLI reported it.
   *
   * This is what a structured turn wants — `runReaderTurn` parses it as JSON, and the
   * narration a model may emit before its answer would break that parse. See `spoken`
   * for the other question. */
  readonly text: string;
  /** Everything the assistant **said** this turn, in order.
   *
   * Differs from `text` only when a turn used a tool: the CLI's `result` carries just
   * the prose after the last tool call, so a reply where Syl thought, acted, and then
   * spoke arrives with the thinking removed. Chat wants this one; anything parsing a
   * structured answer wants `text`. */
  readonly spoken: string;
  /** Reported cost. On subscription rails this is an estimate, not a charge. */
  readonly costUsd: number;
  readonly numTurns: number;
  readonly init: InitEvent;
  readonly events: readonly SylEvent[];
}

/** Contract for a turn runner, so callers can substitute a fake in tests. */
export type TurnRunner = (prompt: string, options: TurnOptions) => Promise<TurnResult>;

export async function runTurn(prompt: string, options: TurnOptions = {}): Promise<TurnResult> {
  const frame = buildUserFrame(prompt); // validates before spawning anything

  // Anthropic's credential precedence puts a set API key ahead of the
  // claude.ai login unconditionally, so a stale key silently reroutes billing
  // to the metered API. Strip both (adj-t64m9).
  const env = childEnv();

  // The id is settled before the spawn, not learned from the init event.
  // Learning it means a crash between spawn and init loses a conversation that
  // exists on disk — the caller has no id to resume and no way to find one.
  // Verified on 2.1.226: `--session-id <uuid>` is honoured exactly, and both
  // the init and result frames come back carrying it.
  const sessionId = options.resume ?? options.sessionId ?? newSessionId();
  options.onSessionId?.(sessionId);

  const args = buildTurnArgv(options, sessionId);

  const claudeBin = options.claudeBin ?? resolveClaudeBinFromProcess();
  const child = spawn(claudeBin, args, {
    cwd: options.cwd ?? process.cwd(),
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  const events: SylEvent[] = [];
  let init: InitEvent | undefined;
  // Why a variable rather than a throw at the point of discovery: this runs
  // inside a stream handler, where a throw goes nowhere useful. The turn is
  // killed and the reason is carried out to the settled promise below.
  let fatal: Error | undefined;
  let stderr = "";

  const decode = createLineDecoder();
  child.stdout.on("data", (chunk: string) => {
    for (const line of decode(chunk)) {
      const event = parseEvent(line);
      if (!event) continue;
      events.push(event);
      options.onEvent?.(event);

      if (event.kind === "init") {
        init = event;
        // Both guards are about what this process is allowed to do, and both
        // have to land before the model acts: an API key means the wrong payment
        // rail, and a memory directory the CLI did not take means the next thing
        // written is the Commander's private memory in a path Syl never reads.
        try {
          if (options.requireSubscriptionAuth !== false) assertSubscriptionAuth(event);
          if (options.autoMemory) assertAutoMemory(event, options.autoMemory);
        } catch (error) {
          fatal = error as Error;
          child.kill();
        }
      }

      // An api_error arrives shaped like a normal assistant message. Capture it
      // so the turn rejects instead of relaying a failure as if it were an answer.
      if (event.kind === "api_error") {
        fatal = new Error(
          `Claude API error${event.errorType ? ` (${event.errorType})` : ""}: ${event.message}`,
        );
      }
    }
  });

  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  // If the CLI rejects its arguments it exits before reading stdin, and the
  // write below lands on a closed pipe. An unhandled EPIPE on a stream takes
  // the whole process down and buries the actual error, which is the exit code
  // and stderr the close handler is about to report.
  child.stdin.on("error", () => {
    /* deliberately ignored — the exit path below explains what happened */
  });

  // The turn only completes on stdin EOF — see the note above.
  child.stdin.write(frame);
  child.stdin.end();

  // A wedged CLI holds its pipes open and produces nothing. Without this the
  // turn never settles and takes its caller — a scheduled job, an HTTP
  // request — down with it. SIGTERM first so the CLI can tidy up; SIGKILL
  // after a grace period in case it is wedged badly enough to ignore that.
  const timeoutMs = options.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  let killTimer: NodeJS.Timeout | undefined;

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), SIGKILL_GRACE_MS);
        killTimer.unref();
      }, timeoutMs);
    }
    child.once("error", reject);
    child.once("close", resolve);
  }).finally(() => {
    clearTimeout(timer);
    clearTimeout(killTimer);
  });

  // Checked first: after a kill the transcript is arbitrarily truncated, so
  // every check below would report the wrong cause.
  if (timedOut) throw new TurnTimeoutError(timeoutMs, init !== undefined);
  if (fatal) throw fatal;
  if (!init) {
    throw new Error(
      `claude exited with code ${exitCode ?? "null"} before the init handshake. stderr: ${stderr.trim()}`,
    );
  }

  const result = events.find((event) => event.kind === "result");
  if (!result || result.kind !== "result") {
    throw new Error(`claude produced no result event (exit ${exitCode ?? "null"}). stderr: ${stderr.trim()}`);
  }
  if (result.isError) {
    throw new Error(`Claude turn failed: ${result.result || stderr.trim() || "unknown error"}`);
  }

  return {
    sessionId: init.sessionId,
    text: result.result,
    spoken: assembleReply(events, result.result),
    costUsd: result.costUsd,
    numTurns: result.numTurns,
    init,
    events,
  };
}
