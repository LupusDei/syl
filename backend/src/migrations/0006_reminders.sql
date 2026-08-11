-- 0006_reminders.sql — the thing the whole project exists to deliver.
--
-- `text` is composed at CREATION time, in Syl's voice, and read verbatim at
-- delivery. That is not a storage detail, it is the reason delivery can be a
-- zero-turn path: nothing downstream needs a model in order to know what to
-- say, so nothing downstream can be delayed by a rate limit or broken by a
-- model declining to act. A perfectly reliable pipeline delivering flat,
-- characterless text would be mechanically correct and tonally wrong, so the
-- character is paid for once, up front, where failure is visible.
--
-- `wall_time` + `tz` rather than a stored offset. An offset is a property of an
-- instant, not of a place; one that reaches storage survives exactly one
-- daylight-saving boundary and then moves every recurring reminder by an hour.
-- `next_fire_at` is the materialised instant, recomputed from the wall time and
-- the zone rather than incremented by 24 hours.

CREATE TABLE reminders (
  id                  TEXT    NOT NULL PRIMARY KEY,

  -- Drives the catch-up policy, which is why it is on the row. A commitment
  -- never collapses: it fires late and says it is late. A rhythm message does
  -- the opposite — yesterday's morning agenda is worthless today, so it is
  -- superseded, and the suppression is reported rather than hidden.
  kind                TEXT    NOT NULL CHECK (kind IN ('commitment', 'rhythm')),

  text                TEXT    NOT NULL,
  todo_id             TEXT,
  event_id            TEXT,

  wall_time           TEXT    NOT NULL,
  tz                  TEXT    NOT NULL,

  -- RFC 5545, restricted to a deliberate subset. Anything outside it is
  -- rejected at write time rather than half-supported: a rule that parses but
  -- schedules wrongly is a silently dropped reminder wearing a valid row.
  rrule               TEXT,

  -- The instant this occurrence was originally due. Survives deferral and
  -- lateness, so the client can still say "this was due Tuesday at 09:00".
  scheduled_for       TEXT    NOT NULL,
  next_fire_at        TEXT    NOT NULL,

  urgent              INTEGER NOT NULL DEFAULT 0 CHECK (urgent IN (0, 1)),
  late                INTEGER NOT NULL DEFAULT 0 CHECK (late IN (0, 1)),

  -- The previous next_fire_at in the deferral chain. Deferral must always move
  -- strictly forward; this column is what makes the chain auditable.
  deferred_from       TEXT,

  supersedes_previous INTEGER NOT NULL DEFAULT 0 CHECK (supersedes_previous IN (0, 1)),

  -- How many occurrences of a rhythm message were skipped because they were
  -- too late to be worth saying. Counted rather than discarded so the next one
  -- can say what it skipped — silent suppression is the failure mode this
  -- whole design is built against.
  skipped_count       INTEGER NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),

  delivery_state      TEXT    NOT NULL CHECK (
                        delivery_state IN (
                          'scheduled', 'due', 'delivered', 'acknowledged',
                          'deferred', 'completed', 'cancelled', 'failed'
                        )
                      ),

  created_at          TEXT    NOT NULL,
  updated_at          TEXT    NOT NULL,
  completed_at        TEXT
) STRICT;

-- The only question the delivery job asks: what is due?
CREATE INDEX reminders_due_idx ON reminders (delivery_state, next_fire_at);

-- The app's list view, and the admin's.
CREATE INDEX reminders_listing_idx ON reminders (created_at DESC);
