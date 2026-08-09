-- 0009_todos_goals.sql — the life model the contract has been promising.
--
-- `shared/openapi.yaml` has published `/todos` and `/goals` since the contract
-- was written, the mock has served them (its routing table is derived from the
-- spec, so it could not do otherwise), and both clients were built against
-- that. No table existed. `syl-c1m`.
--
-- Two shapes, and the arguments for each are in the contract next to the
-- schemas:
--
--   * A to-do has **no priority ladder**. Priority is a property of a moment,
--     not of a task, so the only durable bit is `pinned`. Ordering is computed
--     at read time (see `todos_agenda_idx` and `TodoService.list`).
--   * A goal **self-nests** through `parent_id`; there is no separate
--     objective or key-result entity, and there is no percent-complete column.
--     Self-reported percentages are fiction and they decay.
--
-- `goals` is created first because `todos.goal_id` references it.

CREATE TABLE goals (
  id            TEXT    NOT NULL PRIMARY KEY,

  -- Goals self-nest. A NULL parent is a root goal; nothing enforces the depth
  -- because a life does not have a fixed number of levels in it.
  parent_id     TEXT    REFERENCES goals (id),

  title         TEXT    NOT NULL,

  -- The only optional field Syl should ever push for.
  why           TEXT,

  -- `YYYY-MM-DD`. The horizon — life / year / season / month — is DERIVED from
  -- this, never stored: a stored horizon and a stored date disagree the moment
  -- one of them is edited.
  target_date   TEXT,

  metric_key    TEXT,
  target_value  REAL,

  -- Drives the silence signal: nothing linked to this goal for longer than
  -- this many days is a risk worth raising.
  cadence_days  INTEGER CHECK (cadence_days IS NULL OR cadence_days >= 1),

  -- `abandoned` is a first-class, non-shameful outcome, and `dormant` is a
  -- real state rather than a soft delete — reactivating a dormant goal
  -- restores its history intact, which is only possible because nothing is
  -- removed to express it.
  status        TEXT    NOT NULL CHECK (
                  status IN ('proposed', 'active', 'dormant', 'achieved', 'abandoned')
                ),
  status_reason TEXT,

  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
) STRICT;

CREATE INDEX goals_status_idx ON goals (status, created_at DESC);
CREATE INDEX goals_parent_idx ON goals (parent_id);

CREATE TABLE todos (
  id               TEXT    NOT NULL PRIMARY KEY,
  text             TEXT    NOT NULL,

  -- The link that makes a goal's progress evidenced rather than asserted.
  goal_id          TEXT    REFERENCES goals (id),

  due_at           TEXT,

  -- The one durable bit of "this one matters".
  pinned           INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),

  -- `proposed` is inferred structure, not an explicit ask: provisional and
  -- visible. An explicit ask is never provisional and lands as `open`.
  status           TEXT    NOT NULL CHECK (status IN ('proposed', 'open', 'done', 'dropped')),
  source           TEXT    NOT NULL CHECK (source IN ('commander', 'inferred', 'imported')),

  -- The seam between the life model and the job system. A to-do is something
  -- *he* must do; a job is something *Syl* must do. One nullable column joins
  -- them, and it is a real reference so a delegation cannot dangle.
  delegated_job_id TEXT    REFERENCES jobs (id),

  created_at       TEXT    NOT NULL,
  updated_at       TEXT    NOT NULL,
  completed_at     TEXT
) STRICT;

-- Agenda order, materialised as an index so the read is a scan rather than a
-- sort: pinned first, then the soonest deadline, then newest. `due_at IS NULL`
-- sorts last because a to-do with no deadline is not more urgent than one with
-- a deadline today — SQLite orders NULLs first by default, which is exactly
-- backwards for this question.
CREATE INDEX todos_agenda_idx
  ON todos (pinned DESC, due_at IS NULL, due_at, created_at DESC);

CREATE INDEX todos_status_idx ON todos (status, created_at DESC);
CREATE INDEX todos_goal_idx ON todos (goal_id);

-- `reminders.todo_id` has pointed at a table that did not exist since 0006.
--
-- It cannot be given a real FOREIGN KEY now: SQLite adds one only by rebuilding
-- the table, and 0006 is checksummed and shipped. A pair of triggers enforces
-- the same rule at the same moment a constraint would, which is the whole of
-- what a foreign key buys — the difference is that these say so in English.
CREATE TRIGGER reminders_todo_fk_insert
BEFORE INSERT ON reminders
WHEN NEW.todo_id IS NOT NULL
 AND NOT EXISTS (SELECT 1 FROM todos WHERE id = NEW.todo_id)
BEGIN
  SELECT RAISE(ABORT, 'reminders.todo_id must reference an existing todo');
END;

CREATE TRIGGER reminders_todo_fk_update
BEFORE UPDATE OF todo_id ON reminders
WHEN NEW.todo_id IS NOT NULL
 AND NOT EXISTS (SELECT 1 FROM todos WHERE id = NEW.todo_id)
BEGIN
  SELECT RAISE(ABORT, 'reminders.todo_id must reference an existing todo');
END;
