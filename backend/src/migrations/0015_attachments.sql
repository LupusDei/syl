-- 0015_attachments.sql — images and video in the conversation.
--
-- ## Two tables, because an attachment outlives the message it is for
--
-- The obvious schema is a `message_id` column on `attachments`. It is wrong
-- for the send path this exists to serve: `ChatViewModel.send()` writes its
-- local row and starts the upload BEFORE there is a message to attach to, so
-- that a crash mid-upload loses neither the bubble nor the intent. A NOT NULL
-- `message_id` makes that ordering impossible; a nullable one makes "not
-- attached yet" and "attached to nothing, forever" the same value.
--
-- So the join is its own table. An attachment is created unclaimed, and a
-- message claims it. `message_attachments` also gives the ordering column an
-- honest home — the order pictures appear in is a property of the pairing, not
-- of either row.
--
-- ## The blob is on disk; only its NAME is here
--
-- `stored_name` is a bare `<uuid>.<ext>`, never a path. Adjutant stored the
-- absolute path and then had to defend every read against it pointing
-- somewhere else; a name that cannot contain a separator cannot escape the
-- blob directory, so the confinement is a property of the schema rather than
-- of the code that reads it. It also means the directory can be moved —
-- `SYL_ATTACHMENT_DIR`, a restored backup, a different machine — without a
-- migration rewriting every row.
--
-- ## Why there is no `attachment` type in `sync_log`
--
-- An attachment is never interesting on its own: a device wants it exactly
-- when it wants the message that carries it, and `Message.attachments` is
-- served inline. Because the link is written in the SAME transaction as the
-- message insert, the existing `sync_messages_ai` trigger already fires for
-- the row, and `GET /sync` resolves the message fresh — state, not history —
-- so the attachments travel with it. Adding a ninth resource type would put a
-- second row on the feed describing the same change.
--
-- Deleting a message takes its links with it (ON DELETE CASCADE) and leaves
-- the attachment row and its blob alone. That is deliberate: nothing in Syl
-- hard-deletes a message today, and if something ever does, orphaning bytes is
-- a retention question with a scheduled answer, not something to do inside
-- somebody else's DELETE.

CREATE TABLE attachments (
  id          TEXT    NOT NULL PRIMARY KEY,

  kind        TEXT    NOT NULL CHECK (kind IN ('image', 'video')),

  -- The SNIFFED type, never the declared one. The service cross-checks the
  -- two at upload and refuses a disagreement, so this column holds the file's
  -- own answer about itself and there is no second, contradictory answer
  -- stored anywhere.
  mime_type   TEXT    NOT NULL,

  bytes       INTEGER NOT NULL CHECK (bytes > 0),

  -- Layout hints, and the reason a bubble does not jump when the image lands.
  -- Read from the file header for an image; taken from the uploader for a
  -- video, which would otherwise need a demuxer.
  width       INTEGER NOT NULL CHECK (width > 0),
  height      INTEGER NOT NULL CHECK (height > 0),

  -- Video only. NULL for an image, enforced rather than merely intended: a
  -- duration on a screenshot is a code path that ran when it should not have.
  duration_ms INTEGER CHECK (
                (kind = 'video' AND duration_ms IS NOT NULL AND duration_ms >= 0)
                OR (kind = 'image' AND duration_ms IS NULL)
              ),

  -- Lower-case hex of the stored original. The client's cache key.
  sha256      TEXT    NOT NULL CHECK (length(sha256) = 64),

  -- `<uuid>.<ext>`, relative to the blob directory. Never a path — see above.
  stored_name TEXT    NOT NULL UNIQUE CHECK (
                stored_name NOT LIKE '%/%'
                AND stored_name NOT LIKE '%' || char(92) || '%'
                AND stored_name NOT LIKE '%..%'
              ),

  -- The downscaled preview, or NULL when there is none — every video, and any
  -- image the service could not downscale. NULL is the honest value and the
  -- client reads `hasThumbnail` from it; a missing thumbnail must never
  -- silently fall back to the full file, which is how a 60 KB request becomes
  -- a 4 MB one on the connection least able to afford it.
  thumb_name  TEXT    CHECK (
                thumb_name IS NULL
                OR (thumb_name NOT LIKE '%/%'
                    AND thumb_name NOT LIKE '%' || char(92) || '%'
                    AND thumb_name NOT LIKE '%..%')
              ),

  created_at  TEXT    NOT NULL
) STRICT;

-- Retention will want "everything older than N", and the admin wants newest
-- first. Both are this index.
CREATE INDEX attachments_created_at_idx ON attachments (created_at DESC);

CREATE TABLE message_attachments (
  message_id    TEXT    NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  attachment_id TEXT    NOT NULL REFERENCES attachments (id) ON DELETE CASCADE,

  -- Render order, per message. Zero-based.
  position      INTEGER NOT NULL CHECK (position >= 0),

  PRIMARY KEY (message_id, attachment_id)
) STRICT;

-- Reading a page of history joins from the message side, always.
CREATE INDEX message_attachments_message_idx
  ON message_attachments (message_id, position);

-- One attachment belongs to at most one message. Not a stylistic preference:
-- letting two messages share a row makes "delete the message, delete the
-- bytes" unanswerable, and makes an attachment's lifetime depend on a count
-- nobody is keeping. A client that wants the same picture twice uploads it
-- twice; `sha256` is right there to make that cheap to notice.
CREATE UNIQUE INDEX message_attachments_attachment_idx
  ON message_attachments (attachment_id);

-- Two pictures may not claim one position in a message.
CREATE UNIQUE INDEX message_attachments_position_idx
  ON message_attachments (message_id, position);
