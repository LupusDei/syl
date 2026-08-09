-- 0001_baseline.sql — the ground every other table stands on.
--
-- Conventions fixed here and relied on by every later migration:
--
--   * Columns are snake_case. The wire is camelCase. The mapping happens at
--     the store boundary and nowhere else (shared/openapi.yaml, "Field
--     naming"). Two vocabularies, one translation point.
--   * Every table is STRICT. Without it SQLite stores whatever it is handed,
--     so a number written into a TEXT instant column comes back as a number
--     months later in an unrelated code path, and the CHECK constraints below
--     become suggestions.
--   * Instants are TEXT, RFC 3339, UTC, millisecond precision — the same
--     spelling the contract puts on the wire, so no format conversion is
--     needed to serve a row and no fixed offset can creep in.

CREATE TABLE conversations (
  id              TEXT    NOT NULL PRIMARY KEY,
  lane            TEXT    NOT NULL CHECK (lane IN ('interactive', 'job')),
  title           TEXT,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL,
  last_message_at TEXT,
  message_count   INTEGER NOT NULL DEFAULT 0 CHECK (message_count >= 0)
) STRICT;

CREATE INDEX conversations_lane_updated_idx
  ON conversations (lane, updated_at DESC);

-- The interactive conversation is seeded here, in the very first migration,
-- rather than created lazily on first use.
--
-- Its id is a constant that the client and the server both hard-code, and two
-- parties using a constant cannot disagree. Adjutant reconstructed
-- conversation scope from sender and recipient instead, shipped messages into
-- the wrong thread, and paid for it twice: once in the bug and again in a
-- backfill migration with an audit log.
--
-- Seeding it in migration one means the thread exists before any store can
-- write message number one, so "which conversation does this belong to" has an
-- answer from the first row onward and can never be nullable.
INSERT INTO conversations (
  id,
  lane,
  title,
  created_at,
  updated_at,
  last_message_at,
  message_count
) VALUES (
  'syl:conversation:00000000-0000-7000-8000-000000000001',
  'interactive',
  NULL,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  NULL,
  0
);
