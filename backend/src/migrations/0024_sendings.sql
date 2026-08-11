-- 0024_sendings.sql — the things she chose to give him.
--
-- A **sending** is one thing with two parts: the WORDS she wanted to say, and
-- the VIDEO of her saying them. The words always reach the conversation and
-- always carry the notification; the video lives in its own surface, which the
-- app calls "From Syl". The internal noun stays `sending` — one is what the
-- code calls it, the other is what a person reads at the top of a screen.
--
-- ## The words are never contingent on the video
--
-- `words` and `message_id` are NOT NULL and are written in the same statement
-- that creates the row, which is written only after the assistant message
-- exists. Everything about the video — `render_name`, `attachment_id`,
-- `state`, `reason` — is filled in later or never.
--
-- That ordering is not a convention the service is trusted to keep. A row here
-- cannot exist without a message, because `message_id` is NOT NULL with a
-- foreign key; and the columns the video writes cannot reach back and touch
-- the words, because the rewrite trigger below forbids it. So "a failed render
-- cannot swallow what she wanted to say" is a property of the schema.
--
-- It is constraint 4 applied to something new. A late reminder is a nuisance
-- and a vanished one destroys trust; a late video is a disappointment and
-- words that vanished because their decoration did would be the same injury.
--
-- ## The full-quality render is the record
--
-- `render_name` addresses the original mp4 in the studio directory. Nothing in
-- this system opens it for writing. The attachment named by `attachment_id` is
-- a COMPRESSED, DERIVED copy — the original is 12-15 MB against a 10 MB
-- ceiling, and the ceiling is not raised because `routes/attachments.ts`
-- derives its request-body limit from it and raising one inflates the other
-- for every upload in the service. Losing the derived copy costs a re-encode.
-- Losing the record would cost the thing itself.
--
-- ## Nothing can delete a sending, and nothing can rewrite one
--
-- Constraint 6's shape, and stronger. The memory tables refuse deletion with
-- one named exception: the Commander's explicit order, opening an audited
-- authority window (`0020_memory_deletions.sql`). **This table has no
-- exception at all**, and the asymmetry is deliberate. A memory is a belief
-- the system formed about him, and a person must be able to correct what is
-- believed about them. A sending is a thing she gave him. Neither the system
-- nor a cleanup job nor she gets to take one back.
--
-- Three triggers, and the second and third are the ones that are easy to
-- forget: deleting the MESSAGE carrying the words, or the ATTACHMENT holding
-- the video, would gut a sending without touching the `sendings` row at all.
-- Both are refused too. `0015_attachments.sql` says a future hard-delete of a
-- message is "a retention question with a scheduled answer" — this is the
-- answer for the messages that are half of a sending: there is none.

CREATE TABLE sendings (
  id            TEXT NOT NULL PRIMARY KEY,

  -- What she wanted to say. Never empty, never rewritten, never removed.
  words         TEXT NOT NULL CHECK (length(trim(words)) > 0),

  -- Why she made it. Required, as on every other thing she makes: the reason
  -- travels with the thing, or he cannot tell a good one from a wrong one and
  -- neither can she. It is also what makes "show me the one about Ela"
  -- answerable months later.
  because       TEXT NOT NULL CHECK (length(trim(because)) > 0),

  -- The assistant message carrying `words`. NOT NULL: a sending whose words
  -- never reached chat is not a sending, it is a video nobody was told about.
  --
  -- No ON DELETE clause, so the default NO ACTION stands and the FK refuses to
  -- let the message go. The trigger below says the same thing in a sentence a
  -- reader gets to see; both are here because the FK is only enforced while
  -- `PRAGMA foreign_keys` is ON, and a trigger is enforced always.
  message_id    TEXT NOT NULL REFERENCES messages (id),

  -- The full-quality render this came from — the record. NULL when she sent
  -- words with no render named, which is a real thing to want.
  render_name   TEXT CHECK (render_name IS NULL OR length(trim(render_name)) > 0),

  -- The compressed, playable copy, once there is one. NULL until `ready`.
  attachment_id TEXT REFERENCES attachments (id),

  -- Where the VIDEO got to. It says nothing about the words, which were
  -- delivered before this column had any value at all.
  state         TEXT NOT NULL CHECK (state IN ('pending', 'ready', 'failed')),

  -- Why there is no video, when there is none. A sentence, never a code.
  reason        TEXT,

  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,

  -- `ready` means there is something to play; `failed` means there is a reason
  -- and there is not. Neither is expressible half-done.
  --
  -- A table constraint rather than a column one, because it spans three
  -- columns — and therefore it has to come after every column definition.
  -- SQLite's parser gives no help here: a table CHECK written in the middle of
  -- the column list fails with `near "created_at": syntax error`, naming the
  -- innocent column that follows it.
  CHECK (
    (state = 'ready'   AND attachment_id IS NOT NULL)
    OR (state = 'failed'  AND reason IS NOT NULL AND attachment_id IS NULL)
    OR (state = 'pending' AND attachment_id IS NULL)
  )
) STRICT;

-- The surface reads "everything she has sent, newest first" and nothing else.
CREATE INDEX sendings_created_at_idx ON sendings (created_at DESC, id DESC);

-- "Which sending carried this message" and "which sending owns this video" —
-- both asked by the guard triggers below on every message and attachment
-- delete, so both want to be an index lookup rather than a scan.
CREATE UNIQUE INDEX sendings_message_idx ON sendings (message_id);
CREATE UNIQUE INDEX sendings_attachment_idx
  ON sendings (attachment_id) WHERE attachment_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- A sending is never deleted. No exception, named or otherwise.
-- ---------------------------------------------------------------------------

CREATE TRIGGER sendings_never_deleted
BEFORE DELETE ON sendings
BEGIN
  SELECT RAISE(
    ABORT,
    'a sending is never deleted: it is a thing she gave him, and neither a cleanup job nor she gets to take one back'
  );
END;

-- The only legal writes are filling in what was not known when the row was
-- made. The words, the reason she made it, the message that carried them and
-- the moment it happened are settled at creation.
--
-- `render_name` is included once it is set: a sending that could be re-pointed
-- at a different render is a sending whose record can be swapped, which is the
-- same injury as an edit. `attachment_id` likewise — a video may arrive, but
-- it may not be replaced by another.
CREATE TRIGGER sendings_never_rewritten
BEFORE UPDATE ON sendings
WHEN OLD.id <> NEW.id
  OR OLD.words <> NEW.words
  OR OLD.because <> NEW.because
  OR OLD.message_id <> NEW.message_id
  OR OLD.created_at <> NEW.created_at
  OR (OLD.render_name IS NOT NULL AND OLD.render_name IS NOT NEW.render_name)
  OR (OLD.attachment_id IS NOT NULL AND OLD.attachment_id IS NOT NEW.attachment_id)
BEGIN
  SELECT RAISE(
    ABORT,
    'a sending is never rewritten: only the video it was still waiting for may be filled in'
  );
END;

-- The words, guarded where they actually live. Deleting the message would
-- leave a sending pointing at nothing and take her sentence out of his
-- history, which is the same loss as deleting the sending by a different door.
CREATE TRIGGER messages_carrying_a_sending_never_deleted
BEFORE DELETE ON messages
WHEN EXISTS (SELECT 1 FROM sendings WHERE message_id = OLD.id)
BEGIN
  SELECT RAISE(
    ABORT,
    'this message carries the words of a sending, and a sending is never deleted'
  );
END;

-- The video, guarded the same way. `0015_attachments.sql` leaves an
-- attachment's row and blob alone when a message goes, on the grounds that
-- orphaned bytes are a retention question — this is the case where the bytes
-- are not orphanable, because a row in `sendings` is still naming them.
CREATE TRIGGER attachments_of_a_sending_never_deleted
BEFORE DELETE ON attachments
WHEN EXISTS (SELECT 1 FROM sendings WHERE attachment_id = OLD.id)
BEGIN
  SELECT RAISE(
    ABORT,
    'this attachment is the video of a sending, and a sending is never deleted'
  );
END;

-- ---------------------------------------------------------------------------
-- `sending` joins the sync feed.
--
-- ## Why it is on the feed when `attachment` is not
--
-- `0015` kept attachments off it, and was right to: a device wants an
-- attachment exactly when it wants the message carrying it, and
-- `Message.attachments` is served inline, so a second row would describe the
-- same change twice. A sending is the opposite case. It has its own surface,
-- its own list, and — this is the part that decides it — **its own lifecycle
-- after the message is written.** The video lands minutes later. Nothing about
-- the message changes when it does, so without a `sending` row on the feed a
-- phone that had already synced the words would never learn the video arrived.
--
-- ## Why this is a rebuild, and why there is no ALTER TABLE
--
-- SQLite cannot widen a CHECK in place, so `0016_agent_scope.sql`'s twelve-step
-- rebuild is the precedent. It does not transfer here unchanged, and the
-- difference is a trap worth naming: **0016 could rename because nothing
-- referenced `api_keys`. Thirty triggers reference `sync_log`.**
--
-- `ALTER TABLE ... RENAME TO` reparses the whole schema, and with a dropped
-- `sync_log` those thirty triggers no longer resolve, so the rename fails with
-- `error in trigger sync_conversations_ai: no such table: main.sync_log`.
-- Verified against node:sqlite 3.51.3 before this file was written, because
-- the alternative was discovering it on the Commander's machine at boot.
--
-- So there is no rename. The rows are parked in a carrier table, the original
-- is dropped, and the table is recreated UNDER ITS OWN NAME with the widened
-- CHECK. No `ALTER TABLE` means no reparse, and the thirty triggers — which
-- resolve `sync_log` by name at run time — are untouched throughout.
--
-- ## The sequence survives
--
-- `seq` is the cursor every paired device holds, and a cursor that moves
-- backwards re-delivers history while a cursor that jumps forward loses rows
-- silently. The copy carries `seq` explicitly rather than letting AUTOINCREMENT
-- reassign, and inserting explicit values leaves `sqlite_sequence` at the same
-- high-water mark, so the next row allocated is the next number. Confirmed in
-- the same probe.
-- ---------------------------------------------------------------------------

CREATE TABLE sync_log_carry (
  seq  INTEGER NOT NULL PRIMARY KEY,
  type TEXT NOT NULL,
  id   TEXT NOT NULL,
  at   TEXT NOT NULL
) STRICT;

INSERT INTO sync_log_carry (seq, type, id, at)
  SELECT seq, type, id, at FROM sync_log;

DROP TABLE sync_log;

CREATE TABLE sync_log (
  seq  INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,

  type TEXT NOT NULL CHECK (
         type IN (
           'conversation', 'message', 'reminder', 'todo', 'goal',
           'device', 'delivery', 'job', 'run', 'sending'
         )
       ),
  id   TEXT NOT NULL,

  at   TEXT NOT NULL
) STRICT;

INSERT INTO sync_log (seq, type, id, at)
  SELECT seq, type, id, at FROM sync_log_carry;

DROP TABLE sync_log_carry;

-- Recreated exactly as `0010_sync_log.sql` spelled it. `DROP TABLE` took it.
CREATE INDEX sync_log_type_idx ON sync_log (type, seq);

-- ---------------------------------------------------------------------------
-- The triggers, in the shape 0010 established.
--
-- Triggers rather than calls in the service layer, for 0010's reason: a store
-- method added next year cannot forget to log. `updated_at` is the row's own
-- newest instant, written by the service's injected clock — never SQLite's.
--
-- There is no `_ad`. Every other resource has one because `op: delete` is a
-- shape the feed supports; a sending cannot be deleted, so a delete trigger
-- here would be dead code claiming a reachable state.
-- ---------------------------------------------------------------------------

CREATE TRIGGER sync_sendings_ai AFTER INSERT ON sendings BEGIN
  INSERT INTO sync_log (type, id, at) VALUES ('sending', NEW.id, NEW.updated_at);
END;
CREATE TRIGGER sync_sendings_au AFTER UPDATE ON sendings BEGIN
  INSERT INTO sync_log (type, id, at) VALUES ('sending', NEW.id, NEW.updated_at);
END;
