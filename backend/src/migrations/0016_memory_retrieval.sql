-- 0014_memory_retrieval.sql — the keyword half of hybrid retrieval, and the
-- trust that ranking multiplies by. `syl-005.2.2` and `syl-005.2.3`.
--
-- `0012_memory_core.sql` built the graph and decided the partition key. This
-- file adds the two things retrieval needs on top of it and nothing else:
--
--   1. an FTS5 index over node text, maintained by TRIGGERS;
--   2. `memory_nodes.trust`, plus the ledger that records every move it makes.
--
-- The VECTOR table is deliberately absent. It is a `vec0` virtual table and
-- `vec0` arrives with the sqlite-vec extension, which is loaded by
-- `backend/src/memory/store.ts` at open time and is not available to a
-- migration. Its DDL is owned by `vectorTableDdl()` in `memory/schema.ts` — the
-- partition key decision made in `0012` reaches the vector table through that
-- function, and through no other route. See §1 below for what that costs.
--
--
-- ## 1. Three indexes over the same nodes, kept in step by three DIFFERENT
-- ##    mechanisms, because they are not equally capable
--
--   | index          | partitioning              | kept in step by         |
--   | -------------- | ------------------------- | ----------------------- |
--   | `memory_nodes` | `(tier, kind)` B-tree     | it IS the truth         |
--   | FTS5           | none — so: hot rows only  | TRIGGERS, this file     |
--   | `vec0`         | `(tier, kind)` native     | application code + audit|
--
-- **FTS5 has no partition key.** There is no keyword equivalent of
-- `tier text partition key`; a MATCH reads the whole index and any tier
-- predicate is a post-filter over rows already read — exactly the 121ms case
-- `0012` §1 rejected. So the partitioning is expressed the one way FTS5 can
-- express it: **the index holds hot rows and only hot rows.** Demotion deletes
-- from it, promotion re-inserts. That keeps "demotion and partitioning are the
-- same mechanism" true here too, and it means a cold node is not keyword
-- searchable — which is correct, because keyword search is a SCAN. A cold node
-- stays reachable by identity (`getNode`, `nodesForSubject`, `findEdge`) and by
-- an explicit `listNodes({ tier: 'cold' })`.
--
-- **`vec0` DOES have a partition key**, so the vector table holds every tier
-- and prunes natively. The asymmetry in the table above is not an oversight; it
-- is each engine used to the limit of what it offers.
--
-- **Only FTS5 can be maintained by a trigger.** `label` and `body` are already
-- in the row, so SQLite can derive the index entry itself, inside the writing
-- transaction, with no way for application code to forget. An EMBEDDING is not
-- derivable in SQL — it costs a model call — so the vector table cannot be
-- trigger-maintained and is written by `MemoryStore` instead. That is a real
-- weakening, and `MemoryStore.reconcile()` exists because of it: it names every
-- node with no vector, every vector with no node, and every vector sitting in a
-- partition its node has left.
--
--
--
-- ## 4. A superseded node must leave the RANKED path, and three things make it
--
-- `syl-005.3.3` moves a node hot -> cold when a newer belief supersedes it. If
-- ranked search still returns it, Syl serves what the Commander believed in
-- March as though it were current — the exact failure the supersession ledger
-- exists to prevent, arriving through the search index instead. Nothing fails,
-- nothing logs, and the ledger's whole mechanism is wasted silently.
--
-- The rule mirrors how `0012` treats edges: **superseded leaves the ranked
-- path and stays reachable by identity.** Three mechanisms, deliberately
-- overlapping, because each covers a hole the others leave:
--
--   1. **FTS5** — the triggers above already do it. `AFTER UPDATE OF tier,
--      label, body` fires on a tier-only update (the `OF` list is the columns
--      that may appear in the SET clause, not a requirement that all of them
--      do), and the conditional re-insert drops any node that is no longer hot.
--      Structural, transactional, nothing to call.
--   2. **The vector table** — the KNN prunes on the `tier` partition key, and
--      `MemoryStore.searchVector` then CONFIRMS each hit against its node's
--      real tier. That confirmation is the guarantee: a vector left behind in
--      the hot partition by a tier change nobody repaired is still never
--      returned. Pruning is for cost; verification is for correctness.
--   3. **This queue** — the confirmation makes a stale vector harmless, not
--      absent, and a demoted node's vector must actually move or it will be
--      missing from the cold partition when someone legitimately searches it.
--      The trigger below records every tier or kind change, so the repair is
--      owed by the store rather than remembered by a caller.
--
-- The order matters: 2 alone would under-return, 3 alone would leave a window
-- between the tier change and the drain in which a superseded belief is served.
-- Together there is no such window.
--
--
-- ## 2. Why the triggers key on `node_id` and not on `rowid`
--
-- The obvious FTS5 pattern mirrors `rowid` between the content table and the
-- index, and it is a trap here. `memory_nodes` has a TEXT primary key, so its
-- rowid is IMPLICIT — and SQLite's documentation is explicit that **`VACUUM`
-- may renumber the rowids of any table without an INTEGER PRIMARY KEY.** One
-- maintenance command would silently point every index entry at a different
-- memory: no error, no corruption SQLite can see, just wrong search results
-- forever.
--
-- Keying on `node_id` costs a scan of the FTS index per delete, because an
-- UNINDEXED column has no index of its own. That is the right trade. Node
-- deletes do not happen at all today — `MemoryGraph` has no `deleteNode` — and
-- tier moves are a handful a night, against a failure mode that is invisible
-- until someone reads a memory that is not the one they searched for.
--
--
-- ## 3. Trust is a column on the node, and every move it makes is written down
--
-- `final = relevance x trust x decay(age)`. Trust is the term the Commander
-- controls: it rises a little when a surfaced memory helped and falls twice as
-- far, in log space, when it did not. The law lives in `memory/retrieve.ts`;
-- this file only holds the value and its bounds.
--
-- The bounds are `(0, 1]`, the same interval and the same argument as `weight`
-- and `confidence` in `0012`: a stored zero would multiply the final score to
-- zero permanently, and an assistant that can never re-earn trust in a memory
-- has pruned it while claiming otherwise.
--
-- **`trust` is deliberately in NO index, and that is a decision rather than an
-- omission.** The tempting move is to fold it into `memory_nodes_scan_idx`,
-- which already leads with the partition key — but nothing ever filters or
-- orders by trust in SQL. Retrieval selects candidates from FTS5 and from
-- `vec0`, and trust is then read per candidate by a point lookup on the primary
-- key and multiplied in. An index would be maintained on every piece of
-- feedback and read by nothing. If a future query ever does want "hot nodes
-- Syl is least sure of", the index it wants is `(tier, trust)` — `tier` still
-- leading, per `0012` §2 — and it should be added then, with that query.
--
-- The column is `REAL NOT NULL DEFAULT 0.8` because `memory_nodes` is STRICT: a
-- STRICT table admits only the concrete types, and `ALTER TABLE ... ADD COLUMN`
-- on a non-empty table needs a constant default that satisfies the column's own
-- CHECK. 0.8 does.
--
-- `memory_feedback` is an append-only ledger, and it is not bookkeeping. `0012`
-- makes `reasoning` mandatory on an inferred edge because an inference nobody
-- can audit is a rumour; a trust score nobody can explain is the same thing one
-- layer up. "Why is this memory ranked last?" has to be answerable, and the
-- answer is a list of rows. It carries `trust_before` AND `trust_after` so the
-- history stays readable even after the law's constants change.


-- The keyword index. Hot rows only — see §1.
--
-- `node_id` is UNINDEXED: it is carried so a hit identifies a node, and
-- indexing it would tokenise `syl:memory_node:<uuid>` into `syl`, `memory`,
-- `node` and hex fragments that a real query could collide with.
--
-- `remove_diacritics 2` is unicode61's corrected form; version 1 mishandles
-- codepoints that need more than one byte in UTF-8.
CREATE VIRTUAL TABLE memory_nodes_fts USING fts5 (
  node_id UNINDEXED,
  label,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);


-- A new node is always hot (`MemoryGraph.addNode` has no tier input), so this
-- guard is belt and braces rather than a live branch. It is here so the three
-- triggers state the same rule and none of them relies on another's behaviour.
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


-- `OF tier, label, body` and not a bare `AFTER UPDATE`: trust moves on every
-- piece of feedback, and re-tokenising a node's whole body because a number
-- next to it changed would make the ledger expensive for no reason.
--
-- Delete-then-conditionally-insert covers all four transitions in one body:
-- hot->hot re-indexes the new text, hot->cold removes it, cold->hot adds it,
-- cold->cold is two no-ops.
CREATE TRIGGER memory_nodes_fts_au AFTER UPDATE OF tier, label, body ON memory_nodes
BEGIN
  DELETE FROM memory_nodes_fts WHERE node_id = OLD.id;
  INSERT INTO memory_nodes_fts (node_id, label, body)
  SELECT NEW.id, NEW.label, coalesce(NEW.body, '')
  WHERE NEW.tier = 'hot';
END;


-- Backfill, so this migration is correct on a database that already holds
-- nodes rather than only on an empty one. `0012` shipped today and nothing has
-- written to it yet, which is exactly when a missing backfill is invisible.
INSERT INTO memory_nodes_fts (node_id, label, body)
SELECT id, label, coalesce(body, '') FROM memory_nodes WHERE tier = 'hot';


-- Nodes whose VECTOR is in a partition their node has left. See §4.
--
-- Not a cache and not a log: a work list, drained by
-- `MemoryStore.drainReindexQueue()`. A row here means "the vector table
-- disagrees with the graph about this node", which is a repair somebody has to
-- perform, and this table is what makes it a repair the system knows it owes
-- rather than one a caller has to have remembered.
--
-- `queued_at` uses SQLite's own clock rather than Syl's injected one, because a
-- trigger cannot reach a `Clock`. The format string is chosen to produce
-- exactly the contract's `Instant` — RFC 3339, UTC, millisecond precision,
-- literal `Z` — so a value from here parses with `parseInstant` like every
-- other stamp. It is a queueing timestamp and nothing schedules on it.
CREATE TABLE memory_vector_reindex (
  node_id   TEXT NOT NULL PRIMARY KEY REFERENCES memory_nodes (id),
  queued_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER memory_nodes_vector_reindex_au AFTER UPDATE OF tier, kind ON memory_nodes
WHEN NEW.tier <> OLD.tier OR NEW.kind <> OLD.kind
BEGIN
  INSERT INTO memory_vector_reindex (node_id, queued_at)
  VALUES (NEW.id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (node_id) DO UPDATE SET queued_at = excluded.queued_at;
END;


-- Ranking strength the Commander controls. See §3.
--
-- The default is 0.8 and not 1.0 deliberately: a memory nobody has judged is
-- not maximally trusted, it is merely unjudged, and starting at the ceiling
-- would make "this helped" a no-op for every memory that had never been marked
-- wrong.
ALTER TABLE memory_nodes ADD COLUMN trust REAL NOT NULL DEFAULT 0.8
  CHECK (trust > 0.0 AND trust <= 1.0);


-- Why a trust score is what it is. Append-only; nothing updates or deletes a
-- row here.
--
-- `id INTEGER PRIMARY KEY` rather than the project's `syl:<type>:<uuidv7>`
-- convention, and on purpose: a type-prefixed id exists so a DANGLING
-- REFERENCE is legible in a log line, and nothing references a ledger row.
CREATE TABLE memory_feedback (
  id           INTEGER PRIMARY KEY,

  node_id      TEXT NOT NULL REFERENCES memory_nodes (id),

  -- The Commander's verdict on a memory Syl surfaced. Two values, because a
  -- scale would invite a model to invent gradations he did not express.
  verdict      TEXT NOT NULL CHECK (verdict IN ('helpful', 'unhelpful')),

  -- Both sides of the move, so the ledger stays readable after the law that
  -- produced it has been retuned.
  trust_before REAL NOT NULL CHECK (trust_before > 0.0 AND trust_before <= 1.0),
  trust_after  REAL NOT NULL CHECK (trust_after  > 0.0 AND trust_after  <= 1.0),

  -- What he said, when he said anything. Optional: a thumbs-down with no words
  -- is still a verdict.
  note         TEXT,

  created_at   TEXT NOT NULL
) STRICT;

-- "Show me every judgement on this memory, oldest first." An IDENTITY path: it
-- does not mention tier, because feedback on a memory that has since gone cold
-- is exactly the feedback that explains why it went cold.
CREATE INDEX memory_feedback_node_idx ON memory_feedback (node_id, created_at);
