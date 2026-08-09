-- 0010_sync_log.sql — the feed behind `GET /sync`.
--
-- ## What this is for, stated before it is built
--
-- A phone that has been offline for a week must be able to come back and find
-- out what changed, without downloading everything and without missing
-- anything. That is the whole job. `GET /sync` is the **pull** half of the
-- device's loop; the push half is the ordinary write endpoints, each carrying
-- an `Idempotency-Key`.
--
-- Because the pull half never accepts client state, **`GET /sync` cannot have
-- a conflict**. There is nothing to merge: the server is the sole authority,
-- the device's own writes went through the write endpoints before the pull
-- ran, and the pull hands back the server's row, which replaces whatever the
-- device was holding optimistically. A sync endpoint whose conflict semantics
-- cannot be stated is a data-loss bug waiting to be written; this one's
-- semantics are "there are none, by construction", which is the only version
-- of that answer worth trusting.
--
-- ## Why a sequence and not a timestamp
--
-- The obvious cursor is `updated_at`. It is wrong, and it fails silently: if
-- the wall clock ever steps backwards — NTP correction, a laptop waking in
-- another zone — a row written during the step lands *before* a cursor the
-- device already holds and is never seen again. A row that vanishes from a
-- sync feed is indistinguishable from a row that was never written.
--
-- `INTEGER PRIMARY KEY AUTOINCREMENT` is monotonic regardless of the clock and
-- never reuses a value even after a delete. The cursor is that sequence,
-- base64-wrapped so no client can be tempted to do arithmetic on it.
--
-- ## Why the log carries no payload
--
-- A row here says *that* something changed, never *what it changed to*. The
-- resource is read from its own table when the response is built. Three
-- consequences, all wanted:
--
--   1. The wire shape is produced by the same store code that serves
--      `GET /todos`, so the feed cannot drift from the endpoints.
--   2. A device that pages slowly sees fewer, fresher changes rather than a
--      replay of history it would only overwrite anyway.
--   3. `op` is decided at read time: `delete` exactly when the row is gone,
--      `upsert` otherwise. No table currently hard-deletes a synced resource
--      (rows are closed, not removed), so `delete` is a shape the feed
--      supports and does not presently emit.
--
-- Delivery is at-least-once. Replaying a cursor re-delivers, and every change
-- is an id-keyed upsert or delete, so a duplicate is a no-op on the device.

CREATE TABLE sync_log (
  -- Monotonic. AUTOINCREMENT rather than a bare INTEGER PRIMARY KEY so a
  -- deleted high row cannot have its number handed out again, which would move
  -- a cursor backwards.
  seq  INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,

  type TEXT NOT NULL CHECK (
         type IN (
           'conversation', 'message', 'reminder', 'todo', 'goal',
           'device', 'delivery', 'job', 'run'
         )
       ),
  id   TEXT NOT NULL,

  -- The changed row's own newest instant, taken from the row rather than from
  -- SQLite's clock: every instant in this database is written by the service's
  -- injected clock, and a trigger calling `strftime('now')` would be the one
  -- place that is not true.
  at   TEXT NOT NULL
) STRICT;

-- The only read: "everything after this sequence", optionally narrowed by type.
CREATE INDEX sync_log_type_idx ON sync_log (type, seq);

-- ---------------------------------------------------------------------------
-- Backfill, before any trigger exists.
--
-- Without this, a device bootstrapping from cursor zero would never be told
-- about a row that predates this migration — and migration 0001 seeds the
-- interactive conversation, which is the single row every client needs before
-- it can send anything at all. "The feed contains everything" has to be true
-- from the first row, not from the moment the triggers were installed.
-- ---------------------------------------------------------------------------

INSERT INTO sync_log (type, id, at)
  SELECT 'conversation', id, updated_at FROM conversations ORDER BY updated_at, id;
INSERT INTO sync_log (type, id, at)
  SELECT 'goal', id, updated_at FROM goals ORDER BY updated_at, id;
INSERT INTO sync_log (type, id, at)
  SELECT 'todo', id, updated_at FROM todos ORDER BY updated_at, id;
INSERT INTO sync_log (type, id, at)
  SELECT 'message', id, created_at FROM messages ORDER BY created_at, id;
INSERT INTO sync_log (type, id, at)
  SELECT 'reminder', id, updated_at FROM reminders ORDER BY updated_at, id;
INSERT INTO sync_log (type, id, at)
  SELECT 'device', id, last_seen_at FROM devices ORDER BY last_seen_at, id;
INSERT INTO sync_log (type, id, at)
  SELECT 'delivery', id, COALESCE(acked_at, delivered_at, created_at)
    FROM deliveries ORDER BY created_at, id;
INSERT INTO sync_log (type, id, at)
  SELECT 'job', id, updated_at FROM jobs ORDER BY updated_at, id;
INSERT INTO sync_log (type, id, at)
  SELECT 'run', id, COALESCE(finished_at, started_at) FROM runs ORDER BY started_at, id;

-- ---------------------------------------------------------------------------
-- The triggers.
--
-- Three per synced table, and they are triggers rather than calls in the
-- service layer on purpose: a store method added next year cannot forget to
-- log. That is the same argument the FTS5 index in 0003 makes, and it is the
-- reason this migration is long and boring instead of short and hopeful.
-- ---------------------------------------------------------------------------

-- conversations ------------------------------------------------------------
CREATE TRIGGER sync_conversations_ai AFTER INSERT ON conversations BEGIN
  INSERT INTO sync_log (type, id, at) VALUES ('conversation', NEW.id, NEW.updated_at);
END;
CREATE TRIGGER sync_conversations_au AFTER UPDATE ON conversations BEGIN
  INSERT INTO sync_log (type, id, at) VALUES ('conversation', NEW.id, NEW.updated_at);
END;
CREATE TRIGGER sync_conversations_ad AFTER DELETE ON conversations BEGIN
  INSERT INTO sync_log (type, id, at) VALUES ('conversation', OLD.id, OLD.updated_at);
END;

-- messages -----------------------------------------------------------------
-- A message has no `updated_at`: it is written once and never edited.
CREATE TRIGGER sync_messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO sync_log (type, id, at) VALUES ('message', NEW.id, NEW.created_at);
END;
CREATE TRIGGER sync_messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO sync_log (type, id, at) VALUES ('message', NEW.id, NEW.created_at);
END;
CREATE TRIGGER sync_messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO sync_log (type, id, at) VALUES ('message', OLD.id, OLD.created_at);
END;

-- reminders ----------------------------------------------------------------
CREATE TRIGGER sync_reminders_ai AFTER INSERT ON reminders BEGIN
  INSERT INTO sync_log (type, id, at) VALUES ('reminder', NEW.id, NEW.updated_at);
END;
CREATE TRIGGER sync_reminders_au AFTER UPDATE ON reminders BEGIN
  INSERT INTO sync_log (type, id, at) VALUES ('reminder', NEW.id, NEW.updated_at);
END;
CREATE TRIGGER sync_reminders_ad AFTER DELETE ON reminders BEGIN
  INSERT INTO sync_log (type, id, at) VALUES ('reminder', OLD.id, OLD.updated_at);
END;

-- todos --------------------------------------------------------------------
CREATE TRIGGER sync_todos_ai AFTER INSERT ON todos BEGIN
  INSERT INTO sync_log (type, id, at) VALUES ('todo', NEW.id, NEW.updated_at);
END;
CREATE TRIGGER sync_todos_au AFTER UPDATE ON todos BEGIN
  INSERT INTO sync_log (type, id, at) VALUES ('todo', NEW.id, NEW.updated_at);
END;
CREATE TRIGGER sync_todos_ad AFTER DELETE ON todos BEGIN
  INSERT INTO sync_log (type, id, at) VALUES ('todo', OLD.id, OLD.updated_at);
END;

-- goals --------------------------------------------------------------------
CREATE TRIGGER sync_goals_ai AFTER INSERT ON goals BEGIN
  INSERT INTO sync_log (type, id, at) VALUES ('goal', NEW.id, NEW.updated_at);
END;
CREATE TRIGGER sync_goals_au AFTER UPDATE ON goals BEGIN
  INSERT INTO sync_log (type, id, at) VALUES ('goal', NEW.id, NEW.updated_at);
END;
CREATE TRIGGER sync_goals_ad AFTER DELETE ON goals BEGIN
  INSERT INTO sync_log (type, id, at) VALUES ('goal', OLD.id, OLD.updated_at);
END;

-- devices ------------------------------------------------------------------
-- `last_seen_at` is the device row's newest instant; `registered_at` is fixed
-- at first registration and would report a re-registration as ancient.
CREATE TRIGGER sync_devices_ai AFTER INSERT ON devices BEGIN
  INSERT INTO sync_log (type, id, at) VALUES ('device', NEW.id, NEW.last_seen_at);
END;
CREATE TRIGGER sync_devices_au AFTER UPDATE ON devices BEGIN
  INSERT INTO sync_log (type, id, at) VALUES ('device', NEW.id, NEW.last_seen_at);
END;
CREATE TRIGGER sync_devices_ad AFTER DELETE ON devices BEGIN
  INSERT INTO sync_log (type, id, at) VALUES ('device', OLD.id, OLD.last_seen_at);
END;

-- deliveries ---------------------------------------------------------------
-- `next_attempt_at` is deliberately not in the COALESCE: it is a FUTURE
-- instant, and a change stamped in the future is a change no cursor can be
-- reasoned about.
CREATE TRIGGER sync_deliveries_ai AFTER INSERT ON deliveries BEGIN
  INSERT INTO sync_log (type, id, at)
  VALUES ('delivery', NEW.id, COALESCE(NEW.acked_at, NEW.delivered_at, NEW.created_at));
END;
CREATE TRIGGER sync_deliveries_au AFTER UPDATE ON deliveries BEGIN
  INSERT INTO sync_log (type, id, at)
  VALUES ('delivery', NEW.id, COALESCE(NEW.acked_at, NEW.delivered_at, NEW.created_at));
END;
CREATE TRIGGER sync_deliveries_ad AFTER DELETE ON deliveries BEGIN
  INSERT INTO sync_log (type, id, at)
  VALUES ('delivery', OLD.id, COALESCE(OLD.acked_at, OLD.delivered_at, OLD.created_at));
END;

-- jobs ---------------------------------------------------------------------
CREATE TRIGGER sync_jobs_ai AFTER INSERT ON jobs BEGIN
  INSERT INTO sync_log (type, id, at) VALUES ('job', NEW.id, NEW.updated_at);
END;
CREATE TRIGGER sync_jobs_au AFTER UPDATE ON jobs BEGIN
  INSERT INTO sync_log (type, id, at) VALUES ('job', NEW.id, NEW.updated_at);
END;
CREATE TRIGGER sync_jobs_ad AFTER DELETE ON jobs BEGIN
  INSERT INTO sync_log (type, id, at) VALUES ('job', OLD.id, OLD.updated_at);
END;

-- runs ---------------------------------------------------------------------
CREATE TRIGGER sync_runs_ai AFTER INSERT ON runs BEGIN
  INSERT INTO sync_log (type, id, at)
  VALUES ('run', NEW.id, COALESCE(NEW.finished_at, NEW.started_at));
END;
CREATE TRIGGER sync_runs_au AFTER UPDATE ON runs BEGIN
  INSERT INTO sync_log (type, id, at)
  VALUES ('run', NEW.id, COALESCE(NEW.finished_at, NEW.started_at));
END;
CREATE TRIGGER sync_runs_ad AFTER DELETE ON runs BEGIN
  INSERT INTO sync_log (type, id, at)
  VALUES ('run', OLD.id, COALESCE(OLD.finished_at, OLD.started_at));
END;

-- run_steps ----------------------------------------------------------------
-- A step is not a synced resource of its own; it is a field of the run that
-- carries it, and `GET /runs/{id}` returns the steps inline. Appending one
-- therefore changes the *run*, and without this the transcript of a run would
-- grow on the server and never reach a client that had already seen the run.
CREATE TRIGGER sync_run_steps_ai AFTER INSERT ON run_steps BEGIN
  INSERT INTO sync_log (type, id, at)
  VALUES ('run', NEW.run_id, COALESCE(NEW.finished_at, NEW.started_at));
END;
CREATE TRIGGER sync_run_steps_au AFTER UPDATE ON run_steps BEGIN
  INSERT INTO sync_log (type, id, at)
  VALUES ('run', NEW.run_id, COALESCE(NEW.finished_at, NEW.started_at));
END;
CREATE TRIGGER sync_run_steps_ad AFTER DELETE ON run_steps BEGIN
  INSERT INTO sync_log (type, id, at)
  VALUES ('run', OLD.run_id, COALESCE(OLD.finished_at, OLD.started_at));
END;
