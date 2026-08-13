import { instant, systemClock, type Clock } from "../../services/clock.js";
import { newId } from "../../services/id.js";
import { pageOf, resolvePage, type Page, type PageOptions } from "../../services/paging.js";
import type { Database } from "../../services/sqlite.js";

/**
 * The dream log: every dream session, permanently, in its own store.
 *
 * ## THE DREAM LOG IS NOT MEMORY
 *
 * Everything here is telemetry *about* the graph. Nothing written by this
 * module is ever a node or an edge, and nothing here is ever read back as
 * experience. Write it into the graph and the next night's sweep treats last
 * night's dream as something to consolidate: Syl dreams about her own dreams,
 * the corpus contaminates itself with its own output, and the astrology risk
 * this epic exists to *measure* compounds instead. It is the single easiest
 * way to ruin the memory system and it looks perfectly reasonable in review.
 *
 * The separation is structural, not a convention: graph ids are opaque TEXT
 * here, there is no foreign key in either direction, and `0013_dream_log.sql`
 * has three tests pinning that. See the header of that migration.
 *
 * ## What this module is for
 *
 * Observability is a first principle of the memory epic, on the Commander's
 * instruction, and the ordering is a dependency claim rather than a slogan:
 * the log must exist BEFORE the first dream, because the earliest sessions are
 * the most informative ones the project will ever get. They are what set the
 * budget, the decay curve and the suppression rate, and if they run unobserved
 * that evidence is gone permanently.
 *
 * ## A session is many turns
 *
 * `runTurn` kills any turn producing no result inside `DEFAULT_TURN_TIMEOUT_MS`
 * (10 minutes), and a night is on the order of six hours. So a session is a
 * *sequence* of turns under one token ceiling, checkpointed between them.
 * `startTurn` / `finishTurn` / `resume` are that shape, and the intended loop
 * is:
 *
 * ```ts
 * const session = log.openSession({ tz, tokenCeiling });
 * while (log.remainingTokens(session.id) > 0 && work.remaining()) {
 *   const turn = log.startTurn(session.id, { phase: "judge", claudeSessionId });
 *   try {
 *     const result = await runTurn(...);
 *     log.finishTurn(session.id, turn.turnIndex, {
 *       outcome: "success", tokensSpent: result.usage, checkpoint: work.cursor(),
 *     });
 *   } catch (error) {
 *     log.finishTurn(session.id, turn.turnIndex, {
 *       outcome: error instanceof TurnTimeoutError ? "timeout" : "error",
 *       error: String(error),
 *     });
 *     // No checkpoint was written, so the resume point is still the last turn
 *     // that completed: a killed turn costs one batch, never the night.
 *   }
 * }
 * log.closeSession(session.id, { outcome: ... });
 * ```
 *
 * After a crash, `resume` seals whatever turn was in flight, bumps
 * `resumedCount`, and hands back the checkpoint to carry on from.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** How a night ended. `abandoned` is what an unfinished one truthfully is. */
export type DreamSessionOutcome =
  | "abandoned"
  | "completed"
  | "ceiling_reached"
  | "yielded"
  | "failed";

/** Tier 1 proposes locally and free; Tier 2 is the subscription-billed turn. */
export type DreamTurnPhase = "sweep" | "judge";

/**
 * What a turn spent the night's ceiling ON. `0033_dream_turn_subject.sql`.
 *
 * Orthogonal to {@link DreamTurnPhase}, which names a tier rather than a topic.
 * The nightly health review is a Tier 2 judgment turn like any other — billed,
 * bounded, deciding — and it runs inside the same session under the same
 * ceiling, because the bead's whole instruction is *"not a new loop"*. This is
 * the field that keeps that from being invisible: without it, a night that ran
 * short would look like the dream getting slower.
 */
export type DreamTurnSubject = "memory" | "health";

/** How one turn ended. `timeout` is the ten-minute kill, called out on purpose. */
export type DreamTurnOutcome = "abandoned" | "success" | "timeout" | "error" | "yielded";

/** What the judgment did with a candidate. */
export type DreamDisposition = "created" | "reactivated" | "suppressed" | "rejected";

/** The graph's partition tier, mirrored here as an observation. */
export type MemoryTier = "hot" | "cold" | "suppressed";

/** What the Commander did about something she surfaced. */
export type SurfacedResponse = "pending" | "engaged" | "ignored" | "rejected";

/** The counters the engine declares for itself. */
export interface DeclaredCounts {
  readonly candidatesProposed: number;
  readonly candidatesJudged: number;
  readonly edgesCreated: number;
  readonly edgesReactivated: number;
  readonly edgesSuppressed: number;
  readonly nodesSuperseded: number;
  /**
   * Hot edges that crossed the relevance floor into the cold partition.
   *
   * The other half of the reactivation story: "reactivated 0, demoted 900" and
   * "reactivated 0, demoted 0" are very different nights and read identically
   * without this.
   */
  readonly edgesDemoted: number;
}

/** One night. */
export interface DreamSession extends DeclaredCounts {
  readonly id: string;
  /** The local calendar date the night belongs to. */
  readonly night: string;
  /** IANA, never a fixed offset. */
  readonly tz: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly outcome: DreamSessionOutcome;
  readonly error: string | null;

  readonly tokenCeiling: number;
  /**
   * A FLOOR, not a total: a turn killed by the timeout never reported its
   * usage. `outcome === "timeout"` on a turn is how you know.
   */
  readonly tokensSpent: number;
  readonly costUsd: number;
  readonly turns: number;

  /**
   * New edges inserted where an edge already existed for that node pair in any
   * partition. **This must always be zero.** Non-zero means the
   * cold-partition identity lookup is broken and dormant edges are being
   * silently duplicated instead of reactivated.
   */
  readonly duplicateEdgeInserts: number;

  readonly surfacedCount: number;
  readonly engagedCount: number;
  readonly rejectedCount: number;

  /** Where to pick the night back up. Opaque to this layer. */
  readonly checkpoint: unknown;
  readonly checkpointTurnIndex: number | null;
  readonly checkpointAt: string | null;
  readonly resumedCount: number;

  readonly runId: string | null;
}

/** One turn of one night. */
export interface DreamTurn {
  readonly sessionId: string;
  readonly turnIndex: number;
  readonly phase: DreamTurnPhase;
  /** Whose work this turn was. See {@link DreamTurnSubject}. */
  readonly subject: DreamTurnSubject;
  /** The `claude` CLI session id, known before the spawn. */
  readonly claudeSessionId: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly outcome: DreamTurnOutcome;
  readonly error: string | null;
  readonly tokensSpent: number;
  readonly costUsd: number;
  readonly numTurns: number;
  readonly batchSize: number;
  readonly candidatesJudged: number;
  readonly checkpoint: unknown;
}

/** Why two things were, or were not, connected. */
export interface DreamEdgeReasoning {
  readonly id: number;
  readonly sessionId: string;
  readonly turnIndex: number | null;
  readonly disposition: DreamDisposition;
  /** Null exactly when the disposition is `rejected`. */
  readonly edgeId: string | null;
  readonly sourceNode: string;
  readonly targetNode: string;
  readonly tierBefore: MemoryTier | null;
  readonly tierAfter: MemoryTier | null;
  readonly reasoning: string;
  readonly confidence: number | null;
  readonly createdAt: string;
}

/** One breach of the zero invariant, with what is needed to diagnose it. */
export interface DreamDuplicateEdge {
  readonly id: number;
  readonly sessionId: string;
  readonly turnIndex: number | null;
  readonly sourceNode: string;
  readonly targetNode: string;
  readonly existingEdgeId: string;
  /**
   * The tier of the edge that was already there. Three values, three different
   * bugs: `cold` is an existence check that skipped the cold partition (the
   * expected failure), `hot` is a check that is broken outright, and
   * `suppressed` is categorically worse than either — reflection trying to
   * resurrect a connection the Commander explicitly rejected.
   */
  readonly existingTier: MemoryTier | null;
  readonly insertedEdgeId: string | null;
  readonly detectedAt: string;
  readonly note: string | null;
}

/** Something she chose to tell him, and what he did about it. */
export interface DreamSurfaced {
  readonly id: number;
  readonly sessionId: string;
  readonly reasoningId: number | null;
  readonly edgeId: string | null;
  readonly summary: string;
  readonly channel: string | null;
  readonly messageId: string | null;
  readonly surfacedAt: string;
  readonly response: SurfacedResponse;
  readonly respondedAt: string | null;
}

/** A counter that does not agree with the rows underneath it. */
export interface CounterDisagreement {
  readonly counter: "candidatesJudged" | "edgesCreated" | "edgesReactivated" | "edgesSuppressed";
  readonly declared: number;
  readonly observed: number;
}

/** What the engine claimed, against what its own evidence says. */
export interface DreamReconciliation {
  readonly sessionId: string;
  readonly agrees: boolean;
  readonly disagreements: readonly CounterDisagreement[];
}

/** Opening a night. */
export interface OpenDreamSession {
  /** IANA, never a fixed offset. */
  readonly tz: string;
  readonly tokenCeiling: number;
  /** Defaults to the night `startedAt` falls in. See {@link nightOf}. */
  readonly night?: string;
  readonly runId?: string | null;
}

export interface StartDreamTurn {
  readonly phase: DreamTurnPhase;
  /** Defaults to `memory`, which every turn taken before `0033` truthfully was. */
  readonly subject?: DreamTurnSubject;
  readonly claudeSessionId?: string | null;
  readonly batchSize?: number;
}

export interface FinishDreamTurn {
  readonly outcome: Exclude<DreamTurnOutcome, "abandoned">;
  readonly error?: string | null;
  readonly tokensSpent?: number;
  readonly costUsd?: number;
  readonly numTurns?: number;
  readonly candidatesJudged?: number;
  /** Written to the turn AND to the session's resume point, atomically. */
  readonly checkpoint?: unknown;
}

export interface RecordReasoning {
  readonly sessionId: string;
  readonly turnIndex?: number | null;
  readonly disposition: DreamDisposition;
  readonly edgeId?: string | null;
  readonly sourceNode: string;
  readonly targetNode: string;
  readonly tierBefore?: MemoryTier | null;
  readonly tierAfter?: MemoryTier | null;
  readonly reasoning: string;
  readonly confidence?: number | null;
}

export interface RecordDuplicateEdgeInsert {
  readonly sessionId: string;
  readonly turnIndex?: number | null;
  readonly sourceNode: string;
  readonly targetNode: string;
  readonly existingEdgeId: string;
  readonly existingTier?: MemoryTier | null;
  readonly insertedEdgeId?: string | null;
  readonly note?: string | null;
}

export interface RecordSurfaced {
  readonly sessionId: string;
  readonly reasoningId?: number | null;
  readonly edgeId?: string | null;
  readonly summary: string;
  readonly channel?: string | null;
  readonly messageId?: string | null;
}

export interface CloseDreamSession {
  readonly outcome: DreamSessionOutcome;
  readonly error?: string | null;
}

export interface DreamSessionFilter extends PageOptions {
  readonly night?: string;
  /** Only sessions that have not ended — what a restart has to deal with. */
  readonly open?: boolean;
}

export interface DreamLogOptions {
  readonly db: Database;
  readonly clock?: Clock;
}

/** Thrown when the log cannot be written as asked. */
export class DreamLogError extends Error {
  readonly kind:
    | "unknown_session"
    | "session_closed"
    | "unknown_turn"
    | "turn_closed"
    | "unknown_surfaced"
    | "already_rejected"
    | "bad_ceiling"
    | "bad_timezone"
    | "bad_night"
    | "bad_count"
    | "bad_reasoning"
    | "bad_response";

  constructor(kind: DreamLogError["kind"], message: string) {
    super(message);
    this.name = "DreamLogError";
    this.kind = kind;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** `YYYY-MM-DD`. */
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * How far before local midnight a dream still counts as the previous night.
 *
 * The boundary is local noon. A session that starts at 23:30 and one that
 * starts at 02:10 are the *same* night to the Commander, and a label taken
 * straight from the calendar date at start would split it across two rows —
 * which quietly breaks every longitudinal question the log exists to answer,
 * and breaks it in the direction that looks like data rather than like a bug.
 */
const NIGHT_BOUNDARY_MS = 12 * 60 * 60_000;

/**
 * Reject anything that is not an IANA zone name.
 *
 * `Intl` is not enough on its own: modern Node accepts `"+05:00"` as a valid
 * `timeZone`, so a fixed offset would sail through the obvious check and then
 * drift an hour at the next DST boundary. Constraint 5, enforced at the
 * boundary as well as by a CHECK in the schema.
 */
function assertIanaZone(tz: string): void {
  if (tz !== "UTC" && !tz.includes("/")) {
    throw new DreamLogError(
      "bad_timezone",
      `"${tz}" is not an IANA timezone. Store a place (America/Chicago), never an offset: ` +
        `an offset is a property of an instant, not of a place, and a stored one survives ` +
        `exactly one DST boundary.`,
    );
  }
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
  } catch {
    throw new DreamLogError("bad_timezone", `"${tz}" is not a timezone this runtime knows.`);
  }
}

/**
 * The night an instant belongs to, as a local calendar date.
 *
 * Computed in the zone rather than by arithmetic on the instant, so DST and
 * the zone's own history are the runtime's problem and not ours.
 */
export function nightOf(epochMs: number, tz: string): string {
  assertIanaZone(tz);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(epochMs - NIGHT_BOUNDARY_MS));
}

function assertCount(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new DreamLogError(
      "bad_count",
      `${name} must be a non-negative whole number, got ${value}. ` +
        `These counters only ever go up; a negative delta would walk one backwards.`,
    );
  }
}

/** JSON, or `null` for absent. Kept in one place so both ends agree. */
function encodeJson(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function decodeJson(value: string | null): unknown {
  return value === null ? null : JSON.parse(value);
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface SessionRow {
  readonly id: string;
  readonly night: string;
  readonly tz: string;
  readonly started_at: string;
  readonly ended_at: string | null;
  readonly outcome: DreamSessionOutcome;
  readonly error: string | null;
  readonly token_ceiling: number;
  readonly turns: number;
  readonly tokens_spent: number;
  readonly cost_usd: number;
  readonly duplicate_edge_inserts: number;
  readonly surfaced_count: number;
  readonly engaged_count: number;
  readonly rejected_count: number;
  readonly candidates_proposed: number;
  readonly candidates_judged: number;
  readonly edges_created: number;
  readonly edges_reactivated: number;
  readonly edges_suppressed: number;
  readonly nodes_superseded: number;
  readonly edges_demoted: number;
  readonly checkpoint_json: string | null;
  readonly checkpoint_turn_index: number | null;
  readonly checkpoint_at: string | null;
  readonly resumed_count: number;
  readonly run_id: string | null;
}

interface TurnRow {
  readonly session_id: string;
  readonly turn_index: number;
  readonly phase: DreamTurnPhase;
  readonly subject: DreamTurnSubject;
  readonly claude_session_id: string | null;
  readonly started_at: string;
  readonly ended_at: string | null;
  readonly outcome: DreamTurnOutcome;
  readonly error: string | null;
  readonly tokens_spent: number;
  readonly cost_usd: number;
  readonly num_turns: number;
  readonly batch_size: number;
  readonly candidates_judged: number;
  readonly checkpoint_json: string | null;
}

interface ReasoningRow {
  readonly id: number;
  readonly session_id: string;
  readonly turn_index: number | null;
  readonly disposition: DreamDisposition;
  readonly edge_id: string | null;
  readonly source_node: string;
  readonly target_node: string;
  readonly tier_before: MemoryTier | null;
  readonly tier_after: MemoryTier | null;
  readonly reasoning: string;
  readonly confidence: number | null;
  readonly created_at: string;
}

interface DuplicateRow {
  readonly id: number;
  readonly session_id: string;
  readonly turn_index: number | null;
  readonly source_node: string;
  readonly target_node: string;
  readonly existing_edge_id: string;
  readonly existing_tier: MemoryTier | null;
  readonly inserted_edge_id: string | null;
  readonly detected_at: string;
  readonly note: string | null;
}

interface SurfacedRow {
  readonly id: number;
  readonly session_id: string;
  readonly reasoning_id: number | null;
  readonly edge_id: string | null;
  readonly summary: string;
  readonly channel: string | null;
  readonly message_id: string | null;
  readonly surfaced_at: string;
  readonly response: SurfacedResponse;
  readonly responded_at: string | null;
}

const SESSION_COLUMNS =
  "id, night, tz, started_at, ended_at, outcome, error, token_ceiling, turns, tokens_spent, " +
  "cost_usd, duplicate_edge_inserts, surfaced_count, engaged_count, rejected_count, " +
  "candidates_proposed, candidates_judged, edges_created, edges_reactivated, edges_suppressed, " +
  "nodes_superseded, edges_demoted, checkpoint_json, checkpoint_turn_index, checkpoint_at, " +
  "resumed_count, run_id";

const TURN_COLUMNS =
  "session_id, turn_index, phase, subject, claude_session_id, started_at, ended_at, outcome, " +
  "error, tokens_spent, cost_usd, num_turns, batch_size, candidates_judged, checkpoint_json";

const REASONING_COLUMNS =
  "id, session_id, turn_index, disposition, edge_id, source_node, target_node, tier_before, " +
  "tier_after, reasoning, confidence, created_at";

const DUPLICATE_COLUMNS =
  "id, session_id, turn_index, source_node, target_node, existing_edge_id, existing_tier, " +
  "inserted_edge_id, detected_at, note";

const SURFACED_COLUMNS =
  "id, session_id, reasoning_id, edge_id, summary, channel, message_id, surfaced_at, response, " +
  "responded_at";

function toSession(row: SessionRow): DreamSession {
  return {
    id: row.id,
    night: row.night,
    tz: row.tz,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    outcome: row.outcome,
    error: row.error,
    tokenCeiling: row.token_ceiling,
    tokensSpent: row.tokens_spent,
    costUsd: row.cost_usd,
    turns: row.turns,
    duplicateEdgeInserts: row.duplicate_edge_inserts,
    surfacedCount: row.surfaced_count,
    engagedCount: row.engaged_count,
    rejectedCount: row.rejected_count,
    candidatesProposed: row.candidates_proposed,
    candidatesJudged: row.candidates_judged,
    edgesCreated: row.edges_created,
    edgesReactivated: row.edges_reactivated,
    edgesSuppressed: row.edges_suppressed,
    nodesSuperseded: row.nodes_superseded,
    edgesDemoted: row.edges_demoted,
    checkpoint: decodeJson(row.checkpoint_json),
    checkpointTurnIndex: row.checkpoint_turn_index,
    checkpointAt: row.checkpoint_at,
    resumedCount: row.resumed_count,
    runId: row.run_id,
  };
}

function toTurn(row: TurnRow): DreamTurn {
  return {
    sessionId: row.session_id,
    turnIndex: row.turn_index,
    phase: row.phase,
    subject: row.subject,
    claudeSessionId: row.claude_session_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    outcome: row.outcome,
    error: row.error,
    tokensSpent: row.tokens_spent,
    costUsd: row.cost_usd,
    numTurns: row.num_turns,
    batchSize: row.batch_size,
    candidatesJudged: row.candidates_judged,
    checkpoint: decodeJson(row.checkpoint_json),
  };
}

function toReasoning(row: ReasoningRow): DreamEdgeReasoning {
  return {
    id: row.id,
    sessionId: row.session_id,
    turnIndex: row.turn_index,
    disposition: row.disposition,
    edgeId: row.edge_id,
    sourceNode: row.source_node,
    targetNode: row.target_node,
    tierBefore: row.tier_before,
    tierAfter: row.tier_after,
    reasoning: row.reasoning,
    confidence: row.confidence,
    createdAt: row.created_at,
  };
}

function toDuplicate(row: DuplicateRow): DreamDuplicateEdge {
  return {
    id: row.id,
    sessionId: row.session_id,
    turnIndex: row.turn_index,
    sourceNode: row.source_node,
    targetNode: row.target_node,
    existingEdgeId: row.existing_edge_id,
    existingTier: row.existing_tier,
    insertedEdgeId: row.inserted_edge_id,
    detectedAt: row.detected_at,
    note: row.note,
  };
}

function toSurfaced(row: SurfacedRow): DreamSurfaced {
  return {
    id: row.id,
    sessionId: row.session_id,
    reasoningId: row.reasoning_id,
    edgeId: row.edge_id,
    summary: row.summary,
    channel: row.channel,
    messageId: row.message_id,
    surfacedAt: row.surfaced_at,
    response: row.response,
    respondedAt: row.responded_at,
  };
}

/** Which declared counter each column is, for the additive update. */
const COUNTER_COLUMNS: Readonly<Record<keyof DeclaredCounts, string>> = {
  candidatesProposed: "candidates_proposed",
  candidatesJudged: "candidates_judged",
  edgesCreated: "edges_created",
  edgesReactivated: "edges_reactivated",
  edgesSuppressed: "edges_suppressed",
  nodesSuperseded: "nodes_superseded",
  edgesDemoted: "edges_demoted",
};

// ---------------------------------------------------------------------------
// The log
// ---------------------------------------------------------------------------

export class DreamLog {
  readonly #db: Database;
  readonly #clock: Clock;

  constructor(options: DreamLogOptions) {
    this.#db = options.db;
    this.#clock = options.clock ?? systemClock;
  }

  // -- sessions -------------------------------------------------------------

  /**
   * Open a night.
   *
   * The row exists from the first instant, carrying `abandoned` and a null
   * `ended_at`. That is not a placeholder: it is the truthful answer to "what
   * was this session, if we never come back to it", which is exactly what a
   * crash makes true.
   */
  openSession(input: OpenDreamSession): DreamSession {
    assertIanaZone(input.tz);

    if (!Number.isInteger(input.tokenCeiling) || input.tokenCeiling <= 0) {
      throw new DreamLogError(
        "bad_ceiling",
        `A dream needs a positive whole-token ceiling, got ${input.tokenCeiling}. ` +
          `The budget is expressed in tokens rather than wall-clock on the Commander's instruction.`,
      );
    }

    const now = this.#clock();
    const night = input.night ?? nightOf(now, input.tz);
    if (!CALENDAR_DATE.test(night)) {
      throw new DreamLogError("bad_night", `"${night}" is not a calendar date (YYYY-MM-DD).`);
    }

    const id = newId("dream_session");
    this.#db
      .prepare(
        `INSERT INTO dream_sessions (id, night, tz, started_at, token_ceiling, run_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, night, input.tz, instant(now), input.tokenCeiling, input.runId ?? null);

    return this.#requireSession(id);
  }

  /** One night by id, or `null`. */
  session(id: string): DreamSession | null {
    const row = this.#db
      .prepare(`SELECT ${SESSION_COLUMNS} FROM dream_sessions WHERE id = ?`)
      .get(id);
    return row === undefined ? null : toSession(row as unknown as SessionRow);
  }

  /**
   * A page of nights, newest first.
   *
   * Permanent, not rolling: "is the inferred engine getting better or worse
   * over three months" is the question actually asked, and a rolling window
   * cannot answer it.
   */
  list(filter: DreamSessionFilter = {}): Page<DreamSession> {
    const { limit, offset } = resolvePage(filter);

    const conditions: string[] = [];
    const bindings: string[] = [];
    if (filter.night !== undefined) {
      conditions.push("night = ?");
      bindings.push(filter.night);
    }
    if (filter.open === true) conditions.push("ended_at IS NULL");

    const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
    const rows = this.#db
      .prepare(
        `SELECT ${SESSION_COLUMNS} FROM dream_sessions ${where}
          ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .all(...bindings, limit + 1, offset);

    return pageOf(
      rows.map((row) => toSession(row as unknown as SessionRow)),
      limit,
      offset,
    );
  }

  /** What is left of the ceiling. Never negative, even when a turn overshoots. */
  remainingTokens(id: string): number {
    const session = this.#requireSession(id);
    return Math.max(0, session.tokenCeiling - session.tokensSpent);
  }

  /**
   * How much of a night went on one subject.
   *
   * `0033_dream_turn_subject.sql` exists for this query. The health review
   * shares the dream's session and the dream's ceiling deliberately — *"not a
   * new loop"* — and a second consumer spending an unattributed share of a
   * budget is how a night starts failing to finish while every check still
   * passes. `tokensSpentOn(id, "health")` is the number that makes it visible,
   * and `syl-t9tj.4.5` is where it is asserted.
   */
  tokensSpentOn(id: string, subject: DreamTurnSubject): number {
    this.#requireSession(id);
    const row = this.#db
      .prepare(
        `SELECT COALESCE(SUM(tokens_spent), 0) AS spent FROM dream_turns
          WHERE session_id = ? AND subject = ?`,
      )
      .get(id, subject);
    return Number((row as unknown as { spent: number }).spent);
  }

  /**
   * Pick a night back up.
   *
   * Seals whatever turn was in flight when the process stopped — it stays
   * `abandoned`, which is what it truthfully was — and bumps `resumedCount`,
   * which is the measurement that tells us whether the batch size is right.
   * The checkpoint is untouched, so work resumes from the last turn that
   * actually completed.
   */
  resume(id: string): DreamSession {
    const session = this.#requireSession(id);
    this.#assertOpen(session);

    const at = instant(this.#clock());
    this.#transaction(() => {
      this.#sealOpenTurns(id, at);
      this.#db
        .prepare("UPDATE dream_sessions SET resumed_count = resumed_count + 1 WHERE id = ?")
        .run(id);
    });

    return this.#requireSession(id);
  }

  /**
   * Conclude a night.
   *
   * `completed` and `ceiling_reached` are deliberately different answers: only
   * one of them is evidence that the ceiling is doing anything, and the
   * Commander is expected to tune it from exactly that.
   */
  closeSession(id: string, result: CloseDreamSession): DreamSession {
    const session = this.#requireSession(id);
    this.#assertOpen(session);

    const at = instant(this.#clock());
    this.#transaction(() => {
      this.#sealOpenTurns(id, at);
      this.#db
        .prepare("UPDATE dream_sessions SET ended_at = ?, outcome = ?, error = ? WHERE id = ?")
        .run(at, result.outcome, result.error ?? null, id);
    });

    return this.#requireSession(id);
  }

  /**
   * Add to the counters the engine declares for itself.
   *
   * Additive because a night arrives in batches and a turn that dies must not
   * take the whole night's accounting with it.
   */
  recordCounts(id: string, counts: Partial<DeclaredCounts>): DreamSession {
    this.#requireSession(id);

    const assignments: string[] = [];
    const bindings: number[] = [];
    for (const [key, column] of Object.entries(COUNTER_COLUMNS)) {
      const delta = counts[key as keyof DeclaredCounts];
      if (delta === undefined) continue;
      assertCount(key, delta);
      assignments.push(`${column} = ${column} + ?`);
      bindings.push(delta);
    }

    if (assignments.length > 0) {
      this.#db
        .prepare(`UPDATE dream_sessions SET ${assignments.join(", ")} WHERE id = ?`)
        .run(...bindings, id);
    }

    return this.#requireSession(id);
  }

  // -- turns ----------------------------------------------------------------

  /**
   * Open the next turn of a night.
   *
   * The index continues across a resume rather than restarting, so
   * `(session_id, turn_index)` stays the idempotency guard it was meant to be.
   */
  startTurn(sessionId: string, input: StartDreamTurn): DreamTurn {
    const session = this.#requireSession(sessionId);
    this.#assertOpen(session);

    const row = this.#db
      .prepare("SELECT COALESCE(MAX(turn_index) + 1, 0) AS next FROM dream_turns WHERE session_id = ?")
      .get(sessionId);
    // Safe assertion: an aggregate over an INTEGER column, coalesced.
    const turnIndex = (row as unknown as { next: number }).next;

    this.#db
      .prepare(
        `INSERT INTO dream_turns
           (session_id, turn_index, phase, subject, claude_session_id, started_at, batch_size)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        turnIndex,
        input.phase,
        input.subject ?? "memory",
        input.claudeSessionId ?? null,
        instant(this.#clock()),
        input.batchSize ?? 0,
      );

    return this.#requireTurn(sessionId, turnIndex);
  }

  /**
   * Conclude a turn, and move the resume point if it produced one.
   *
   * A killed turn passes no checkpoint, which is what makes the failure cost
   * one batch instead of the night: the session's resume point stays at the
   * last turn that actually completed.
   */
  finishTurn(sessionId: string, turnIndex: number, result: FinishDreamTurn): DreamTurn {
    const turn = this.#requireTurn(sessionId, turnIndex);
    if (turn.endedAt !== null) {
      throw new DreamLogError(
        "turn_closed",
        `Turn ${turnIndex} of ${sessionId} already ended at ${turn.endedAt}. ` +
          `A turn is concluded once; rewriting one would rewrite the night's accounting.`,
      );
    }

    const at = instant(this.#clock());
    const checkpoint = encodeJson(result.checkpoint);

    this.#transaction(() => {
      this.#db
        .prepare(
          `UPDATE dream_turns
              SET ended_at = ?, outcome = ?, error = ?, tokens_spent = ?, cost_usd = ?,
                  num_turns = ?, candidates_judged = ?, checkpoint_json = ?
            WHERE session_id = ? AND turn_index = ?`,
        )
        .run(
          at,
          result.outcome,
          result.error ?? null,
          result.tokensSpent ?? 0,
          result.costUsd ?? 0,
          result.numTurns ?? 0,
          result.candidatesJudged ?? 0,
          checkpoint,
          sessionId,
          turnIndex,
        );

      if (checkpoint !== null) {
        this.#db
          .prepare(
            `UPDATE dream_sessions
                SET checkpoint_json = ?, checkpoint_turn_index = ?, checkpoint_at = ?
              WHERE id = ?`,
          )
          .run(checkpoint, turnIndex, at, sessionId);
      }
    });

    return this.#requireTurn(sessionId, turnIndex);
  }

  /** Every turn of a night, in the order they were taken. */
  turnsOf(sessionId: string): readonly DreamTurn[] {
    return this.#db
      .prepare(`SELECT ${TURN_COLUMNS} FROM dream_turns WHERE session_id = ? ORDER BY turn_index`)
      .all(sessionId)
      .map((row) => toTurn(row as unknown as TurnRow));
  }

  // -- reasoning ------------------------------------------------------------

  /**
   * Record why two things were, or were not, connected.
   *
   * Refusals are kept as well as writes. The bead asks only for the edges that
   * were written; keeping the rejections is what makes the astrology rate
   * *readable* rather than merely countable — "41 proposed, 3 written" gives
   * the ratio, and only the rejected reasoning says whether the other 38 were
   * correctly binned.
   */
  recordReasoning(input: RecordReasoning): DreamEdgeReasoning {
    this.#requireSession(input.sessionId);
    if (input.turnIndex !== undefined && input.turnIndex !== null) {
      this.#requireTurn(input.sessionId, input.turnIndex);
    }

    const edgeId = input.edgeId ?? null;
    if (input.disposition === "rejected" && edgeId !== null) {
      throw new DreamLogError(
        "bad_reasoning",
        "A rejected candidate has no edge, so it cannot carry an edge id.",
      );
    }
    if (input.disposition !== "rejected" && edgeId === null) {
      throw new DreamLogError(
        "bad_reasoning",
        `A "${input.disposition}" disposition means an edge was written; it needs that edge's id.`,
      );
    }
    if (input.reasoning.trim().length === 0) {
      throw new DreamLogError(
        "bad_reasoning",
        "An inferred edge that cannot say why it exists cannot be audited, pruned intelligently, " +
          "or presented — and presenting it is the entire value.",
      );
    }
    if (
      input.confidence !== undefined &&
      input.confidence !== null &&
      (input.confidence < 0 || input.confidence > 1)
    ) {
      throw new DreamLogError(
        "bad_reasoning",
        `Confidence is a probability; ${input.confidence} is not one.`,
      );
    }

    const result = this.#db
      .prepare(
        `INSERT INTO dream_edge_reasoning
           (session_id, turn_index, disposition, edge_id, source_node, target_node,
            tier_before, tier_after, reasoning, confidence, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.sessionId,
        input.turnIndex ?? null,
        input.disposition,
        edgeId,
        input.sourceNode,
        input.targetNode,
        input.tierBefore ?? null,
        input.tierAfter ?? null,
        input.reasoning,
        input.confidence ?? null,
        instant(this.#clock()),
      );

    return this.#requireReasoning(Number(result.lastInsertRowid));
  }

  /** Every reasoning row of a night, in the order it was written. */
  reasoningOf(sessionId: string): readonly DreamEdgeReasoning[] {
    return this.#db
      .prepare(
        `SELECT ${REASONING_COLUMNS} FROM dream_edge_reasoning WHERE session_id = ? ORDER BY id`,
      )
      .all(sessionId)
      .map((row) => toReasoning(row as unknown as ReasoningRow));
  }

  /**
   * Every night one connection was touched, oldest first.
   *
   * The longitudinal question about a single edge, which is what makes "is
   * this connection getting stronger or was it a one-night fluke" answerable.
   */
  historyOfEdge(edgeId: string): readonly DreamEdgeReasoning[] {
    return this.#db
      .prepare(
        `SELECT ${REASONING_COLUMNS} FROM dream_edge_reasoning WHERE edge_id = ? ORDER BY id`,
      )
      .all(edgeId)
      .map((row) => toReasoning(row as unknown as ReasoningRow));
  }

  // -- the zero invariant ---------------------------------------------------

  /**
   * Record a new edge inserted where one already existed for that node pair.
   *
   * **This should never be called.** It exists so that if it ever is, the
   * failure is loud and diagnosable instead of silent: the counter it drives
   * is what separates "nothing deserved reactivation" from "the cold-partition
   * identity lookup is broken", and those two are otherwise indistinguishable
   * from the outside.
   *
   * The counter is derived from these rows by trigger, so a breach cannot be
   * counted without leaving the evidence, and evidence cannot be left without
   * the count moving.
   */
  recordDuplicateEdgeInsert(input: RecordDuplicateEdgeInsert): DreamDuplicateEdge {
    this.#requireSession(input.sessionId);
    if (input.turnIndex !== undefined && input.turnIndex !== null) {
      this.#requireTurn(input.sessionId, input.turnIndex);
    }

    const result = this.#db
      .prepare(
        `INSERT INTO dream_duplicate_edges
           (session_id, turn_index, source_node, target_node, existing_edge_id, existing_tier,
            inserted_edge_id, detected_at, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.sessionId,
        input.turnIndex ?? null,
        input.sourceNode,
        input.targetNode,
        input.existingEdgeId,
        input.existingTier ?? null,
        input.insertedEdgeId ?? null,
        instant(this.#clock()),
        input.note ?? null,
      );

    const row = this.#db
      .prepare(`SELECT ${DUPLICATE_COLUMNS} FROM dream_duplicate_edges WHERE id = ?`)
      .get(Number(result.lastInsertRowid));
    return toDuplicate(row as unknown as DuplicateRow);
  }

  /**
   * Every breach of the zero invariant, across all of history.
   *
   * An empty array is the only acceptable answer, and the question is asked of
   * the whole log rather than of tonight because the failure is silent: a
   * duplication that happened in March is still wrong in August, and the graph
   * still carries both edges.
   */
  invariantBreaches(): readonly DreamDuplicateEdge[] {
    return this.#db
      .prepare(`SELECT ${DUPLICATE_COLUMNS} FROM dream_duplicate_edges ORDER BY id`)
      .all()
      .map((row) => toDuplicate(row as unknown as DuplicateRow));
  }

  /** The breaches of one night. */
  duplicatesOf(sessionId: string): readonly DreamDuplicateEdge[] {
    return this.#db
      .prepare(
        `SELECT ${DUPLICATE_COLUMNS} FROM dream_duplicate_edges WHERE session_id = ? ORDER BY id`,
      )
      .all(sessionId)
      .map((row) => toDuplicate(row as unknown as DuplicateRow));
  }

  // -- surfacing and engagement --------------------------------------------

  /** Record something she chose to tell him. */
  recordSurfaced(input: RecordSurfaced): DreamSurfaced {
    this.#requireSession(input.sessionId);
    if (input.summary.trim().length === 0) {
      throw new DreamLogError(
        "bad_reasoning",
        "Surfacing nothing is not surfacing. Record what he was actually shown.",
      );
    }

    const result = this.#db
      .prepare(
        `INSERT INTO dream_surfaced
           (session_id, reasoning_id, edge_id, summary, channel, message_id, surfaced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.sessionId,
        input.reasoningId ?? null,
        input.edgeId ?? null,
        input.summary,
        input.channel ?? null,
        input.messageId ?? null,
        instant(this.#clock()),
      );

    return this.#requireSurfaced(Number(result.lastInsertRowid));
  }

  /**
   * Record what he did about it.
   *
   * The one mutation in this module, and it has to be: engagement arrives
   * later than the dream, sometimes days later.
   *
   * Two rules, both about not losing a signal:
   *
   *   - Nothing may go back to `pending`. An answer, once given, is evidence.
   *   - **A rejection is terminal.** Rejection is the suppression force, and a
   *     wrong-but-surfaced connection lingers precisely because it was shown
   *     once. Letting a later "ignored" overwrite a "no" would silently
   *     restore exactly the edge he told us to push down.
   */
  recordEngagement(surfacedId: number, response: SurfacedResponse): DreamSurfaced {
    const existing = this.#requireSurfaced(surfacedId);

    if (response === "pending") {
      throw new DreamLogError(
        "bad_response",
        "A surfaced connection cannot be un-answered. An answer, once given, is evidence.",
      );
    }
    if (existing.response === "rejected") {
      throw new DreamLogError(
        "already_rejected",
        `Surfaced item ${surfacedId} was rejected at ${existing.respondedAt ?? "an unknown time"}. ` +
          `A rejection is terminal: it is the suppression signal, and overwriting it would ` +
          `silently restore the edge he told us to push down.`,
      );
    }

    this.#db
      .prepare("UPDATE dream_surfaced SET response = ?, responded_at = ? WHERE id = ?")
      .run(response, instant(this.#clock()), surfacedId);

    return this.#requireSurfaced(surfacedId);
  }

  /** Everything surfaced in a night. */
  surfacedOf(sessionId: string): readonly DreamSurfaced[] {
    return this.#db
      .prepare(`SELECT ${SURFACED_COLUMNS} FROM dream_surfaced WHERE session_id = ? ORDER BY id`)
      .all(sessionId)
      .map((row) => toSurfaced(row as unknown as SurfacedRow));
  }

  /** Everything he has been shown and has not answered, oldest first. */
  pendingSurfaced(): readonly DreamSurfaced[] {
    return this.#db
      .prepare(
        `SELECT ${SURFACED_COLUMNS} FROM dream_surfaced WHERE response = 'pending'
          ORDER BY surfaced_at, id`,
      )
      .all()
      .map((row) => toSurfaced(row as unknown as SurfacedRow));
  }

  // -- reconciliation -------------------------------------------------------

  /**
   * Compare what the engine said it did against the rows that are the evidence
   * for it.
   *
   * The declared counters are deliberately not derived: a derived counter
   * cannot disagree with its evidence, which sounds like a virtue and is
   * actually the loss of a signal. A disagreement here means the engine
   * believes it wrote edges it left no reasoning for — which is either a
   * missing log call or an edge written without its reasoning, and both are
   * bugs worth being loud about.
   *
   * `candidatesProposed` and `nodesSuperseded` have no evidence table here, so
   * they are not reconciled.
   */
  reconcile(sessionId: string): DreamReconciliation {
    const session = this.#requireSession(sessionId);
    const rows = this.reasoningOf(sessionId);

    const observed = {
      candidatesJudged: rows.length,
      edgesCreated: rows.filter((row) => row.disposition === "created").length,
      edgesReactivated: rows.filter((row) => row.disposition === "reactivated").length,
      edgesSuppressed: rows.filter((row) => row.disposition === "suppressed").length,
    } as const;

    const disagreements: CounterDisagreement[] = [];
    for (const counter of Object.keys(observed) as (keyof typeof observed)[]) {
      if (session[counter] !== observed[counter]) {
        disagreements.push({ counter, declared: session[counter], observed: observed[counter] });
      }
    }

    return { sessionId, agrees: disagreements.length === 0, disagreements };
  }

  // -- internals ------------------------------------------------------------

  #requireSession(id: string): DreamSession {
    const session = this.session(id);
    if (session === null) {
      throw new DreamLogError("unknown_session", `There is no dream session ${id}.`);
    }
    return session;
  }

  #assertOpen(session: DreamSession): void {
    if (session.endedAt !== null) {
      throw new DreamLogError(
        "session_closed",
        `Dream session ${session.id} ended at ${session.endedAt} with outcome ` +
          `"${session.outcome}". A night that has been accounted for is not reopened; ` +
          `open a new session instead.`,
      );
    }
  }

  #requireTurn(sessionId: string, turnIndex: number): DreamTurn {
    const row = this.#db
      .prepare(`SELECT ${TURN_COLUMNS} FROM dream_turns WHERE session_id = ? AND turn_index = ?`)
      .get(sessionId, turnIndex);
    if (row === undefined) {
      throw new DreamLogError(
        "unknown_turn",
        `Dream session ${sessionId} has no turn ${turnIndex}.`,
      );
    }
    return toTurn(row as unknown as TurnRow);
  }

  #requireReasoning(id: number): DreamEdgeReasoning {
    const row = this.#db
      .prepare(`SELECT ${REASONING_COLUMNS} FROM dream_edge_reasoning WHERE id = ?`)
      .get(id);
    if (row === undefined) throw new Error("reasoning row vanished on write");
    return toReasoning(row as unknown as ReasoningRow);
  }

  #requireSurfaced(id: number): DreamSurfaced {
    const row = this.#db
      .prepare(`SELECT ${SURFACED_COLUMNS} FROM dream_surfaced WHERE id = ?`)
      .get(id);
    if (row === undefined) {
      throw new DreamLogError("unknown_surfaced", `Nothing was surfaced with id ${id}.`);
    }
    return toSurfaced(row as unknown as SurfacedRow);
  }

  /**
   * Close off any turn that was still open.
   *
   * The outcome is left at `abandoned`, because that is what an interrupted
   * turn truthfully was. Only `ended_at` is filled in, so the row stops
   * claiming to be in progress.
   */
  #sealOpenTurns(sessionId: string, at: string): void {
    this.#db
      .prepare("UPDATE dream_turns SET ended_at = ? WHERE session_id = ? AND ended_at IS NULL")
      .run(at, sessionId);
  }

  /**
   * Run several statements as one.
   *
   * `BEGIN IMMEDIATE` rather than a deferred begin: the writes are known up
   * front, so taking the write lock at the start turns a lock upgrade failure
   * into a wait, which the busy timeout already handles.
   */
  #transaction(work: () => void): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      work();
      this.#db.exec("COMMIT");
    } catch (cause) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // The transaction was already gone. The original failure is the one
        // worth reporting, and swallowing this keeps it visible.
      }
      throw cause;
    }
  }
}
