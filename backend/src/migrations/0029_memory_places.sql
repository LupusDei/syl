-- syl-017.2 — a place is a thing, and a thing it is named ONCE is still a word.
--
-- Syl found this herself, unprompted:
--
--   "Illinois still doesn't exist as a node. The memories say 'the state' and
--    'the old state' and never name it. The single most connective entity in
--    your life is a pronoun."
--
-- Measured against his live graph, and worse than the claim. Illinois appears
-- twice, and both times it is a `fact` with the word inside the label —
-- "Illinois — parents' home and birthplace", "Ruling out Illinois" — with
-- EXACTLY ONE EDGE EACH. Node kinds in use: fact 20, goal 8, person 6,
-- decision 2, event 1, source 1. There is no place.
--
-- The degree of one is not an accident and it is not the extractor being lazy.
-- It is `0012`'s CHECK, one layer down: `place` is not in the vocabulary, so the
-- only kind a place can be filed under is `fact` — and `extract.ts` refuses to
-- let `about` point at a `fact`, deliberately, because a claim about a claim is
-- not what that mechanism is for. **A place could not accumulate edges because
-- nothing was allowed to point at it.** Widening the vocabulary is therefore the
-- whole of the repair at this layer; the judgement of when to USE it lives in
-- `extract.ts` and `extract-apply.ts`.
--
--
-- ## 1. Why this is a table rebuild, and why it does not rename anything
--
-- `memory_nodes.kind` is an inline `CHECK (kind IN (...))`. SQLite has no
-- `ALTER TABLE ... DROP CONSTRAINT`, so widening a closed vocabulary means
-- rebuilding the table. There is no cheaper form of this change.
--
-- The recipe SQLite documents needs `PRAGMA foreign_keys = OFF`, which is a
-- no-op inside a transaction — and `applyMigrations` wraps every migration in
-- `BEGIN IMMEDIATE`, correctly, so that a half-applied schema is impossible.
-- Those two cannot both be had, and the usual escape does not work either:
--
--   **`PRAGMA legacy_alter_table = ON` does NOT stop the rename fixing up
--   foreign keys.** Measured, not assumed — see the table below. With
--   `foreign_keys = ON`, `ALTER TABLE ... RENAME` rewrites every other table's
--   `REFERENCES` clause whatever that pragma says; it governs views and
--   triggers, not this. Six references point at this table (`memory_edges`
--   three times over, `memory_assertions`, `memory_provenance`,
--   `memory_vector_reindex`, `memory_feedback`), and a rename drags all of them
--   onto the scratch table with nothing left to point them back with.
--
-- So this migration **never renames anything**, and the references are never
-- touched at all — they say `memory_nodes` before and after, because the name
-- `memory_nodes` is dropped and re-created rather than moved.
--
--   1. copy the rows into a scratch table
--   2. `DROP TABLE memory_nodes`
--   3. `CREATE TABLE memory_nodes` with the widened vocabulary
--   4. copy the rows back, then drop the scratch table
--
-- Three SQLite behaviours make that safe, and each was verified on 22.23.1
-- (SQLite 3.51.3) before this file was written, because the failure mode of
-- guessing any of them is silent data loss:
--
--   | behaviour | why it matters here |
--   | --- | --- |
--   | `DROP TABLE` runs an implicit `DELETE FROM` under foreign keys, and that delete **fires no triggers** | step 2 does not run `memory_nodes_fts_ad` over every row and empty the search index |
--   | `PRAGMA defer_foreign_keys` holds enforcement to the commit, and **works inside a transaction** where `foreign_keys = OFF` does not | step 2 leaves every edge temporarily parentless, which is fine as long as step 4 puts the parents back |
--   | the deferred counter is decremented by inserts into the **referenced table**, by that name | which is why step 4 copies back into `memory_nodes` rather than renaming a table that already holds the rows. Doing it the other way round commits with `FOREIGN KEY constraint failed`, and that is not a guess either — it was the first attempt |
--
-- The FTS index and the vector-reindex queue are keyed by node id and the ids
-- do not move, so both survive untouched. Only the INDEXES and TRIGGERS have to
-- come back, because they belong to the table and go with it. They are
-- reproduced verbatim from `0012`, `0018`, `0019` and `0021`; `0020` already
-- set the precedent of re-creating a trigger in a later migration.
--
-- `PRAGMA foreign_key_check` is the proof rather than the hope. It is a
-- `SELECT`, so it cannot fail a migration on its own; the assertion that it
-- returns nothing lives in `backend/tests/unit/memory-core-migration.test.ts`.
--
--
-- ## 2. `memory_entity_mentions` — the rule that a place must EARN a node
--
-- The hazard on the other side of the fix, and it is the one that actually
-- costs something: **over-minting.** If every noun becomes a node the graph
-- fills with entities nobody asked about, and the working-memory projection —
-- 4,000 bytes, least salient falls off the end — does not merely waste the
-- space. It EVICTS. That is the same family as the measurement in
-- `supersede.ts` §1, where near-duplicate merging takes accuracy from 0.82 to
-- 0.62: a cleanup that looks like enrichment.
--
-- Places are where that hazard actually lives. A person, a goal, a decision and
-- an event are named because he is doing something about them. A place is named
-- incidentally — every fact has a where — so for places, and only for places,
-- being mentioned is not evidence of mattering.
--
-- So the rule, and it is a rule about EXCHANGES rather than about sentences:
--
--   **A place is not minted the first time it is named. Its mention is
--   recorded here. It becomes a node the second time a DIFFERENT exchange names
--   it, and when it does, every recorded mention is replayed — so it arrives
--   with the degree it earned, not the degree of the exchange that promoted
--   it.**
--
-- The unit is the exchange and not the fact on purpose. "Three facts point at
-- it" can all come out of one telling, and then the number measures how the
-- extraction turn phrased itself rather than anything about his life. A second,
-- separate exchange is the first evidence that came from the world.
--
-- Nothing is discarded to make this work, which is what lets the threshold be
-- low. A place heard once keeps its row, his words, and the claim that pointed
-- at it; if it never returns it costs a row here and never a byte of the digest.
-- That is CLAUDE.md constraint 6's instinct one table over: **the deferral is a
-- demotion, not a refusal.**
--
--
-- ## 3. Why the mention is not a node in the cold tier
--
-- The obvious alternative, and it was the first design: mint the place `cold`,
-- promote it on recurrence. It reads beautifully against constraint 6 and it is
-- wrong twice.
--
--   * `MemoryGraph.addNode` has no `tier` input, on purpose — "a colder
--     partition is only ever reached by a MOVE". A pending node born cold would
--     make that sentence false for every reader after us.
--   * `cold` already MEANS something: retired by supersession or by decay. A
--     node that was never hot is not retired, and `extract-apply.ts` refuses to
--     reuse a cold node precisely so a correction is not resurrected. One tier
--     value carrying "he changed his mind about this" and "we have only heard
--     this once" is how that refusal starts silently resurrecting corrections.
--
-- A pending mention is not a memory. It is the evidence that might become one,
-- and evidence belongs beside the ledger that records the exchange it came from.


-- Enforcement moves to the commit. Every edge, assertion and provenance row is
-- parentless between the drop below and the copy back; deferring is what makes
-- that a window rather than a failure, and the commit is what makes it a window
-- that must have closed.
PRAGMA defer_foreign_keys = ON;


-- Step 1. The rows, somewhere that is not about to be dropped. No constraints
-- on purpose: this holds values that have ALREADY satisfied `0012`'s checks,
-- and re-stating them here would be a second copy of the definition to keep in
-- step with the real one.
CREATE TABLE memory_nodes_rebuild (
  id          TEXT NOT NULL PRIMARY KEY,
  tier        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  label       TEXT NOT NULL,
  body        TEXT,
  subject_id  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  trust       REAL NOT NULL
) STRICT;

-- Columns named rather than `SELECT *`: a `*` here would silently reorder if
-- the two definitions ever drift, and every value in this table is positional
-- to a CHECK on the way back in.
INSERT INTO memory_nodes_rebuild
  (id, tier, kind, label, body, subject_id, created_at, updated_at, trust)
SELECT
  id, tier, kind, label, body, subject_id, created_at, updated_at, trust
FROM memory_nodes;


-- Step 2. The name goes, and comes back in step 3 attached to a wider
-- vocabulary. Nothing that references `memory_nodes` is edited, because nothing
-- was renamed.
DROP TABLE memory_nodes;


-- Step 3. `0012`'s table, with `trust` from `0018` folded in where `ALTER TABLE
-- ... ADD COLUMN` put it, and one name added to the kind vocabulary. Every
-- other CHECK, default and type is reproduced unchanged — this is a widening
-- and nothing else, and a diff against `0012` should show exactly one word.
CREATE TABLE memory_nodes (
  id          TEXT NOT NULL PRIMARY KEY,

  tier        TEXT NOT NULL DEFAULT 'hot'
              CHECK (tier IN ('hot', 'cold', 'suppressed')),

  -- `place` joins the vocabulary. It is an ENTITY kind — see
  -- `ENTITY_NODE_KINDS` in `memory/schema.ts` — which is what lets a claim hang
  -- off it by `about`, which is the entire difference between Illinois with a
  -- degree of one and Illinois as a hub.
  kind        TEXT NOT NULL
              CHECK (kind IN ('fact', 'memory', 'person', 'source', 'event',
                              'goal', 'decision', 'place')),

  label       TEXT NOT NULL,
  body        TEXT,
  subject_id  TEXT,

  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,

  trust       REAL NOT NULL DEFAULT 0.8
              CHECK (trust > 0.0 AND trust <= 1.0),

  CHECK (id GLOB 'syl:memory_node:*' AND length(id) = 52),
  CHECK (length(trim(label, char(32, 9, 10, 13))) > 0),
  CHECK (subject_id IS NULL OR subject_id GLOB 'syl:*:*'),
  CHECK (updated_at >= created_at)
) STRICT;


-- Step 4. The rows come back INTO `memory_nodes` BY NAME, and the order of
-- these two statements is the whole reason the commit succeeds: the deferred
-- foreign-key counter is decremented by inserts into the table the references
-- name. Copying into a scratch table and renaming it afterwards puts the same
-- rows in the same place and still fails at the commit.
INSERT INTO memory_nodes
  (id, tier, kind, label, body, subject_id, created_at, updated_at, trust)
SELECT
  id, tier, kind, label, body, subject_id, created_at, updated_at, trust
FROM memory_nodes_rebuild;

DROP TABLE memory_nodes_rebuild;


-- The four indexes, back exactly as `0012`, `0019` and `0021` left them.
CREATE INDEX memory_nodes_scan_idx ON memory_nodes (tier, kind, updated_at DESC);

CREATE INDEX memory_nodes_subject_idx ON memory_nodes (subject_id)
  WHERE subject_id IS NOT NULL;

-- The WHERE clause is the whole of this index. `0019` is emphatic about it:
-- partial on the kinds a PROJECTOR mints and no wider, because many memories
-- about one goal is the normal, intended state of the graph and a unique index
-- over those kinds would forbid the graph from knowing more than one thing
-- about anything. `place` is deliberately NOT added — a place is extracted, not
-- projected, and it carries no `subject_id` at all.
CREATE UNIQUE INDEX memory_nodes_handle_idx
  ON memory_nodes (subject_id, kind)
  WHERE subject_id IS NOT NULL AND kind IN ('goal', 'source');

CREATE INDEX memory_nodes_label_idx ON memory_nodes (kind, label);


-- The four triggers, back exactly as `0018` left them. A trigger belongs to its
-- table and went with the drop; the FTS rows and the reindex queue are keyed by
-- node id and did not move, so there is nothing to backfill.
CREATE TRIGGER memory_nodes_fts_ai AFTER INSERT ON memory_nodes
WHEN NEW.tier = 'hot'
BEGIN
  INSERT INTO memory_nodes_fts (node_id, label, body)
  VALUES (NEW.id, NEW.label, coalesce(NEW.body, ''));
END;

CREATE TRIGGER memory_nodes_fts_ad AFTER DELETE ON memory_nodes
BEGIN
  DELETE FROM memory_nodes_fts WHERE node_id = OLD.id;
END;

CREATE TRIGGER memory_nodes_fts_au AFTER UPDATE OF tier, label, body ON memory_nodes
BEGIN
  DELETE FROM memory_nodes_fts WHERE node_id = OLD.id;
  INSERT INTO memory_nodes_fts (node_id, label, body)
  SELECT NEW.id, NEW.label, coalesce(NEW.body, '')
  WHERE NEW.tier = 'hot';
END;

CREATE TRIGGER memory_nodes_vector_reindex_au AFTER UPDATE OF tier, kind ON memory_nodes
WHEN NEW.tier <> OLD.tier OR NEW.kind <> OLD.kind
BEGIN
  INSERT INTO memory_vector_reindex (node_id, queued_at)
  VALUES (NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (node_id) DO UPDATE SET queued_at = excluded.queued_at;
END;


-- Places heard once, and the claims that were waiting on them. See §2.
CREATE TABLE memory_entity_mentions (
  -- Which entity kind was named. Constrained to the kinds that name a THING,
  -- because a mention is deferred EVIDENCE OF AN ENTITY; there is nothing here
  -- for a `fact` to be.
  kind        TEXT NOT NULL
              CHECK (kind IN ('person', 'event', 'goal', 'decision', 'place')),

  -- The canonical label, written by `canonicalLabel` on the way in and compared
  -- `COLLATE NOCASE` on the way out — the same pair `FACT_IDENTITY_SQL` uses,
  -- for the same reason. Byte equality made `Family compound` and
  -- `Family Compound` two nodes once already.
  label       TEXT NOT NULL,

  -- The exchange that named it. This is the RECURRENCE UNIT: the count that
  -- decides promotion is `count(DISTINCT digest)`, so one exchange naming a
  -- place five times is one piece of evidence, which is what it is.
  digest      TEXT NOT NULL REFERENCES memory_extractions (digest) ON DELETE CASCADE,

  -- The claim that was waiting on it: the `fact` node whose `about` pointed
  -- here. NOT NULL, and that is a rule rather than a convenience — a place
  -- nothing in its own reply is about is a word in a sentence, so it is never
  -- recorded at all. It also means every row here hangs off a node, so the
  -- Commander's "forget this" reaches the residue by CASCADE rather than by
  -- somebody remembering this table exists.
  from_node   TEXT NOT NULL REFERENCES memory_nodes (id) ON DELETE CASCADE,

  -- What the mention would have become. Held so a promotion three exchanges
  -- later can replay the provenance it was owed rather than inventing it: the
  -- message, HIS WORDS copied from it, and the step the turn declared. Same
  -- three columns as `memory_provenance`, same derived/declared split.
  said_in     TEXT NOT NULL,
  quote       TEXT NOT NULL,
  why         TEXT NOT NULL,

  -- The body the extraction proposed for the entity, so the node it becomes
  -- arrives with one instead of being a bare name.
  body        TEXT NOT NULL,

  -- The node this became, once it earned one. NULL while it is still pending.
  -- Set on every row for that entity at the moment of promotion, so this table
  -- reads as the history of how a hub was assembled rather than as a queue that
  -- forgets what it drained.
  node_id     TEXT REFERENCES memory_nodes (id) ON DELETE CASCADE,
  promoted_at TEXT,

  created_at  TEXT NOT NULL,

  -- One row per (entity, exchange, claim). The same claim cannot name the same
  -- place twice in one exchange, and a replay of an exchange is refused a layer
  -- up by `memory_extractions`; this is the guarantee rather than the hope.
  PRIMARY KEY (kind, label, digest, from_node),

  CHECK (length(digest) = 64),
  CHECK (said_in GLOB 'syl:message:*'),
  CHECK (from_node GLOB 'syl:memory_node:*' AND length(from_node) = 52),
  CHECK (node_id IS NULL OR (node_id GLOB 'syl:memory_node:*' AND length(node_id) = 52)),
  -- Promoted is both columns or neither. A `node_id` with no stamp is a row
  -- that cannot say when it stopped being pending.
  CHECK ((node_id IS NULL) = (promoted_at IS NULL)),
  CHECK (length(trim(label, char(32, 9, 10, 13))) > 0),
  CHECK (length(trim(quote, char(32, 9, 10, 13))) > 0),
  CHECK (length(trim(why, char(32, 9, 10, 13))) > 0),
  CHECK (length(trim(body, char(32, 9, 10, 13))) > 0)
) STRICT;


-- "How many exchanges have named this place?" — the promotion decision, once
-- per gated candidate. Leading on `kind` so the seek prunes to one kind and the
-- NOCASE comparison filters what is left; `memory_nodes_label_idx` already
-- makes the same trade for the same reason.
CREATE INDEX memory_entity_mentions_label_idx
  ON memory_entity_mentions (kind, label);

-- "What did this exchange defer?" — the audit direction, and the one a
-- deletion pass over an extraction needs.
CREATE INDEX memory_entity_mentions_digest_idx
  ON memory_entity_mentions (digest);

-- "Which mentions are still waiting?" — partial, because most rows will have
-- been promoted or will never be looked at again.
CREATE INDEX memory_entity_mentions_pending_idx
  ON memory_entity_mentions (kind, label)
  WHERE node_id IS NULL;
