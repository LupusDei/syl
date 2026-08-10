-- 0021_extraction_ledger.sql — what has already been extracted, and the index
-- that lets a fact be recognised rather than duplicated.
--
-- ## NUMBERING, FOR WHOEVER MERGES THIS
--
-- This was assigned 0019 and is numbered 0018, deliberately. `readMigrations`
-- requires a CONTIGUOUS sequence and fails the whole suite on a gap, so a file
-- numbered 0019 on a branch whose highest other migration is 0017 makes every
-- database-backed test in the workspace red for a reason that has nothing to
-- do with the code. If the deletion epic's own 0018 lands too, the collision is
-- LOUD — two files claiming version 18 fail `readMigrations` immediately — and
-- the fix is to rename one of them, exactly as `8c11f89` and `fdecafa` already
-- did for the memory migrations. A loud rename beats a silently red branch, and
-- both beat a placeholder file whose checksum would be recorded on a real
-- database and then have to be un-recorded.
--
-- ## The problem this table solves
--
-- Extraction is a Claude turn, and a turn is the least reliable step in the
-- system: it can time out, it can be retried by a job runner, and the same
-- exchange can reach it twice after a restart. Applying it twice must write
-- nothing the second time — not "roughly nothing", nothing. Without a record of
-- what was applied, the only available answer is "look at the graph and guess",
-- and a guess that is wrong in the permissive direction fills the graph with
-- the same fact five times over.
--
-- So the unit of idempotence is written down: the **digest of the transcript
-- that was extracted from**, as its own primary key. Re-running over the same
-- exchange finds the row and stops before it touches the graph at all.
--
-- The digest and not `(conversation_id, message_id)`, because the transcript is
-- what the model actually saw. Two different windows over one conversation are
-- two different extractions and both are legitimate; the same window twice is
-- one, whatever the surrounding message ids happen to be.
--
-- ## Why the counts are here
--
-- CLAUDE.md constraint 7: a memory system that cannot be inspected cannot be
-- tuned. "How often does she decline to file anything?" is the single most
-- useful question about extraction — the design says most exchanges contain
-- nothing worth keeping, and this table is the only place that claim can be
-- checked against what actually happened. A declined extraction therefore
-- writes a row with `facts = 0` rather than no row at all: "we looked and there
-- was nothing" and "we never looked" are different states, and only one of them
-- is a bug.
--
-- ## Not synced
--
-- Deliberately absent from `sync_log`'s type CHECK, and no sync trigger. This
-- is telemetry about Syl's own filing, not the Commander's data, and it changes
-- on every exchange.

CREATE TABLE memory_extractions (
  -- SHA-256 of the exact transcript text the extraction turn was shown. The
  -- unit of idempotence; see the header.
  digest          TEXT    NOT NULL PRIMARY KEY,

  -- The conversation the transcript came from, `syl:conversation:<uuid>`. Also
  -- the `subject_id` of the source node every fact hangs off, which is what
  -- makes "forget everything from this conversation" a query rather than a
  -- scan.
  conversation_id TEXT    NOT NULL,

  -- The `source`-kind node that asserted this extraction's edges. Nullable
  -- only in the sense that it never is: a declined extraction still names the
  -- conversation's node, because the source exists whether or not anything was
  -- filed from it.
  source_node     TEXT    NOT NULL,

  -- How many candidate facts the turn returned. Zero is the expected common
  -- case and is not a failure.
  facts           INTEGER NOT NULL,

  -- How many of those became NEW nodes. The difference between this and
  -- `facts` is how much the graph already knew.
  created_nodes   INTEGER NOT NULL,

  created_at      TEXT    NOT NULL,

  CHECK (length(digest) = 64),
  CHECK (conversation_id GLOB 'syl:conversation:*'),
  CHECK (source_node GLOB 'syl:memory_node:*' AND length(source_node) = 52),
  CHECK (facts >= 0),
  CHECK (created_nodes >= 0 AND created_nodes <= facts)
) STRICT;

-- "What has been filed from this conversation, most recently first?" — the
-- admin's audit view, and the query a deletion pass runs first.
CREATE INDEX memory_extractions_conversation_idx
  ON memory_extractions (conversation_id, created_at DESC);


-- The identity lookup extraction needs: "is there already a node for this?"
--
-- **Tier-free on purpose**, and for the same reason `memory_edges_identity_idx`
-- is: this is an IDENTITY LOOKUP, not a scan. Leading with `tier` would make a
-- superseded node invisible to it, so every re-statement of a fact the graph
-- had already cooled would mint a second node beside the first — the graph
-- would grow a duplicate for every correction, and nothing would report it.
--
-- NOT unique. Two nodes may legitimately share a kind and a label: a
-- superseded one and its replacement are exactly that pair, and forbidding it
-- would make supersession itself impossible. Uniqueness where it belongs is
-- `memory_nodes_handle_idx`, which covers the projected kinds only.
CREATE INDEX memory_nodes_label_idx ON memory_nodes (kind, label);
