-- 0007_jobs.sql — jobs, runs, and the steps inside a run.
--
-- A job is a unit of work the SERVICE owns. Not a prompt, not an intention the
-- model formed — a row, with a `kind` from a closed catalogue. That catalogue
-- is the trust boundary pushed down one level: the model may enqueue a job, it
-- may never invent a kind. If it could, a prompt injection inside an article
-- would become a scheduled job that speaks to the Commander every morning.
--
-- Note the shape of the catalogue. The two kinds carrying a hard guarantee —
-- `reminder_delivery` and `maintenance` — are the two that use no turns. That
-- is not a coincidence; it is the design.

CREATE TABLE jobs (
  id             TEXT    NOT NULL PRIMARY KEY,
  kind           TEXT    NOT NULL CHECK (kind IN (
                   'reminder_delivery', 'morning_agenda', 'evening_review', 'heartbeat',
                   'nightly_consolidation', 'research_brief', 'content_ingestion', 'maintenance'
                 )),
  state          TEXT    NOT NULL CHECK (state IN (
                   'pending', 'leased', 'running', 'done', 'failed', 'abandoned', 'suspended'
                 )),
  -- Background never starts while interactive work is pending.
  priority       TEXT    NOT NULL CHECK (priority IN (
                   'interactive', 'reminder', 'scheduled', 'background'
                 )),

  trigger_json   TEXT    NOT NULL,
  delivery_class TEXT    NOT NULL CHECK (delivery_class IN (
                   'at_least_once', 'at_least_once_resumable', 'at_most_once', 'once_per_window'
                 )),
  catch_up_json  TEXT    NOT NULL,
  budget_json    TEXT    NOT NULL,

  -- What makes reboot recovery possible. A lease whose owner is not this
  -- process, or whose expiry has passed, is reclaimed BEFORE anything is
  -- scheduled: a runner that starts scheduling before it has looked at what it
  -- missed silently swallows whatever was due while it was down.
  lease_owner       TEXT,
  lease_expires_at  TEXT,

  -- N consecutive failures disable a kind and report once. Nothing retries
  -- forever.
  breaker_state     TEXT    NOT NULL DEFAULT 'closed'
                            CHECK (breaker_state IN ('closed', 'open', 'half_open')),
  breaker_failures  INTEGER NOT NULL DEFAULT 0 CHECK (breaker_failures >= 0),
  breaker_opened_at TEXT,

  next_run_at    TEXT,
  last_run_id    TEXT,

  -- Whether this kind may produce a proactive message at all.
  speaks         INTEGER NOT NULL DEFAULT 0 CHECK (speaks IN (0, 1)),

  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
) STRICT;

-- The question the timer asks on every tick: what is due, highest priority
-- first?
CREATE INDEX jobs_due_idx ON jobs (state, next_run_at);
CREATE INDEX jobs_lease_idx ON jobs (lease_expires_at);

-- Every run records the gap between SCHEDULED and ACTUAL. That gap is the
-- whole point: a reminder that fired late is a nuisance, and one that pretended
-- to be on time is a lie. Lateness is invisible unless it is recorded from day
-- one, so it is a column rather than something derivable later.
CREATE TABLE runs (
  id              TEXT    NOT NULL PRIMARY KEY,
  job_id          TEXT    NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  kind            TEXT    NOT NULL,
  trigger_instant TEXT    NOT NULL,
  actual_instant  TEXT,
  lateness_ms     INTEGER NOT NULL DEFAULT 0,

  -- A run in flight carries `abandoned` and a null `finished_at`. That is not
  -- a placeholder — it is the truthful answer to "what was this run, if we
  -- never come back to it", which is exactly what a crash makes true. The
  -- outcome is overwritten when the run concludes.
  outcome         TEXT    NOT NULL CHECK (outcome IN (
                    'success', 'failure', 'skipped', 'suspended', 'abandoned'
                  )),

  spoke           INTEGER NOT NULL DEFAULT 0 CHECK (spoke IN (0, 1)),
  turns           INTEGER NOT NULL DEFAULT 0 CHECK (turns >= 0),
  cost_usd        REAL    NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  summary         TEXT,
  error           TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  started_at      TEXT    NOT NULL,
  finished_at     TEXT
) STRICT;

CREATE INDEX runs_job_idx ON runs (job_id, started_at DESC);
CREATE INDEX runs_started_idx ON runs (started_at DESC);

-- Persisted after every turn and before the next one starts, because a turn is
-- atomic from the outside: either it completed and we recorded the result, the
-- session id, the turn count and the cost, or it did not and there is nothing
-- partial to reconcile. Resume is `--resume` against the stored session id.
CREATE TABLE run_steps (
  id          TEXT    NOT NULL PRIMARY KEY,
  run_id      TEXT    NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  step_index  INTEGER NOT NULL CHECK (step_index >= 0),
  session_id  TEXT,
  num_turns   INTEGER NOT NULL DEFAULT 0 CHECK (num_turns >= 0),
  cost_usd    REAL    NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  outcome     TEXT    NOT NULL CHECK (outcome IN (
                'success', 'failure', 'skipped', 'suspended', 'abandoned'
              )),
  summary     TEXT,
  started_at  TEXT    NOT NULL,
  finished_at TEXT,

  UNIQUE (run_id, step_index)
) STRICT;
