import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DreamLog,
  DreamLogError,
  type DreamSession,
  type OpenDreamSession,
} from "../../src/memory/dream/log.js";
import type { Clock } from "../../src/services/clock.js";
import { IN_MEMORY, openDatabase, type SylDatabase } from "../../src/services/database.js";
import { isId } from "../../src/services/id.js";

/** 2026-08-09T04:30Z — 23:30 on the 8th in Chicago, which is when Syl dreams. */
const NOW = Date.UTC(2026, 7, 9, 4, 30, 0, 0);
const CHICAGO = "America/Chicago";

/** Six hours of dreaming, expressed the way the Commander asked for it. */
const CEILING = 4_000_000;

const NODE_A = "syl:memory_node:01988f1a-0000-7000-8000-00000000000a";
const NODE_B = "syl:memory_node:01988f1a-0000-7000-8000-00000000000b";
const NODE_C = "syl:memory_node:01988f1a-0000-7000-8000-00000000000c";
const EDGE_1 = "syl:memory_edge:01988f1a-0000-7000-8000-000000000001";
const EDGE_2 = "syl:memory_edge:01988f1a-0000-7000-8000-000000000002";

/**
 * A clock the test moves by hand.
 *
 * Every ordering question in this file — does a resume land after the turn it
 * seals, is `responded_at` really later than `surfaced_at` — is a question
 * about instants, and a test that had to sleep to observe one is a test nobody
 * writes.
 */
function steppingClock(start = NOW): Clock & { advance(ms: number): void } {
  let at = start;
  const clock = (() => at) as Clock & { advance(ms: number): void };
  clock.advance = (ms) => {
    at += ms;
  };
  return clock;
}

let database: SylDatabase;
let clock: ReturnType<typeof steppingClock>;
let log: DreamLog;

function openSession(overrides: Partial<OpenDreamSession> = {}): DreamSession {
  return log.openSession({ tz: CHICAGO, tokenCeiling: CEILING, ...overrides });
}

beforeEach(() => {
  database = openDatabase({ path: IN_MEMORY });
  clock = steppingClock();
  log = new DreamLog({ db: database.handle, clock });
});

afterEach(() => {
  database.close();
});

// ---------------------------------------------------------------------------
// The constraint that matters more than any other.
// ---------------------------------------------------------------------------

describe("the dream log is not memory", () => {
  /** Every table this migration created. */
  function dreamTables(): readonly string[] {
    return database.handle
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'dream_%'")
      .all()
      .map((row) => (row as unknown as { name: string }).name);
  }

  function allTables(): readonly string[] {
    return database.handle
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all()
      .map((row) => (row as unknown as { name: string }).name);
  }

  function referencesOf(table: string): readonly string[] {
    return database.handle
      .prepare(`PRAGMA foreign_key_list(${table})`)
      .all()
      .map((row) => (row as unknown as { table: string }).table);
  }

  it("should create the dream log's own tables", () => {
    expect([...dreamTables()].sort()).toEqual([
      "dream_duplicate_edges",
      "dream_edge_reasoning",
      "dream_sessions",
      "dream_surfaced",
      "dream_turns",
    ]);
  });

  it("should never reference the graph from the dream log", () => {
    for (const table of dreamTables()) {
      for (const referenced of referencesOf(table)) {
        expect(referenced.startsWith("dream_")).toBe(true);
      }
    }
  });

  it("should never be referenced by anything outside the dream log", () => {
    for (const table of allTables()) {
      if (table.startsWith("dream_")) continue;
      for (const referenced of referencesOf(table)) {
        expect(referenced.startsWith("dream_")).toBe(false);
      }
    }
  });

  it("should put not one row of a whole night into the device sync feed", () => {
    const before = database.handle.prepare("SELECT COUNT(*) AS n FROM sync_log").get();
    const session = openSession();
    const turn = log.startTurn(session.id, { phase: "judge", batchSize: 3 });
    log.finishTurn(session.id, turn.turnIndex, { outcome: "success", tokensSpent: 900 });
    log.recordReasoning({
      sessionId: session.id,
      turnIndex: turn.turnIndex,
      disposition: "created",
      edgeId: EDGE_1,
      sourceNode: NODE_A,
      targetNode: NODE_B,
      reasoning: "Both are about how he teaches.",
    });
    log.recordSurfaced({ sessionId: session.id, summary: "A connection worth a look." });
    log.closeSession(session.id, { outcome: "completed" });
    const after = database.handle.prepare("SELECT COUNT(*) AS n FROM sync_log").get();

    expect((after as unknown as { n: number }).n).toBe((before as unknown as { n: number }).n);
  });
});

// ---------------------------------------------------------------------------
// The guards that live in the schema rather than in the store.
//
// The store validates first, so these can only fire if someone writes to the
// tables another way — a repair script, a future service, the admin. That is
// exactly when a guard has to still be there.
// ---------------------------------------------------------------------------

describe("the constraints in the schema itself", () => {
  function insertSession(overrides: Partial<Record<string, string | number>> = {}): void {
    const values = {
      id: "syl:dream_session:00000000-0000-7000-8000-0000000000ff",
      night: "2026-08-08",
      tz: CHICAGO,
      started_at: new Date(NOW).toISOString(),
      token_ceiling: CEILING,
      ...overrides,
    };
    database.handle
      .prepare(
        "INSERT INTO dream_sessions (id, night, tz, started_at, token_ceiling) VALUES (?, ?, ?, ?, ?)",
      )
      .run(values.id, values.night, values.tz, values.started_at, values.token_ceiling);
  }

  it("should refuse a fixed UTC offset where a place belongs", () => {
    expect(() => insertSession({ tz: "-05:00" })).toThrow();
    expect(() => insertSession({ tz: "GMT+6" })).toThrow();
  });

  it("should accept an IANA zone", () => {
    expect(() => insertSession({ tz: "Europe/London" })).not.toThrow();
  });

  it("should refuse a night that is not a calendar date", () => {
    expect(() => insertSession({ night: "2026-8-8" })).toThrow();
  });

  it("should refuse a ceiling of zero", () => {
    expect(() => insertSession({ token_ceiling: 0 })).toThrow();
  });

  it("should refuse a session that claims a verdict while still running", () => {
    expect(() =>
      database.handle
        .prepare(
          "INSERT INTO dream_sessions (id, night, tz, started_at, token_ceiling, outcome) " +
            "VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          "syl:dream_session:00000000-0000-7000-8000-0000000000fe",
          "2026-08-08",
          CHICAGO,
          new Date(NOW).toISOString(),
          CEILING,
          "completed",
        ),
    ).toThrow();
  });

  it("should refuse a surfaced row whose verdict has no instant", () => {
    const session = openSession();
    expect(() =>
      database.handle
        .prepare(
          "INSERT INTO dream_surfaced (session_id, summary, surfaced_at, response) " +
            "VALUES (?, ?, ?, ?)",
        )
        .run(session.id, "…", new Date(NOW).toISOString(), "engaged"),
    ).toThrow();
  });

  it("should refuse reasoning for a written edge that carries no edge id", () => {
    const session = openSession();
    expect(() =>
      database.handle
        .prepare(
          "INSERT INTO dream_edge_reasoning " +
            "(session_id, disposition, source_node, target_node, reasoning, created_at) " +
            "VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(session.id, "created", NODE_A, NODE_B, "…", new Date(NOW).toISOString()),
    ).toThrow();
  });

  it("should NOT forbid a recorded breach of the zero invariant", () => {
    // The obvious review suggestion is CHECK (duplicate_edge_inserts = 0). It
    // is exactly backwards: it makes the failure unrepresentable, so the one
    // night the invariant broke would be the one night with no row to show for
    // it. Loud is the goal; unrepresentable is not.
    const session = openSession();
    expect(() =>
      database.handle
        .prepare("UPDATE dream_sessions SET duplicate_edge_inserts = 3 WHERE id = ?")
        .run(session.id),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// openSession
// ---------------------------------------------------------------------------

describe("DreamLog.openSession", () => {
  it("should open a session that records its ceiling and has spent nothing", () => {
    const session = openSession();

    expect(isId(session.id, "dream_session")).toBe(true);
    expect(session.tokenCeiling).toBe(CEILING);
    expect(session.tokensSpent).toBe(0);
    expect(session.turns).toBe(0);
    expect(session.startedAt).toBe(new Date(NOW).toISOString());
    expect(session.endedAt).toBeNull();
  });

  it("should call a session that has not finished abandoned, because that is what it is", () => {
    expect(openSession().outcome).toBe("abandoned");
  });

  it("should refuse a timezone that is a fixed offset rather than a place", () => {
    // An offset is a property of an instant, not of a place, and one that
    // reaches storage survives exactly one DST boundary.
    expect(() => openSession({ tz: "-05:00" })).toThrow(DreamLogError);
    expect(() => openSession({ tz: "CST" })).toThrow(DreamLogError);
    expect(() => openSession({ tz: "Mars/Olympus" })).toThrow(DreamLogError);
  });

  it("should refuse a ceiling that is not a positive whole number of tokens", () => {
    expect(() => openSession({ tokenCeiling: 0 })).toThrow(DreamLogError);
    expect(() => openSession({ tokenCeiling: -1 })).toThrow(DreamLogError);
    expect(() => openSession({ tokenCeiling: 1.5 })).toThrow(DreamLogError);
  });

  it("should label a dream that starts before midnight with that evening's date", () => {
    // 2026-08-09T04:30Z is 23:30 on the 8th in Chicago.
    expect(openSession().night).toBe("2026-08-08");
  });

  it("should label a dream that runs past midnight with the SAME night", () => {
    // 02:00 local on the 9th is still the night of the 8th, and a longitudinal
    // query that split one night across two dates would be answering a
    // different question than the one asked.
    clock.advance(3 * 60 * 60_000);
    expect(openSession().night).toBe("2026-08-08");
  });

  it("should let the caller name the night when it knows better", () => {
    expect(openSession({ night: "2026-01-01" }).night).toBe("2026-01-01");
  });

  it("should refuse a night that is not a calendar date", () => {
    expect(() => openSession({ night: "last tuesday" })).toThrow(DreamLogError);
  });
});

// ---------------------------------------------------------------------------
// Reading sessions back — the longitudinal surface.
// ---------------------------------------------------------------------------

describe("DreamLog.session and list", () => {
  it("should read a session back by id", () => {
    const session = openSession();
    expect(log.session(session.id)).toEqual(session);
  });

  it("should return null for a session that does not exist", () => {
    expect(log.session("syl:dream_session:00000000-0000-7000-8000-000000000000")).toBeNull();
  });

  it("should list sessions newest first", () => {
    const first = openSession();
    clock.advance(24 * 60 * 60_000);
    const second = openSession();

    expect(log.list().items.map((session) => session.id)).toEqual([second.id, first.id]);
  });

  it("should keep every night rather than a rolling window", () => {
    for (let day = 0; day < 40; day += 1) {
      openSession();
      clock.advance(24 * 60 * 60_000);
    }
    expect(log.list({ limit: 200 }).items).toHaveLength(40);
  });

  it("should narrow a listing to one night", () => {
    openSession({ night: "2026-08-08" });
    openSession({ night: "2026-08-09" });

    expect(log.list({ night: "2026-08-09" }).items).toHaveLength(1);
  });

  it("should find the sessions a restart has to deal with", () => {
    const closed = openSession();
    log.closeSession(closed.id, { outcome: "completed" });
    const open = openSession();

    expect(log.list({ open: true }).items.map((session) => session.id)).toEqual([open.id]);
  });
});

// ---------------------------------------------------------------------------
// A session is MANY turns.
// ---------------------------------------------------------------------------

describe("a dream session is a sequence of turns", () => {
  it("should number turns from zero and keep counting", () => {
    const session = openSession();

    expect(log.startTurn(session.id, { phase: "sweep" }).turnIndex).toBe(0);
    expect(log.startTurn(session.id, { phase: "judge" }).turnIndex).toBe(1);
    expect(log.startTurn(session.id, { phase: "judge" }).turnIndex).toBe(2);
  });

  it("should record the CLI session id so a row leads back to its transcript", () => {
    const session = openSession();
    const turn = log.startTurn(session.id, {
      phase: "judge",
      claudeSessionId: "8f1a0000-0000-4000-8000-000000000001",
    });

    expect(turn.claudeSessionId).toBe("8f1a0000-0000-4000-8000-000000000001");
  });

  it("should refuse to start a turn on a session that has ended", () => {
    const session = openSession();
    log.closeSession(session.id, { outcome: "completed" });

    expect(() => log.startTurn(session.id, { phase: "judge" })).toThrow(DreamLogError);
  });

  it("should refuse to start a turn on a session that does not exist", () => {
    expect(() =>
      log.startTurn("syl:dream_session:00000000-0000-7000-8000-000000000000", { phase: "judge" }),
    ).toThrow(DreamLogError);
  });

  it("should sum the tokens of its turns onto the session", () => {
    const session = openSession();
    const first = log.startTurn(session.id, { phase: "judge" });
    log.finishTurn(session.id, first.turnIndex, { outcome: "success", tokensSpent: 1_000 });
    const second = log.startTurn(session.id, { phase: "judge" });
    log.finishTurn(session.id, second.turnIndex, { outcome: "success", tokensSpent: 2_500 });

    const after = log.session(session.id);
    expect(after?.tokensSpent).toBe(3_500);
    expect(after?.turns).toBe(2);
  });

  it("should report what is left of the ceiling", () => {
    const session = openSession({ tokenCeiling: 5_000 });
    const turn = log.startTurn(session.id, { phase: "judge" });
    log.finishTurn(session.id, turn.turnIndex, { outcome: "success", tokensSpent: 4_000 });

    expect(log.remainingTokens(session.id)).toBe(1_000);
  });

  it("should never report a negative remainder when a turn overshoots", () => {
    const session = openSession({ tokenCeiling: 5_000 });
    const turn = log.startTurn(session.id, { phase: "judge" });
    log.finishTurn(session.id, turn.turnIndex, { outcome: "success", tokensSpent: 9_000 });

    expect(log.remainingTokens(session.id)).toBe(0);
  });

  it("should distinguish a turn killed by the ten-minute timeout from any other failure", () => {
    // "How often does a batch die to the kill" is the number that sets the
    // batch size. Filed under `error` it is invisible.
    const session = openSession();
    const turn = log.startTurn(session.id, { phase: "judge" });
    log.finishTurn(session.id, turn.turnIndex, {
      outcome: "timeout",
      error: "TurnTimeoutError after 600000ms",
    });

    expect(log.turnsOf(session.id)[0]?.outcome).toBe("timeout");
  });

  it("should refuse to finish a turn twice", () => {
    const session = openSession();
    const turn = log.startTurn(session.id, { phase: "judge" });
    log.finishTurn(session.id, turn.turnIndex, { outcome: "success" });

    expect(() => log.finishTurn(session.id, turn.turnIndex, { outcome: "error" })).toThrow(
      DreamLogError,
    );
  });

  it("should refuse to finish a turn that was never started", () => {
    const session = openSession();
    expect(() => log.finishTurn(session.id, 7, { outcome: "success" })).toThrow(DreamLogError);
  });

  it("should return turns in the order they were taken", () => {
    const session = openSession();
    log.startTurn(session.id, { phase: "sweep" });
    log.startTurn(session.id, { phase: "judge" });

    expect(log.turnsOf(session.id).map((turn) => turn.phase)).toEqual(["sweep", "judge"]);
  });
});

// ---------------------------------------------------------------------------
// Checkpointing and resumability.
// ---------------------------------------------------------------------------

describe("checkpointing and resumability", () => {
  it("should remember where to pick the night back up", () => {
    const session = openSession();
    const turn = log.startTurn(session.id, { phase: "judge" });
    log.finishTurn(session.id, turn.turnIndex, {
      outcome: "success",
      checkpoint: { cursor: "syl:memory_node:…41", remaining: 118 },
    });

    const after = log.session(session.id);
    expect(after?.checkpoint).toEqual({ cursor: "syl:memory_node:…41", remaining: 118 });
    expect(after?.checkpointTurnIndex).toBe(0);
    expect(after?.checkpointAt).toBe(new Date(NOW).toISOString());
  });

  it("should cost one batch and not the night when a turn is killed", () => {
    const session = openSession();
    const good = log.startTurn(session.id, { phase: "judge" });
    log.finishTurn(session.id, good.turnIndex, {
      outcome: "success",
      checkpoint: { cursor: "batch-3" },
    });
    const killed = log.startTurn(session.id, { phase: "judge" });
    log.finishTurn(session.id, killed.turnIndex, { outcome: "timeout" });

    // The killed turn wrote no checkpoint, so the resume point is still the
    // last one that completed. That is the whole property.
    expect(log.session(session.id)?.checkpoint).toEqual({ cursor: "batch-3" });
  });

  it("should keep every turn's own checkpoint, not only the newest", () => {
    const session = openSession();
    const first = log.startTurn(session.id, { phase: "judge" });
    log.finishTurn(session.id, first.turnIndex, { outcome: "success", checkpoint: { at: 1 } });
    const second = log.startTurn(session.id, { phase: "judge" });
    log.finishTurn(session.id, second.turnIndex, { outcome: "success", checkpoint: { at: 2 } });

    expect(log.turnsOf(session.id).map((turn) => turn.checkpoint)).toEqual([{ at: 1 }, { at: 2 }]);
  });

  it("should continue the turn sequence across a resume rather than restarting it", () => {
    const session = openSession();
    log.startTurn(session.id, { phase: "judge" });
    log.finishTurn(session.id, 0, { outcome: "success" });
    log.resume(session.id);

    expect(log.startTurn(session.id, { phase: "judge" }).turnIndex).toBe(1);
  });

  it("should count how often a night had to be picked back up", () => {
    const session = openSession();
    log.resume(session.id);
    log.resume(session.id);

    expect(log.session(session.id)?.resumedCount).toBe(2);
  });

  it("should seal a turn the process died in the middle of", () => {
    const session = openSession();
    log.startTurn(session.id, { phase: "judge" });
    clock.advance(60_000);
    log.resume(session.id);

    const turn = log.turnsOf(session.id)[0];
    expect(turn?.outcome).toBe("abandoned");
    expect(turn?.endedAt).toBe(new Date(NOW + 60_000).toISOString());
  });

  it("should refuse to resume a session that has already ended", () => {
    const session = openSession();
    log.closeSession(session.id, { outcome: "completed" });

    expect(() => log.resume(session.id)).toThrow(DreamLogError);
  });

  it("should refuse to resume a session that does not exist", () => {
    expect(() =>
      log.resume("syl:dream_session:00000000-0000-7000-8000-000000000000"),
    ).toThrow(DreamLogError);
  });
});

// ---------------------------------------------------------------------------
// THE ZERO INVARIANT.
// ---------------------------------------------------------------------------

describe("the invariant that must always be zero", () => {
  it("should start at zero and stay there for a healthy night", () => {
    const session = openSession();
    log.recordCounts(session.id, { edgesCreated: 12, edgesReactivated: 4 });

    expect(log.session(session.id)?.duplicateEdgeInserts).toBe(0);
    expect(log.invariantBreaches()).toEqual([]);
  });

  it("should count a breach and keep the evidence that diagnoses it", () => {
    const session = openSession();
    const turn = log.startTurn(session.id, { phase: "sweep" });
    log.recordDuplicateEdgeInsert({
      sessionId: session.id,
      turnIndex: turn.turnIndex,
      sourceNode: NODE_A,
      targetNode: NODE_B,
      existingEdgeId: EDGE_1,
      existingTier: "cold",
      insertedEdgeId: EDGE_2,
      note: "existence check did not span the cold partition",
    });

    expect(log.session(session.id)?.duplicateEdgeInserts).toBe(1);
    const [breach] = log.invariantBreaches();
    expect(breach?.existingEdgeId).toBe(EDGE_1);
    // The field that names the bug: a cold existing edge is the signature of
    // an existence check that ran against the hot index only.
    expect(breach?.existingTier).toBe("cold");
    expect(breach?.sourceNode).toBe(NODE_A);
    expect(breach?.targetNode).toBe(NODE_B);
  });

  it("should tell a broken reactivation lookup apart from nothing deserving reactivation", () => {
    // The two are indistinguishable without this counter, and telling them
    // apart is the reason it exists.
    const quiet = openSession({ night: "2026-08-08" });
    log.recordCounts(quiet.id, { candidatesProposed: 40, edgesReactivated: 0 });

    const broken = openSession({ night: "2026-08-09" });
    log.recordCounts(broken.id, { candidatesProposed: 40, edgesReactivated: 0 });
    log.recordDuplicateEdgeInsert({
      sessionId: broken.id,
      sourceNode: NODE_A,
      targetNode: NODE_B,
      existingEdgeId: EDGE_1,
      existingTier: "cold",
    });

    expect(log.session(quiet.id)?.duplicateEdgeInserts).toBe(0);
    expect(log.session(broken.id)?.duplicateEdgeInserts).toBe(1);
  });

  it("should tell a partition-blind lookup apart from reflection defeating a rejection", () => {
    // Three tiers, three different bugs. `cold` is the expected failure — an
    // existence check that skipped the cold partition. `suppressed` is
    // categorically worse: reflection trying to resurrect a connection the
    // Commander explicitly rejected, which is the suppression force being
    // defeated rather than a lookup being narrow. A bare count cannot separate
    // them and the response to each is different.
    const session = openSession();
    log.recordDuplicateEdgeInsert({
      sessionId: session.id,
      sourceNode: NODE_A,
      targetNode: NODE_B,
      existingEdgeId: EDGE_1,
      existingTier: "cold",
    });
    log.recordDuplicateEdgeInsert({
      sessionId: session.id,
      sourceNode: NODE_B,
      targetNode: NODE_C,
      existingEdgeId: EDGE_2,
      existingTier: "suppressed",
    });

    expect(log.duplicatesOf(session.id).map((breach) => breach.existingTier)).toEqual([
      "cold",
      "suppressed",
    ]);
  });

  it("should surface every breach across all of history, not only tonight's", () => {
    const first = openSession({ night: "2026-08-08" });
    log.recordDuplicateEdgeInsert({
      sessionId: first.id,
      sourceNode: NODE_A,
      targetNode: NODE_B,
      existingEdgeId: EDGE_1,
    });
    clock.advance(24 * 60 * 60_000);
    const second = openSession({ night: "2026-08-09" });
    log.recordDuplicateEdgeInsert({
      sessionId: second.id,
      sourceNode: NODE_B,
      targetNode: NODE_C,
      existingEdgeId: EDGE_2,
    });

    expect(log.invariantBreaches()).toHaveLength(2);
  });

  it("should refuse to record a breach against a session that does not exist", () => {
    expect(() =>
      log.recordDuplicateEdgeInsert({
        sessionId: "syl:dream_session:00000000-0000-7000-8000-000000000000",
        sourceNode: NODE_A,
        targetNode: NODE_B,
        existingEdgeId: EDGE_1,
      }),
    ).toThrow(DreamLogError);
  });

  it("should let a breach be recorded, because a constraint would hide the one night it mattered", () => {
    // Guard against the obvious review suggestion: CHECK (duplicate = 0) makes
    // the failure unrepresentable, so the night the invariant broke would be
    // the night with no row to show for it.
    const session = openSession();
    for (let n = 0; n < 3; n += 1) {
      log.recordDuplicateEdgeInsert({
        sessionId: session.id,
        sourceNode: NODE_A,
        targetNode: NODE_B,
        existingEdgeId: EDGE_1,
      });
    }
    expect(log.session(session.id)?.duplicateEdgeInserts).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// The declared counters.
// ---------------------------------------------------------------------------

describe("DreamLog.recordCounts", () => {
  it("should record everything the bead asks a session to account for", () => {
    const session = openSession();
    log.recordCounts(session.id, {
      candidatesProposed: 41,
      candidatesJudged: 12,
      edgesCreated: 3,
      edgesReactivated: 2,
      edgesSuppressed: 1,
      nodesSuperseded: 4,
    });

    const after = log.session(session.id);
    expect(after?.candidatesProposed).toBe(41);
    expect(after?.candidatesJudged).toBe(12);
    expect(after?.edgesCreated).toBe(3);
    expect(after?.edgesReactivated).toBe(2);
    expect(after?.edgesSuppressed).toBe(1);
    expect(after?.nodesSuperseded).toBe(4);
  });

  it("should record demotions, so a quiet night reads differently from a broken one", () => {
    // "reactivated 0, demoted 900" and "reactivated 0, demoted 0" are very
    // different nights, and without this column they read the same.
    const session = openSession();
    log.recordCounts(session.id, { edgesDemoted: 900, edgesReactivated: 0 });

    expect(log.session(session.id)?.edgesDemoted).toBe(900);
  });

  it("should add to what is already there, because a night arrives in batches", () => {
    const session = openSession();
    log.recordCounts(session.id, { edgesCreated: 2 });
    log.recordCounts(session.id, { edgesCreated: 3 });

    expect(log.session(session.id)?.edgesCreated).toBe(5);
  });

  it("should refuse a delta that would walk a counter backwards", () => {
    const session = openSession();
    expect(() => log.recordCounts(session.id, { edgesCreated: -1 })).toThrow(DreamLogError);
    expect(() => log.recordCounts(session.id, { edgesCreated: 1.5 })).toThrow(DreamLogError);
  });

  it("should refuse to count against a session that does not exist", () => {
    expect(() =>
      log.recordCounts("syl:dream_session:00000000-0000-7000-8000-000000000000", {
        edgesCreated: 1,
      }),
    ).toThrow(DreamLogError);
  });
});

// ---------------------------------------------------------------------------
// Reasoning.
// ---------------------------------------------------------------------------

describe("DreamLog.recordReasoning", () => {
  function created(overrides: Record<string, unknown> = {}) {
    const session = openSession();
    const turn = log.startTurn(session.id, { phase: "judge" });
    return {
      session,
      reasoning: log.recordReasoning({
        sessionId: session.id,
        turnIndex: turn.turnIndex,
        disposition: "created",
        edgeId: EDGE_1,
        sourceNode: NODE_A,
        targetNode: NODE_B,
        reasoning: "Both passages are about how he explains a thing he already knows.",
        confidence: 0.72,
        ...overrides,
      }),
    };
  }

  it("should keep the model's own words for every edge it wrote", () => {
    const { session, reasoning } = created();

    expect(reasoning.reasoning).toContain("how he explains");
    expect(reasoning.confidence).toBe(0.72);
    expect(log.reasoningOf(session.id)).toHaveLength(1);
  });

  it("should record the tier transition that a reactivation actually is", () => {
    const session = openSession();
    log.recordReasoning({
      sessionId: session.id,
      disposition: "reactivated",
      edgeId: EDGE_1,
      sourceNode: NODE_A,
      targetNode: NODE_B,
      reasoning: "Rediscovered tonight; the dream finding it again is the evidence it mattered.",
      tierBefore: "cold",
      tierAfter: "hot",
    });

    const [row] = log.reasoningOf(session.id);
    expect(row?.tierBefore).toBe("cold");
    expect(row?.tierAfter).toBe("hot");
  });

  it("should keep the refusals too, so the astrology rate is readable and not just countable", () => {
    const session = openSession();
    log.recordReasoning({
      sessionId: session.id,
      disposition: "rejected",
      sourceNode: NODE_A,
      targetNode: NODE_C,
      reasoning: "Both mention Tuesday. That is a coincidence, not a connection.",
    });

    const [row] = log.reasoningOf(session.id);
    expect(row?.disposition).toBe("rejected");
    expect(row?.edgeId).toBeNull();
  });

  it("should refuse a written edge with no edge id, and a rejection that has one", () => {
    const session = openSession();
    expect(() =>
      log.recordReasoning({
        sessionId: session.id,
        disposition: "created",
        sourceNode: NODE_A,
        targetNode: NODE_B,
        reasoning: "…",
      }),
    ).toThrow(DreamLogError);
    expect(() =>
      log.recordReasoning({
        sessionId: session.id,
        disposition: "rejected",
        edgeId: EDGE_1,
        sourceNode: NODE_A,
        targetNode: NODE_B,
        reasoning: "…",
      }),
    ).toThrow(DreamLogError);
  });

  it("should refuse reasoning that says nothing", () => {
    // An inferred edge that cannot say why it exists cannot be audited or
    // presented, and presenting it is the entire value.
    const session = openSession();
    expect(() =>
      log.recordReasoning({
        sessionId: session.id,
        disposition: "created",
        edgeId: EDGE_1,
        sourceNode: NODE_A,
        targetNode: NODE_B,
        reasoning: "   ",
      }),
    ).toThrow(DreamLogError);
  });

  it("should refuse a confidence outside zero and one", () => {
    expect(() => created({ confidence: 1.4 })).toThrow(DreamLogError);
  });

  it("should refuse to attribute reasoning to a turn that was never taken", () => {
    const session = openSession();
    expect(() =>
      log.recordReasoning({
        sessionId: session.id,
        turnIndex: 9,
        disposition: "created",
        edgeId: EDGE_1,
        sourceNode: NODE_A,
        targetNode: NODE_B,
        reasoning: "…",
      }),
    ).toThrow(DreamLogError);
  });

  it("should follow one connection across every night it was touched", () => {
    const first = openSession({ night: "2026-08-08" });
    log.recordReasoning({
      sessionId: first.id,
      disposition: "created",
      edgeId: EDGE_1,
      sourceNode: NODE_A,
      targetNode: NODE_B,
      reasoning: "First seen.",
    });
    clock.advance(24 * 60 * 60_000);
    const second = openSession({ night: "2026-08-09" });
    log.recordReasoning({
      sessionId: second.id,
      disposition: "reactivated",
      edgeId: EDGE_1,
      sourceNode: NODE_A,
      targetNode: NODE_B,
      reasoning: "Found again.",
    });

    expect(log.historyOfEdge(EDGE_1).map((row) => row.disposition)).toEqual([
      "created",
      "reactivated",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Surfacing, and whether he engaged.
// ---------------------------------------------------------------------------

describe("surfacing and engagement", () => {
  function surfaced() {
    const session = openSession();
    const item = log.recordSurfaced({
      sessionId: session.id,
      edgeId: EDGE_1,
      summary: "You have described the same teaching move twice this month.",
      channel: "morning_agenda",
    });
    return { session, item };
  }

  it("should record what she chose to tell him, in the words she used", () => {
    const { session, item } = surfaced();

    expect(item.summary).toContain("teaching move");
    expect(item.response).toBe("pending");
    expect(item.respondedAt).toBeNull();
    expect(log.session(session.id)?.surfacedCount).toBe(1);
  });

  it("should record that he engaged, however much later that is", () => {
    const { session, item } = surfaced();
    clock.advance(3 * 24 * 60 * 60_000);
    const answered = log.recordEngagement(item.id, "engaged");

    expect(answered.response).toBe("engaged");
    expect(answered.respondedAt).toBe(new Date(NOW + 3 * 24 * 60 * 60_000).toISOString());
    expect(log.session(session.id)?.engagedCount).toBe(1);
  });

  it("should record a rejection, which is the suppression signal", () => {
    const { session, item } = surfaced();
    log.recordEngagement(item.id, "rejected");

    expect(log.session(session.id)?.rejectedCount).toBe(1);
    expect(log.session(session.id)?.engagedCount).toBe(0);
  });

  it("should never let a rejection be overwritten", () => {
    // A wrong-but-surfaced connection lingers precisely because it was shown
    // once. Losing the "no" is how that happens.
    const { item } = surfaced();
    log.recordEngagement(item.id, "rejected");

    expect(() => log.recordEngagement(item.id, "engaged")).toThrow(DreamLogError);
  });

  it("should let him come back to something he ignored", () => {
    const { item } = surfaced();
    log.recordEngagement(item.id, "ignored");
    clock.advance(60_000);

    expect(log.recordEngagement(item.id, "engaged").response).toBe("engaged");
  });

  it("should refuse to un-answer a surfaced connection", () => {
    const { item } = surfaced();
    log.recordEngagement(item.id, "engaged");

    expect(() => log.recordEngagement(item.id, "pending")).toThrow(DreamLogError);
  });

  it("should refuse to answer something that was never surfaced", () => {
    expect(() => log.recordEngagement(9_999, "engaged")).toThrow(DreamLogError);
  });

  it("should list what he is still sitting on", () => {
    const { item } = surfaced();
    const second = log.recordSurfaced({ sessionId: item.sessionId, summary: "And another." });
    log.recordEngagement(item.id, "engaged");

    expect(log.pendingSurfaced().map((row) => row.id)).toEqual([second.id]);
  });

  it("should refuse to surface against a session that does not exist", () => {
    expect(() =>
      log.recordSurfaced({
        sessionId: "syl:dream_session:00000000-0000-7000-8000-000000000000",
        summary: "…",
      }),
    ).toThrow(DreamLogError);
  });

  it("should refuse to surface nothing at all", () => {
    const session = openSession();
    expect(() => log.recordSurfaced({ sessionId: session.id, summary: "  " })).toThrow(
      DreamLogError,
    );
  });
});

// ---------------------------------------------------------------------------
// Closing the night.
// ---------------------------------------------------------------------------

describe("DreamLog.closeSession", () => {
  it("should close a night that ran out of work before it ran out of budget", () => {
    const session = openSession();
    clock.advance(6 * 60 * 60_000);
    const closed = log.closeSession(session.id, { outcome: "completed" });

    expect(closed.outcome).toBe("completed");
    expect(closed.endedAt).toBe(new Date(NOW + 6 * 60 * 60_000).toISOString());
  });

  it("should distinguish a night the ceiling bound from a night that finished", () => {
    // Only one of the two is evidence for raising the ceiling.
    const session = openSession();
    expect(log.closeSession(session.id, { outcome: "ceiling_reached" }).outcome).toBe(
      "ceiling_reached",
    );
  });

  it("should seal any turn still open when the night ends", () => {
    const session = openSession();
    log.startTurn(session.id, { phase: "judge" });
    clock.advance(60_000);
    log.closeSession(session.id, { outcome: "failed", error: "the machine slept" });

    expect(log.turnsOf(session.id)[0]?.endedAt).toBe(new Date(NOW + 60_000).toISOString());
  });

  it("should refuse to close a session twice", () => {
    const session = openSession();
    log.closeSession(session.id, { outcome: "completed" });

    expect(() => log.closeSession(session.id, { outcome: "failed" })).toThrow(DreamLogError);
  });

  it("should refuse to close a session that does not exist", () => {
    expect(() =>
      log.closeSession("syl:dream_session:00000000-0000-7000-8000-000000000000", {
        outcome: "completed",
      }),
    ).toThrow(DreamLogError);
  });
});

// ---------------------------------------------------------------------------
// Reconciliation: the engine's claim against its own evidence.
// ---------------------------------------------------------------------------

describe("DreamLog.reconcile", () => {
  it("should agree when the counters and the reasoning rows tell the same story", () => {
    const session = openSession();
    log.recordReasoning({
      sessionId: session.id,
      disposition: "created",
      edgeId: EDGE_1,
      sourceNode: NODE_A,
      targetNode: NODE_B,
      reasoning: "one",
    });
    log.recordReasoning({
      sessionId: session.id,
      disposition: "rejected",
      sourceNode: NODE_A,
      targetNode: NODE_C,
      reasoning: "two",
    });
    log.recordCounts(session.id, { edgesCreated: 1, candidatesJudged: 2 });

    const report = log.reconcile(session.id);
    expect(report.agrees).toBe(true);
    expect(report.disagreements).toEqual([]);
  });

  it("should name a counter that disagrees with its own evidence", () => {
    const session = openSession();
    log.recordCounts(session.id, { edgesCreated: 7 });

    const report = log.reconcile(session.id);
    expect(report.agrees).toBe(false);
    expect(report.disagreements).toContainEqual({
      counter: "edgesCreated",
      declared: 7,
      observed: 0,
    });
  });

  it("should refuse to reconcile a session that does not exist", () => {
    expect(() =>
      log.reconcile("syl:dream_session:00000000-0000-7000-8000-000000000000"),
    ).toThrow(DreamLogError);
  });
});
