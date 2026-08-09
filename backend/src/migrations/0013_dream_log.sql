-- 0013_dream_log.sql — the dream log: every dream session, permanently.
--
-- ## THE CONSTRAINT THAT DECIDES EVERYTHING ELSE IN THIS FILE
--
-- **THE DREAM LOG IS NOT MEMORY.** These tables are telemetry *about* the
-- graph. Nothing here is ever a node or an edge, and nothing here is ever read
-- back as experience.
--
-- Get that wrong and the failure is not an error — it is a slow poisoning. The
-- next night's sweep would seed from last night's dream rows, Syl would dream
-- about her own dreams, the corpus would contaminate itself with its own
-- output, and the astrology risk this whole epic exists to *measure* would
-- instead compound. It would also look entirely reasonable in review: a
-- `memory_nodes` row of kind `event` saying "reflection pass, 41 candidates"
-- is exactly the sort of thing a careful engineer adds on purpose.
--
-- Three structural properties keep it true, and each has a test:
--
--   1. Every foreign key out of a `dream_*` table points at another `dream_*`
--      table. There are no references into `memory_nodes` / `memory_edges`,
--      and none the other way.
--   2. No `dream_*` table appears in `sync_log`'s `type` CHECK and none has a
--      sync trigger, so a whole night of dreaming adds not one row to the
--      device feed. The dream log is not a synced resource; it is the
--      Commander's instrument panel, not his phone's data.
--   3. Graph ids (`syl:memory_edge:…`, `syl:memory_node:…`) are stored as
--      opaque TEXT. See "why no foreign keys into the graph" below.
--
-- ## Why no foreign keys into the graph, when the graph never deletes anyway
--
-- `memory_edges` has a BEFORE DELETE trigger that ABORTs on an inferred edge,
-- so a dangling reference is impossible by construction today. The reason to
-- stay unreferenced is not dangling rows, it is *permanence and independence*:
--
--   - This log outlives everything it describes. A future migration that
--     rebuilds, re-partitions or re-ids the graph must not be able to delete,
--     cascade or rewrite the evidence of what produced it. Telemetry that a
--     schema change can erase is not telemetry.
--   - A foreign key is a coupling in the direction that matters. With none,
--     0012 and 0013 are independent files, and the graph can be reshaped
--     without a thought for this log — which is the only way the separation in
--     the section above survives contact with future work.
--
-- ## Why permanent and not rolling
--
-- The value of this log is longitudinal. "Is the inferred engine getting
-- better or worse over three months" is the question the Commander actually
-- asked, and a rolling window cannot answer it — by the time you know you want
-- last month, last month is gone. Rows are small and there is roughly one
-- session per night, so the volume is trivial until it demonstrably is not.
--
-- ## A session is MANY turns, and the schema has to say so
--
-- `runTurn` kills any turn that produces no result within
-- `DEFAULT_TURN_TIMEOUT_MS` (10 minutes) and throws `TurnTimeoutError`, while
-- the Commander has asked for on the order of six hours of dreaming a night
-- under a token ceiling. Six hours is therefore a *sequence* of turns sharing
-- one ceiling, and `dream_turns` is that sequence.
--
-- Resumability is designed in from the first row rather than retrofitted:
--
--   - `(session_id, turn_index)` is the primary key, so replaying a batch
--     index cannot silently double-insert. Idempotency is the schema's job,
--     not the caller's.
--   - `dream_sessions.checkpoint_json` is the cursor to resume from, and
--     `checkpoint_turn_index` says which turn produced it. A turn that dies
--     costs the work since the last checkpoint — one batch — and never the
--     night.
--   - A turn row is born `abandoned` with a NULL `ended_at`. That is not a
--     placeholder: it is the truthful answer to "what was this turn, if we
--     never come back to it", which is exactly what a kill -9 makes true. The
--     same trick as `runs` in 0007, for the same reason.
--   - `resumed_count` records how often a session had to be picked back up,
--     which is the measurement that sets the batch size.

-- ---------------------------------------------------------------------------
-- dream_sessions — one row per night.
-- ---------------------------------------------------------------------------

CREATE TABLE dream_sessions (
  id           TEXT NOT NULL PRIMARY KEY,

  -- The LOCAL calendar date the session belongs to, plus the zone that makes
  -- that date mean something. Not derivable from `started_at` after the fact:
  -- a dream that begins at 00:40 is "last night's" in every sense that matters
  -- to the Commander, and answering "what happened on the 9th" from a UTC
  -- instant silently splits one night across two dates.
  night        TEXT NOT NULL CHECK (night GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),

  -- An IANA zone, never a fixed offset (constraint 5). The CHECK is the
  -- cheapest possible enforcement of it: every IANA zone name either contains
  -- a slash or is literally `UTC`, while `-05:00`, `CST` and `GMT+6` — the
  -- three things someone actually writes by mistake — match neither.
  tz           TEXT NOT NULL CHECK (tz = 'UTC' OR tz GLOB '*/*'),

  started_at   TEXT NOT NULL,
  -- NULL while the session is open. An open session with a stale `started_at`
  -- is a crash, and it should look like one rather than like a session that is
  -- still thinking.
  ended_at     TEXT,

  -- Born `abandoned`, for the reason given above the table. Set once, on
  -- close.
  --   completed       — ran out of work before it ran out of budget
  --   ceiling_reached — spent the token ceiling; the budget bound it
  --   yielded         — stood down for the Commander and was not resumed
  --   failed          — an error ended the night
  -- The distinction between `completed` and `ceiling_reached` is the whole
  -- point of logging the ceiling: only one of them means "the ceiling is doing
  -- something", and only one of them is evidence for raising it.
  outcome      TEXT NOT NULL DEFAULT 'abandoned' CHECK (
                 outcome IN ('abandoned', 'completed', 'ceiling_reached', 'yielded', 'failed')
               ),
  error        TEXT,

  -- What it was allowed to spend, recorded next to what it spent. A ceiling
  -- that is not stored with the session it bound cannot be reconstructed
  -- later, because the ceiling is a tunable the Commander is expected to move.
  token_ceiling INTEGER NOT NULL CHECK (token_ceiling > 0),

  -- ---- Rollups maintained by trigger, from the detail tables ----
  --
  -- These are derived rather than written, so they cannot drift from the rows
  -- that justify them. A counter that disagrees with its own evidence is worse
  -- than no counter: it is a number the Commander would act on.
  --
  -- `tokens_spent` is a FLOOR, not a total. A turn killed by the 10-minute
  -- timeout never produced a result frame, so its usage is unobservable and
  -- counts as zero. `dream_turns.outcome = 'timeout'` is how you know the
  -- number understates; that is why the outcome is recorded per turn.
  turns        INTEGER NOT NULL DEFAULT 0,
  tokens_spent INTEGER NOT NULL DEFAULT 0,
  cost_usd     REAL    NOT NULL DEFAULT 0,

  -- THE MOST IMPORTANT NUMBER IN THIS FILE. IT MUST ALWAYS BE ZERO.
  --
  -- It counts new edges inserted where an edge already existed for that node
  -- pair in ANY partition. Non-zero means the cold-partition identity lookup
  -- in the sweep is broken, and the system is silently duplicating instead of
  -- reactivating dormant edges: the original edge keeps its accumulated
  -- history and its reasoning and stays invisible forever, while a fresh
  -- zero-history edge takes its place. Nothing errors.
  --
  -- Without this counter, `edges_reactivated = 0` means either "nothing
  -- deserved reactivation" or "reactivation is broken", and those two are
  -- indistinguishable from the outside. The Commander asked specifically to be
  -- able to tell them apart. This column is that answer.
  --
  -- **DO NOT ADD `CHECK (duplicate_edge_inserts = 0)`.** It is the obvious
  -- suggestion and it is exactly backwards: a CHECK would make the breach
  -- unrecordable, so the one night the invariant failed would be the one night
  -- with no row to show for it. The invariant is enforced by an assertion in
  -- the sweep and OBSERVED here. Loud is the goal; unrepresentable is not.
  --
  -- Derived by trigger from `dream_duplicate_edges`, so a breach cannot be
  -- counted without leaving the evidence that diagnoses it, and evidence
  -- cannot be left without the count moving.
  duplicate_edge_inserts INTEGER NOT NULL DEFAULT 0,

  surfaced_count INTEGER NOT NULL DEFAULT 0,
  engaged_count  INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,

  -- ---- Counters declared by the engine ----
  --
  -- Deliberately NOT derived. These are the engine's own claim about what it
  -- did, held next to the detail tables that are the evidence for it. Where
  -- both exist, `DreamLog.reconcile()` compares them, and a disagreement is a
  -- bug signal that a derived column would have hidden by construction.
  candidates_proposed INTEGER NOT NULL DEFAULT 0 CHECK (candidates_proposed >= 0),
  candidates_judged   INTEGER NOT NULL DEFAULT 0 CHECK (candidates_judged >= 0),
  edges_created       INTEGER NOT NULL DEFAULT 0 CHECK (edges_created >= 0),
  edges_reactivated   INTEGER NOT NULL DEFAULT 0 CHECK (edges_reactivated >= 0),
  edges_suppressed    INTEGER NOT NULL DEFAULT 0 CHECK (edges_suppressed >= 0),
  nodes_superseded    INTEGER NOT NULL DEFAULT 0 CHECK (nodes_superseded >= 0),
  -- How many hot edges crossed the relevance floor into the cold partition
  -- tonight. Free to record — 0012's demotion sweep is a single UPDATE over a
  -- partial index on `demote_after`, so this is exactly its `changes` — and it
  -- is the other half of the reactivation story: "reactivated 0, demoted 900"
  -- and "reactivated 0, demoted 0" are very different nights, and without this
  -- column they read the same.
  edges_demoted       INTEGER NOT NULL DEFAULT 0 CHECK (edges_demoted >= 0),

  -- ---- Checkpoint: where to pick the night back up ----
  --
  -- Opaque to this layer on purpose. The shape belongs to the sweep and the
  -- judge, and a column that understood it would have to be migrated every
  -- time they changed their mind about batching.
  checkpoint_json       TEXT,
  checkpoint_turn_index INTEGER,
  checkpoint_at         TEXT,
  resumed_count         INTEGER NOT NULL DEFAULT 0 CHECK (resumed_count >= 0),

  -- The job run that drove this session, as opaque TEXT. A join you can do by
  -- hand when you want the transcript, and no coupling to the jobs table's
  -- lifecycle.
  run_id TEXT,

  CHECK (ended_at IS NULL OR ended_at >= started_at),
  -- An open session cannot already carry a verdict. A CLOSED one may still say
  -- `abandoned` — that is the truthful record of a night a restart had to seal
  -- rather than a night that finished — so the implication runs one way only.
  CHECK (ended_at IS NOT NULL OR outcome = 'abandoned'),
  CHECK (tokens_spent >= 0),
  CHECK (turns >= 0),
  CHECK (duplicate_edge_inserts >= 0)
) STRICT;

-- The longitudinal read: "every night, newest first", and "what happened on
-- the 9th".
CREATE INDEX dream_sessions_started_idx ON dream_sessions (started_at DESC, id DESC);
CREATE INDEX dream_sessions_night_idx   ON dream_sessions (night DESC, id DESC);
-- "Is anything unfinished" — the query a restart runs. Partial, so it stays
-- tiny forever however many nights accumulate.
CREATE INDEX dream_sessions_open_idx    ON dream_sessions (started_at) WHERE ended_at IS NULL;
-- "Has the invariant EVER been breached, across all of history." Partial, so
-- the answer is one index probe and stays that way at three years of nights.
CREATE INDEX dream_sessions_breach_idx  ON dream_sessions (night)
  WHERE duplicate_edge_inserts > 0;

-- ---------------------------------------------------------------------------
-- dream_turns — the sequence a session is made of.
-- ---------------------------------------------------------------------------

CREATE TABLE dream_turns (
  session_id TEXT NOT NULL REFERENCES dream_sessions (id) ON DELETE CASCADE,
  -- Monotonic within the session, and it keeps counting across a resume: a
  -- resumed night continues the sequence rather than restarting it, so the
  -- primary key stays the idempotency guard it was meant to be.
  turn_index INTEGER NOT NULL CHECK (turn_index >= 0),

  -- `sweep` is Tier 1: local, free, proposes. `judge` is Tier 2: one
  -- subscription-billed turn that decides. Recording the free half too costs
  -- nothing and answers "how much of the night went on proposing", which is
  -- the first question asked of a six-hour budget.
  phase      TEXT NOT NULL CHECK (phase IN ('sweep', 'judge')),

  -- The `claude` CLI's own session id for this turn, known BEFORE the spawn
  -- via `--session-id`. This is the thread from a row in this table to the
  -- actual transcript on disk, and it is the single most useful field here
  -- when something looks wrong.
  claude_session_id TEXT,

  started_at TEXT NOT NULL,
  ended_at   TEXT,

  -- Born `abandoned`; see the header. `timeout` is called out separately from
  -- `error` because "how often does a batch die to the 10-minute kill" is
  -- precisely the number that sets the batch size, and it is invisible if a
  -- timeout is filed under errors.
  outcome    TEXT NOT NULL DEFAULT 'abandoned' CHECK (
               outcome IN ('abandoned', 'success', 'timeout', 'error', 'yielded')
             ),
  error      TEXT,

  tokens_spent INTEGER NOT NULL DEFAULT 0 CHECK (tokens_spent >= 0),
  cost_usd     REAL    NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  -- The CLI's own `num_turns` from the result frame — how many internal turns
  -- one `runTurn` took. Different from this table's row count, and both are
  -- worth having.
  num_turns    INTEGER NOT NULL DEFAULT 0 CHECK (num_turns >= 0),

  batch_size        INTEGER NOT NULL DEFAULT 0 CHECK (batch_size >= 0),
  candidates_judged INTEGER NOT NULL DEFAULT 0 CHECK (candidates_judged >= 0),

  -- The checkpoint this turn produced, kept per turn as well as on the
  -- session. The session says where to resume; these say where it had got to
  -- at every step, which is what you read when you want to know how a night
  -- went wrong rather than merely that it did.
  checkpoint_json TEXT,

  PRIMARY KEY (session_id, turn_index),
  CHECK (ended_at IS NULL OR ended_at >= started_at),
  -- Same one-way implication as the session: a turn still running has no
  -- verdict yet, and a turn that was never closed truthfully stays
  -- `abandoned` forever.
  CHECK (ended_at IS NOT NULL OR outcome = 'abandoned')
) STRICT;

-- ---------------------------------------------------------------------------
-- dream_edge_reasoning — why, in the model's own words.
-- ---------------------------------------------------------------------------
--
-- An inferred edge that cannot say why it exists cannot be audited, pruned
-- intelligently, or presented — and presenting it is the entire value.
--
-- REJECTED candidates are kept here too, with a NULL `edge_id`. The bead asks
-- only for the edges that were written; keeping the refusals as well is what
-- makes the astrology rate *readable* rather than merely countable. "41
-- proposed, 3 written" gives the ratio; only the rejected reasoning tells you
-- whether the 38 were correctly binned or whether the judge is throttling
-- good work. The Commander's instruction was to err toward logging too much.

CREATE TABLE dream_edge_reasoning (
  -- Not a `syl:` id. This is an interior row of the log, never referenced from
  -- outside it and never on a wire, so an integer key is honest and cheap.
  -- AUTOINCREMENT so a number is never handed out twice, which keeps "in the
  -- order it was written" answerable from the key alone.
  id         INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,

  session_id TEXT NOT NULL REFERENCES dream_sessions (id) ON DELETE CASCADE,
  turn_index INTEGER,

  --   created     — a new inferred edge was written
  --   reactivated — a dormant edge was found and boosted, NOT duplicated
  --   suppressed  — an existing edge was pushed down
  --   rejected    — judged and not written; no edge exists
  disposition TEXT NOT NULL CHECK (
                disposition IN ('created', 'reactivated', 'suppressed', 'rejected')
              ),

  -- Opaque `syl:memory_edge:<uuidv7>`. NULL exactly when nothing was written.
  edge_id     TEXT,
  -- Opaque `syl:memory_node:<uuidv7>`. The pair is recorded even for a
  -- rejection, because "this pair keeps getting proposed and keeps getting
  -- refused" is a finding, and it is unreachable if only the edge id is kept.
  source_node TEXT NOT NULL,
  target_node TEXT NOT NULL,

  -- The partition tier before and after. Reactivation IS a tier transition
  -- (cold -> hot), so this is the evidence behind `edges_reactivated` and the
  -- place to look when that counter and reality disagree.
  tier_before TEXT CHECK (tier_before IS NULL OR tier_before IN ('hot', 'cold', 'suppressed')),
  tier_after  TEXT CHECK (tier_after  IS NULL OR tier_after  IN ('hot', 'cold', 'suppressed')),

  reasoning  TEXT NOT NULL,
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  created_at TEXT NOT NULL,

  -- Anything that was written has an edge; anything rejected has none. Stated
  -- as a constraint because the alternative is a NULL that means two different
  -- things depending on a column three over.
  CHECK ((disposition = 'rejected') = (edge_id IS NULL)),
  FOREIGN KEY (session_id, turn_index) REFERENCES dream_turns (session_id, turn_index)
) STRICT;

CREATE INDEX dream_edge_reasoning_session_idx ON dream_edge_reasoning (session_id, id);
-- "Show me every night this connection was touched" — the longitudinal
-- question about one edge, which is what the admin's edge view is for.
CREATE INDEX dream_edge_reasoning_edge_idx    ON dream_edge_reasoning (edge_id, id)
  WHERE edge_id IS NOT NULL;
CREATE INDEX dream_edge_reasoning_pair_idx    ON dream_edge_reasoning (source_node, target_node, id);

-- ---------------------------------------------------------------------------
-- dream_duplicate_edges — the evidence behind the zero invariant.
-- ---------------------------------------------------------------------------
--
-- One row per breach, and there should never be one. A bare counter says the
-- cold-partition identity lookup is broken; these rows say *which pair*, which
-- edge already existed, and — the field that actually names the bug —
-- `existing_tier`. A breach where `existing_tier = 'cold'` is the signature of
-- the exact failure syl-005.4.2 describes: the existence check ran against the
-- hot index only.

CREATE TABLE dream_duplicate_edges (
  id          INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL REFERENCES dream_sessions (id) ON DELETE CASCADE,
  turn_index  INTEGER,

  source_node TEXT NOT NULL,
  target_node TEXT NOT NULL,

  -- The edge that was already there and should have been reactivated.
  existing_edge_id TEXT NOT NULL,
  existing_tier    TEXT CHECK (
                     existing_tier IS NULL OR existing_tier IN ('hot', 'cold', 'suppressed')
                   ),
  -- The edge that was wrongly inserted, if it was inserted before the check
  -- caught it. NULL when the assertion fired first, which is the better case.
  inserted_edge_id TEXT,

  detected_at TEXT NOT NULL,
  note        TEXT,

  FOREIGN KEY (session_id, turn_index) REFERENCES dream_turns (session_id, turn_index)
) STRICT;

CREATE INDEX dream_duplicate_edges_session_idx ON dream_duplicate_edges (session_id, id);

-- ---------------------------------------------------------------------------
-- dream_surfaced — what she chose to tell him, and what he did about it.
-- ---------------------------------------------------------------------------
--
-- The only table here that is updated after the fact, and deliberately so:
-- engagement arrives later than the dream, sometimes days later. Everything
-- else in this file is append-only.

CREATE TABLE dream_surfaced (
  id          INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL REFERENCES dream_sessions (id) ON DELETE CASCADE,

  -- The reasoning row that justified surfacing this. The one foreign key in
  -- this file that crosses tables, and it stays inside the log.
  reasoning_id INTEGER REFERENCES dream_edge_reasoning (id) ON DELETE SET NULL,
  -- Opaque graph id, or NULL when what was surfaced is a synthesis over
  -- several edges rather than one.
  edge_id      TEXT,

  -- What she actually said, in the words she said it in. Not a reference to a
  -- message row: messages are the operational store's business and may be
  -- rewritten or aged out, and "what was he actually shown" has to stay
  -- answerable in three months.
  summary      TEXT NOT NULL,
  -- Where it went — `morning_agenda`, `push`, and so on. Free text: the set of
  -- delivery surfaces is still open (see CONTEXT §4) and a CHECK here would
  -- have to be migrated every time one is added.
  channel      TEXT,
  -- Opaque link to the message row, for the day someone wants the thread.
  message_id   TEXT,
  surfaced_at  TEXT NOT NULL,

  --   pending  — shown, no verdict yet
  --   engaged  — he acted on it. The large weight boost.
  --   ignored  — he saw it and moved on. Ordinary disuse.
  --   rejected — he saw it and said no. This is the SUPPRESSION signal, and it
  --              is the one that must never be lost, because a
  --              wrong-but-surfaced connection otherwise lingers precisely
  --              because it was shown once.
  response     TEXT NOT NULL DEFAULT 'pending' CHECK (
                 response IN ('pending', 'engaged', 'ignored', 'rejected')
               ),
  responded_at TEXT,

  -- A verdict has an instant and a non-verdict has none. The pair is what
  -- "whether he engaged with it" actually means, and letting them disagree
  -- would make an unanswered item indistinguishable from one answered at an
  -- unknown time.
  CHECK ((response = 'pending') = (responded_at IS NULL)),
  CHECK (responded_at IS NULL OR responded_at >= surfaced_at)
) STRICT;

CREATE INDEX dream_surfaced_session_idx ON dream_surfaced (session_id, id);
-- "What is he still sitting on" — the query the engagement sweep runs.
CREATE INDEX dream_surfaced_pending_idx ON dream_surfaced (surfaced_at) WHERE response = 'pending';

-- ---------------------------------------------------------------------------
-- Rollup triggers.
--
-- These are triggers rather than calls in the store for the same reason 0010's
-- are: a method added next year cannot forget to run them. Each recomputes
-- from a subquery rather than incrementing, so the rollup is a fact about the
-- rows and not a running total that a rollback, a correction or a retry can
-- knock out of step.
--
-- The cost is O(rows in the session) per write, against a handful of turns and
-- a handful of surfaced items per night. That is the right trade for a column
-- the Commander is going to read as truth.
-- ---------------------------------------------------------------------------

CREATE TRIGGER dream_turns_rollup_ai AFTER INSERT ON dream_turns BEGIN
  UPDATE dream_sessions SET
    turns        = (SELECT COUNT(*) FROM dream_turns WHERE session_id = NEW.session_id),
    tokens_spent = (SELECT COALESCE(SUM(tokens_spent), 0) FROM dream_turns
                     WHERE session_id = NEW.session_id),
    cost_usd     = (SELECT COALESCE(SUM(cost_usd), 0) FROM dream_turns
                     WHERE session_id = NEW.session_id)
  WHERE id = NEW.session_id;
END;

CREATE TRIGGER dream_turns_rollup_au AFTER UPDATE ON dream_turns BEGIN
  UPDATE dream_sessions SET
    turns        = (SELECT COUNT(*) FROM dream_turns WHERE session_id = NEW.session_id),
    tokens_spent = (SELECT COALESCE(SUM(tokens_spent), 0) FROM dream_turns
                     WHERE session_id = NEW.session_id),
    cost_usd     = (SELECT COALESCE(SUM(cost_usd), 0) FROM dream_turns
                     WHERE session_id = NEW.session_id)
  WHERE id = NEW.session_id;
END;

-- Nothing deletes a turn. The trigger exists anyway, because a rollup that is
-- only correct as long as nobody does the unexpected is a rollup that goes
-- wrong quietly on the day somebody does.
CREATE TRIGGER dream_turns_rollup_ad AFTER DELETE ON dream_turns BEGIN
  UPDATE dream_sessions SET
    turns        = (SELECT COUNT(*) FROM dream_turns WHERE session_id = OLD.session_id),
    tokens_spent = (SELECT COALESCE(SUM(tokens_spent), 0) FROM dream_turns
                     WHERE session_id = OLD.session_id),
    cost_usd     = (SELECT COALESCE(SUM(cost_usd), 0) FROM dream_turns
                     WHERE session_id = OLD.session_id)
  WHERE id = OLD.session_id;
END;

-- The zero invariant. Recording a breach and counting it are the same act:
-- the evidence cannot be written without the counter moving, and the counter
-- cannot move without the evidence being there to diagnose it.
CREATE TRIGGER dream_duplicate_edges_rollup_ai AFTER INSERT ON dream_duplicate_edges BEGIN
  UPDATE dream_sessions SET
    duplicate_edge_inserts = (SELECT COUNT(*) FROM dream_duplicate_edges
                               WHERE session_id = NEW.session_id)
  WHERE id = NEW.session_id;
END;

CREATE TRIGGER dream_surfaced_rollup_ai AFTER INSERT ON dream_surfaced BEGIN
  UPDATE dream_sessions SET
    surfaced_count = (SELECT COUNT(*) FROM dream_surfaced WHERE session_id = NEW.session_id),
    engaged_count  = (SELECT COUNT(*) FROM dream_surfaced
                       WHERE session_id = NEW.session_id AND response = 'engaged'),
    rejected_count = (SELECT COUNT(*) FROM dream_surfaced
                       WHERE session_id = NEW.session_id AND response = 'rejected')
  WHERE id = NEW.session_id;
END;

CREATE TRIGGER dream_surfaced_rollup_au AFTER UPDATE ON dream_surfaced BEGIN
  UPDATE dream_sessions SET
    surfaced_count = (SELECT COUNT(*) FROM dream_surfaced WHERE session_id = NEW.session_id),
    engaged_count  = (SELECT COUNT(*) FROM dream_surfaced
                       WHERE session_id = NEW.session_id AND response = 'engaged'),
    rejected_count = (SELECT COUNT(*) FROM dream_surfaced
                       WHERE session_id = NEW.session_id AND response = 'rejected')
  WHERE id = NEW.session_id;
END;
