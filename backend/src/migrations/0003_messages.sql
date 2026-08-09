-- 0003_messages.sql — the conversation history, and its search index.
--
-- `conversation_id` is NOT NULL with a foreign key, from message number one.
-- That is the whole point of this migration and it is worth being explicit
-- about why the constraint is in the schema rather than in a service:
--
--   Adjutant scoped conversations by reconstructing them from sender and
--   recipient. Messages appeared in the wrong thread. The fix needed a stable
--   id derived identically on client and server PLUS a backfill migration with
--   an audit log — it was paid for twice, once in the bug and once in the fix.
--
-- A nullable column would let one code path forget, and the forgetting would
-- be invisible until somebody read a thread that had another thread's messages
-- in it. The database refuses instead. The interactive conversation is seeded
-- in 0001 precisely so this constraint can be satisfied by the first insert.

CREATE TABLE messages (
  id              TEXT    NOT NULL PRIMARY KEY,
  conversation_id TEXT    NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  client_id       TEXT,
  role            TEXT    NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  text            TEXT    NOT NULL,
  created_at      TEXT    NOT NULL,
  seq             INTEGER NOT NULL CHECK (seq > 0),

  -- The message sequence is per conversation and never reused. Two messages
  -- claiming one position would desynchronise every cursor built from it.
  UNIQUE (conversation_id, seq)
) STRICT;

-- History is read newest first, always scoped to one conversation.
CREATE INDEX messages_conversation_seq_idx
  ON messages (conversation_id, seq DESC);

-- `client_id` is what makes an optimistic send reconcilable: the client
-- renders a bubble immediately, sends, and swaps in the server's id when the
-- confirmation arrives. It is also what makes a retried send idempotent —
-- the mobile outbox retries by design, and without this a flaky tunnel turns
-- one message into three. Partial, because server-authored messages have none.
CREATE UNIQUE INDEX messages_client_id_idx
  ON messages (conversation_id, client_id)
  WHERE client_id IS NOT NULL;

-- Keyword search over history. External-content FTS5: the index stores only
-- the tokens and points back at `messages` for the text, so the message bodies
-- are not duplicated. That saves space and, more usefully, removes the
-- possibility of the two copies disagreeing.
--
-- FTS5 is compiled into the SQLite that ships with Node 22, so this costs no
-- native dependency.
CREATE VIRTUAL TABLE messages_fts USING fts5(
  text,
  content = 'messages',
  content_rowid = 'rowid',
  tokenize = 'unicode61'
);

-- External content means FTS5 does not see writes to `messages` on its own.
-- These triggers are the entire contract between the two tables; without them
-- the index is simply empty, and an empty index reports "no results" rather
-- than failing, which is the kind of bug that survives for months.
CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts (rowid, text) VALUES (new.rowid, new.text);
END;

CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
END;

CREATE TRIGGER messages_fts_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts (messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO messages_fts (rowid, text) VALUES (new.rowid, new.text);
END;
