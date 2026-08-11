-- 0025_digestion.sql — the record of what digestion did, and the proposals it
-- was not sure enough to apply.
--
-- ## NUMBERING, FOR WHOEVER MERGES THIS
--
-- 0024 is `0024_working_memory_budget.sql` on `agent/fenix`, checked against
-- ORIGIN rather than against this branch before this number was claimed —
-- `readMigrations` enforces a contiguous sequence and hard-fails on a gap, so a
-- file numbered above a missing one takes down every test that opens a
-- database, for a reason its author did not cause. A duplicate is LOUD (the
-- guard reports both filenames); a gap is loud but blames the wrong file. If
-- 0025 has been taken by the time this lands, rename this one.
--
--
-- ## What digestion is, in one line
--
-- The pass that runs after extraction and answers the two questions extraction
-- deliberately does not: WHO IS WHO (`memory_nodes.subject_id`) and WHAT
-- CONNECTS TO WHAT (`memory_edges.relation`, typed, as an INFERRED edge).
--
-- Neither of those needs a table. Identity is a column that already exists;
-- edges are rows in `memory_edges` and their identity — `(source, target,
-- relation)` — is already unique, which is what makes re-running free without
-- any ledger at all. This migration is therefore NOT the mechanism. It is the
-- OBSERVABILITY, and the one place a conclusion can sit without being applied.
--
--
-- ## Why the run log exists (constraint 7, applied one module over)
--
-- CLAUDE.md constraint 7 says every dream session is logged permanently and
-- that observability is a first principle of the memory build, not a later
-- phase: a memory system that cannot be inspected cannot be tuned. Digestion is
-- not the dream, but it is the same kind of thing — a process that writes
-- conclusions nobody asserted — and it runs on EVERY exchange rather than once
-- a night, so it is the one with the greater capacity to fill the graph with
-- noise before anyone notices.
--
-- The questions this table exists to answer, all of which are unanswerable
-- today:
--
--   - How often does digestion write nothing? (It should be most of the time.)
--   - How much of what it writes came from the deterministic reader, and how
--     much from the model turn? If the turn's share is near zero it is not
--     earning its subprocess.
--   - How often is `about` — the escape hatch — being reached for? A quarter is
--     the stated alarm; nothing has ever measured the real number because
--     nothing has ever written a typed relation.
--   - How often does the model turn fail, and does the deterministic half still
--     land when it does?
--
-- Like `memory_extractions`, a run that wrote nothing still writes a row.
-- "We looked and there was nothing to connect" and "we never looked" are
-- different states and only one of them is a bug.
--
--
-- ## Why proposals are stored rather than applied
--
-- An inferred EDGE that turns out to be wrong is survivable by construction: it
-- carries its reasoning, it decays on a timer, it is demoted rather than
-- deleted, and it stays addressable forever (constraint 6). Being wrong costs
-- ranking.
--
-- A wrong IDENTITY is not like that. Merging `"Justin Martin"` with
-- `'Robert C. Martin ("Uncle Bob") — his father'` — two real nodes in the live
-- graph on 2026-08-11, different people, shared surname — collapses two people
-- into one, and no amount of decay makes that less wrong. There is no demotion
-- for a lost distinction; it has to be reconstructed by hand.
--
-- So resolution PROPOSES and only whole-name equality with agreeing evidence
-- applies automatically. Everything else lands here, `open`, waiting for
-- someone to look. A proposal is not memory: it is a question about memory, so
-- it lives in its own table for the same reason the dream log does.
--
--
-- ## Not synced
--
-- Deliberately absent from `sync_log`'s type CHECK, and no sync trigger. This
-- is telemetry about Syl's own reasoning, not the Commander's data, and it
-- changes on every exchange.

CREATE TABLE digestion_runs (
  id              INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,

  -- The conversation the window was drawn after, `syl:conversation:<uuid>`.
  -- Nullable because digestion is not conceptually tied to a conversation —
  -- a scheduled pass over the whole hot region is a legitimate future caller
  -- and would have no conversation to name.
  conversation_id TEXT,

  -- How many nodes were in the window. Zero means the graph had nothing to
  -- look at, which is the correct outcome on a cold start.
  window_nodes    INTEGER NOT NULL,

  -- Connections proposed by the deterministic reader (`entities.ts`), which
  -- reads relationships the extractor already wrote into the label text.
  prose_edges     INTEGER NOT NULL,

  -- Connections proposed by the model turn (`digest.ts`). The difference
  -- between this and `prose_edges` is what the subprocess is buying.
  turn_edges      INTEGER NOT NULL,

  -- What actually landed, and what was already there. `edges_skipped` is the
  -- idempotence signal: on a second pass over an unchanged neighbourhood it
  -- should equal the proposal count and `edges_written` should be zero.
  edges_written   INTEGER NOT NULL,
  edges_skipped   INTEGER NOT NULL,

  -- Identity claims applied automatically, and rows stamped as a result.
  identities_applied INTEGER NOT NULL,
  nodes_resolved     INTEGER NOT NULL,

  -- Rows written to `digestion_proposals` by this run.
  proposals       INTEGER NOT NULL,

  -- The escape-hatch meter. `about_share` is over what this run WROTE, so a
  -- run that wrote nothing reports 0.0 rather than a division by zero.
  about_edges     INTEGER NOT NULL,
  about_share     REAL    NOT NULL,

  -- What became of the model turn. `skipped` is the ordinary case for a window
  -- too small to be worth a subprocess; `refused` means the window carried a
  -- directive aimed at the reader and the turn's whole output was discarded.
  turn_outcome    TEXT    NOT NULL,

  -- Present only when the turn failed, so a miss is legible without a log file.
  turn_error      TEXT,

  created_at      TEXT    NOT NULL,

  CHECK (conversation_id IS NULL OR conversation_id GLOB 'syl:conversation:*'),
  CHECK (window_nodes >= 0),
  CHECK (prose_edges >= 0 AND turn_edges >= 0),
  CHECK (edges_written >= 0 AND edges_skipped >= 0),
  CHECK (identities_applied >= 0 AND nodes_resolved >= 0),
  CHECK (proposals >= 0),
  CHECK (about_edges >= 0 AND about_edges <= edges_written),
  CHECK (about_share >= 0.0 AND about_share <= 1.0),
  CHECK (turn_outcome IN ('ok', 'skipped', 'refused', 'error')),
  CHECK ((turn_error IS NULL) = (turn_outcome IN ('ok', 'skipped')))
) STRICT;

-- "What has digestion done recently?" — the admin's view, newest first.
CREATE INDEX digestion_runs_recent_idx ON digestion_runs (created_at DESC, id DESC);


CREATE TABLE digestion_proposals (
  id          INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,

  -- ON DELETE CASCADE, matching `dream_edge_reasoning`: a proposal is only
  -- meaningful beside the run that made it, and the run log is the thing that
  -- is pruned by age if it is ever pruned at all.
  run_id      INTEGER NOT NULL REFERENCES digestion_runs (id) ON DELETE CASCADE,

  -- `identity` is "these rows are the same thing". `edge` is a connection held
  -- back rather than written — nothing proposes one today, and the column
  -- exists so that when something does it does not need a migration to be
  -- surfaced the same way.
  kind        TEXT    NOT NULL,

  -- The nodes involved, as a JSON array of `syl:memory_node:<uuid>`. JSON
  -- rather than a join table because a proposal is READ WHOLE — the admin
  -- shows it, the Commander accepts or rejects it, and nothing ever queries
  -- "which proposals mention this node" often enough to earn a second table.
  node_ids    TEXT    NOT NULL,

  -- Set for `kind = 'edge'`, NULL for an identity. Validated against the closed
  -- vocabulary in `relations.ts` before it ever gets here.
  relation    TEXT,

  confidence  REAL    NOT NULL,

  -- WHY, mandatory, and for the same reason `memory_edges.reasoning` is
  -- mandatory on an inference: a conclusion nobody can check is a rumour, and
  -- a proposal that cannot say what it noticed cannot be judged by anyone.
  reasoning   TEXT    NOT NULL,

  -- `open` until somebody looks. Applied proposals are NOT deleted — the
  -- record that Syl once wondered whether two people were one is worth keeping,
  -- and it is the only way to tell a resolution that was reviewed from one that
  -- was never contested.
  status      TEXT    NOT NULL DEFAULT 'open',

  created_at  TEXT    NOT NULL,

  CHECK (kind IN ('identity', 'edge')),
  CHECK (json_valid(node_ids) AND json_type(node_ids) = 'array'),
  CHECK (json_array_length(node_ids) >= 2),
  CHECK ((relation IS NULL) = (kind = 'identity')),
  CHECK (confidence > 0.0 AND confidence <= 1.0),
  CHECK (length(trim(reasoning)) > 0),
  CHECK (status IN ('open', 'accepted', 'rejected'))
) STRICT;

-- "What is waiting to be looked at?" — the only query the admin runs, and the
-- one that must not degrade into a scan as the log grows.
CREATE INDEX digestion_proposals_open_idx
  ON digestion_proposals (status, created_at DESC)
  WHERE status = 'open';

CREATE INDEX digestion_proposals_run_idx ON digestion_proposals (run_id);
