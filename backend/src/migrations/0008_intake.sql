-- 0008_intake.sql — article intake: sources, chunks, extracts, and the mailbox.
--
-- This schema existed as a string constant inside `connections/intake-store.ts`
-- and was applied only by intake's own test helper. Every intake unit test
-- passed and `IntakeStore.create` threw `no such table: intake_sources` against
-- the database `bootstrap` actually opens (`syl-1o7`). Each side was
-- individually correct — the store was right about what it queried and the
-- migrations were right about what they created — and only the join of the two
-- was wrong, which is why nothing below the integration layer could see it.
--
-- ## The provenance chain is a foreign key, not a convention
--
-- Every chunk and every extract references its source `ON DELETE CASCADE`, and
-- `PRAGMA foreign_keys` is on. That is what makes `IntakeStore.purge` a real
-- hard delete rather than a hopeful one: deleting a source removes everything
-- descended from it, including rows written by a table added next year. The
-- alternative — remembering to delete the children — works until the day
-- somebody adds a fourth table.
--
-- ## Idempotency is a unique index
--
-- `canonical_url` is UNIQUE. The same link arriving twice, from the Share
-- Extension and again from a forwarded email, is one source — under a
-- constraint the database enforces rather than a check a race can slip past.
-- That is what makes every step of intake safe to retry.
--
-- ## `origin` is always 'untrusted'
--
-- It is a column rather than an assumption because everything derived from a
-- source inherits it. A link the Commander forwarded himself is exactly as
-- hostile as one Syl found: the sender establishes *who asked*, never *what
-- the payload is allowed to do*.

CREATE TABLE intake_sources (
  id              TEXT    NOT NULL PRIMARY KEY,
  url             TEXT    NOT NULL,
  canonical_url   TEXT    NOT NULL UNIQUE,
  channel         TEXT    NOT NULL,
  requested_by    TEXT    NOT NULL,
  origin          TEXT    NOT NULL,
  retention_class TEXT    NOT NULL,
  retention_reason TEXT   NOT NULL,
  stage           TEXT    NOT NULL,
  title           TEXT,
  content_hash    TEXT,
  media_type      TEXT,
  bytes           INTEGER NOT NULL,
  chunk_count     INTEGER NOT NULL,
  failure         TEXT,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL,
  expires_at      TEXT
) STRICT;

CREATE INDEX intake_sources_stage ON intake_sources (stage);
CREATE INDEX intake_sources_expires_at ON intake_sources (expires_at);

CREATE TABLE intake_chunks (
  source_id  TEXT    NOT NULL REFERENCES intake_sources (id) ON DELETE CASCADE,
  idx        INTEGER NOT NULL,
  start_off  INTEGER NOT NULL,
  end_off    INTEGER NOT NULL,
  body       TEXT    NOT NULL,
  PRIMARY KEY (source_id, idx)
) STRICT;

CREATE TABLE intake_extracts (
  id              TEXT    NOT NULL PRIMARY KEY,
  source_id       TEXT    NOT NULL REFERENCES intake_sources (id) ON DELETE CASCADE,
  chunk_index     INTEGER NOT NULL,
  start_off       INTEGER NOT NULL,
  end_off         INTEGER NOT NULL,
  origin          TEXT    NOT NULL,
  retention_class TEXT    NOT NULL,
  body            TEXT    NOT NULL,
  created_at      TEXT    NOT NULL,
  UNIQUE (source_id, chunk_index)
) STRICT;

-- Which intake emails have already been handled.
--
-- The key has to be ours. Marking a message read or labelling it in Gmail
-- would need the gmail.modify scope, which also grants send, and Syl is
-- never getting the ability to send as him for the sake of a checkbox. So the
-- provider's message id is recorded here instead, and a mail that arrives
-- twice through a re-poll is one submission.
CREATE TABLE intake_mail (
  message_id   TEXT    NOT NULL PRIMARY KEY,
  received_at  TEXT    NOT NULL,
  sender       TEXT    NOT NULL,
  subject      TEXT,
  disposition  TEXT    NOT NULL,
  link_count   INTEGER NOT NULL,
  processed_at TEXT    NOT NULL
) STRICT;

-- Where the incremental mail sync got to. One row per watched address.
CREATE TABLE intake_mail_cursor (
  address    TEXT NOT NULL PRIMARY KEY,
  history_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
