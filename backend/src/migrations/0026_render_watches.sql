-- 0026_render_watches.sql — coming back to look at a render she started.
--
-- > *"When Syl triggers a video to be rendered she needs some kind of wake up
-- > mechanism five minutes later to check to see whether or not it's done and
-- > whether or not she wants to send it to me. If she decides to send it at
-- > that point, the push notification would go out."*
-- >                                        — the Commander, overruling
--
-- Before this table the notification went out at COMPOSE time and the video
-- was chased behind it, so a buzz could lead to a video that was still
-- rendering, or had failed. The order is now the other way round: the render
-- happens, she comes back and looks at it, and only her decision at that point
-- reaches him. This table is what makes "comes back" survive a restart.
--
-- ## Why a row and not a timer
--
-- A `setTimeout` dies with the process, and the five-minute window is exactly
-- long enough for a deploy to land inside it. The job runner already polls
-- rows and already reschedules itself from the clock rather than from a
-- counter (`jobs/reminder-delivery-job.ts`), so a due row is the one shape
-- that survives a restart, a laptop lid, and an NTP correction alike.
--
-- ## Why its own table and not a job row
--
-- A job is a KIND with a trigger; it carries no payload, so a job row cannot
-- say *which render*. One `render_review` job polls this table, and this table
-- says what each wake is about. That is `reminder_delivery`'s shape exactly:
-- one job, many rows, the job scheduling itself for the earliest of them.
--
-- ## A watch is never silently dropped, and never spins forever
--
-- Constraint 4's spirit one noun along. `attempts` bounds how many times a
-- render that is still going may be deferred, and every deferral must be to a
-- strictly later instant — the store enforces both. When the bound is reached
-- the row is settled `gave_up` WITH a note and she is woken once to be told,
-- so a render that never finished is a thing she knows about rather than a row
-- that quietly stopped being looked at.
--
-- The three states are the three honest answers to "what became of this
-- render": still waiting to be looked at, looked at and decided, or given up
-- on. There is no fourth, and in particular there is no state meaning
-- "forgotten".

CREATE TABLE render_watches (
  id           TEXT NOT NULL PRIMARY KEY,

  -- The render this wake is about. UNIQUE: one watch per render, so a retried
  -- start — or a second process racing the first — adopts the watch that is
  -- already there rather than arranging to wake her twice about one clip.
  render_name  TEXT NOT NULL UNIQUE CHECK (length(trim(render_name)) > 0),

  -- Why she made it, carried from the render's own record. The wake happens
  -- minutes later on a fresh thread that remembers nothing, so without this
  -- she would be handed a machine-generated name and asked to have an opinion.
  because      TEXT NOT NULL CHECK (length(trim(because)) > 0),

  -- `waiting`  — nobody has decided yet; `check_at` says when to look.
  -- `decided`  — she looked and made her call, whatever it was. Sending and
  --              declining are the same state: both are her decision, and a
  --              schema that recorded only the sends would be a schema that
  --              treats her restraint as a missing value.
  -- `gave_up`  — the bound was reached. Recorded, never merely dropped.
  state        TEXT NOT NULL CHECK (state IN ('waiting', 'decided', 'gave_up')),

  -- When to look next. NULL once settled, which is what keeps a decided watch
  -- out of the due query without a second predicate to forget.
  check_at     TEXT,

  -- How many times this watch has been picked up. The bound on re-checks, and
  -- the reason a render that will never finish costs a fixed number of wakes.
  attempts     INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),

  -- What happened, in a sentence: her own line about the decision, or why it
  -- was given up on. A settled watch always has one — a settlement with no
  -- explanation teaches nothing and reads as a bug.
  note         TEXT,

  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,

  -- Waiting means there is an instant to wait for; settled means there is a
  -- sentence and nothing further to wait for. Neither is expressible half-done.
  --
  -- A table constraint rather than a column one, because it spans three
  -- columns — and therefore it has to come after every column definition.
  -- SQLite's parser gives no help here: a table CHECK written in the middle of
  -- the column list fails with `near "created_at": syntax error`, naming the
  -- innocent column that follows it.
  CHECK (
    (state = 'waiting' AND check_at IS NOT NULL)
    OR (state <> 'waiting' AND check_at IS NULL AND length(trim(coalesce(note, ''))) > 0)
  )
) STRICT;

-- The one query the job makes on every tick: what is waiting, and due. Both
-- columns, in this order, because the state narrows it to a handful of rows
-- before the instant is compared at all.
CREATE INDEX render_watches_due_idx ON render_watches (state, check_at);

-- ---------------------------------------------------------------------------
-- A watch is settled, never removed.
--
-- The same rule the rest of this schema keeps: the system does not get to
-- silently discard things. A deleted watch is indistinguishable from a render
-- nobody ever looked at, which is precisely the state the table exists to make
-- impossible.
-- ---------------------------------------------------------------------------

CREATE TRIGGER render_watches_never_deleted
BEFORE DELETE ON render_watches
BEGIN
  SELECT RAISE(
    ABORT,
    'a render watch is settled, never deleted: it is the record that she was going to come back and look'
  );
END;
