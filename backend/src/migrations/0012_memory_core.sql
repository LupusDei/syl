-- 0012_memory_core.sql — the memory graph's nodes, its two species of edge,
-- and the PARTITION KEY that decides what a read costs for the rest of Syl's
-- life. `syl-005.1.1`.
--
-- This file is the keystone of the memory epic. Eight beads build on it, and
-- the one thing here that cannot be changed later without rewriting the table
-- after it holds real history is the partition key. So the reasoning is
-- recorded in full, at the point where somebody would otherwise change it.
--
--
-- ## 1. What a partition key is here, and why it is not a metadata column
--
-- Measured on a hybrid vector/keyword store at 100k rows: filtering candidates
-- by a partition key took 31ms where the same filter expressed as an ordinary
-- metadata column took 121ms. The difference is not constant-factor. A
-- partition key lets the engine skip whole blocks of rows without looking
-- inside them; a metadata column is a predicate evaluated per row that has
-- already been read. Only the first one prunes.
--
-- sqlite-vec spells this literally — `tier text partition key` in a `vec0`
-- table (see `vectorTableDdl` in `backend/src/memory/schema.ts`, which owns
-- that DDL so the decision is made in exactly one place). An ordinary SQLite
-- B-tree has no such keyword, and the equivalent is precise: **the partition
-- key is the leading column of every index a scan uses.** Everything below
-- follows from that one sentence, in both directions.
--
--
-- ## 2. The partition key is `(tier, kind)`, and `tier` leads
--
--   tier ∈ ('hot', 'cold', 'suppressed')
--   kind ∈ the node kinds, or the two edge species
--
-- `tier` is the primary axis and it exists because of CLAUDE.md constraint 6,
-- the Commander's rule: **inferred edges are never deleted, only demoted.**
-- Confidence decays asymptotically toward zero and never arrives, so a dormant
-- edge can always be promoted back — which is exactly right, and which means
-- this table grows monotonically forever.
--
-- Decay fixes RANKING. A dormant edge correctly sorts to the bottom. Decay does
-- not fix COST. If dormant edges sit in the same partition as live ones, every
-- read pays for the entire accumulated history of the graph, and the system
-- gets slower every night it runs, forever — which is the unbounded-cost
-- problem that pruning was proposed to avoid, arriving through the back door.
--
-- The resolution is not to choose between the Commander's semantics and the
-- benchmark. It is to make **demotion and partitioning the same mechanism**:
-- crossing the relevance floor MOVES a row from `hot` to `cold`. A dormant
-- edge then becomes cheap to SKIP rather than merely cheap to rank. It leaves
-- the scan entirely while remaining fully addressable.
--
--     Never forget anything; never pay for what you have forgotten.
--
-- `suppressed` is the third tier rather than a flag because a suppressed edge —
-- one the Commander has said is wrong — must be excluded from scans no matter
-- what its weight does, and must never be promoted back by reactivation. That
-- is a partition property, not a ranking one. Keeping it as a tier also means
-- the identity lookup below still finds it, which is what stops the next
-- reflection pass from cheerfully recreating the edge he just rejected.
--
-- `kind` is the secondary axis. It is a partition key column on the vector
-- table, where sqlite-vec prunes on any constrained subset of the partition
-- keys, and it follows `tier` in the node scan index. It is deliberately NOT in
-- the edge scan index: ranking wants both species at once, so leading with the
-- species would halve every candidate scan into two.
--
-- Both axes are low cardinality (3 tiers x 7 node kinds = 21 partitions;
-- 3 x 2 = 6 for edges) and both are exact-match. That matters: a high-cardinality
-- partition key produces many under-full chunks and costs more than it saves.
--
--
-- ## 3. A partition key prunes SCANS. It must NOT prune IDENTITY LOOKUPS
--
-- This is the subtle half, and the Commander raised it himself. Moving an edge
-- to a cold partition must never make it harder to FIND. If a cold edge cannot
-- be found by identity, "demote, never prune" silently becomes "prune, slowly,
-- while claiming otherwise" — the row is still on disk, and nothing can reach
-- it, which is worse than a delete because it looks fine.
--
-- Reactivation and the duplicate check are both keyed point lookups on
-- `(source_node, target_node)`. So:
--
--   * `memory_edges_identity_idx` is UNIQUE on `(source_node, target_node,
--     relation)` and **does not mention `tier`**. Not leading with the
--     partition key is what makes it span every partition, cold and suppressed
--     included, at O(log n) — and the UNIQUE-ness means the duplicate check
--     syl-005.4.2 performs is enforced by the store rather than by a
--     check-then-write in TypeScript that a retry can slip past.
--   * `memory_edges_reverse_idx` does the same for the other direction.
--   * `memory_nodes` is keyed by `id`, which is likewise tier-free.
--
-- Do not "optimise" `tier` into the front of those two indexes. There is a test
-- that reads the index DDL back out of `sqlite_master` and fails if `tier`
-- appears in it, because the failure it prevents is invisible at every other
-- layer. See `syl-005.6.4`, the audit that proves nothing has become
-- unreachable.
--
--
-- ## 4. Decay is derived at read time; demotion is scheduled, not swept
--
-- Weight and `last_touched_at` are stored; the decayed value is computed when
-- it is read. A nightly `UPDATE` across every edge would be enormous write
-- amplification to recompute a pure function of two columns that are already
-- there.
--
-- That leaves one honest question: how do you find the edges that have crossed
-- the floor without scanning every edge to ask? Answer: the crossing instant is
-- computable in closed form the moment the weight is written, so it is written
-- down. `demote_after` is that instant, and the sweep is
--
--     UPDATE memory_edges SET tier = 'cold'
--      WHERE tier = 'hot' AND demote_after IS NOT NULL AND demote_after <= :now
--
-- a range scan over a partial index containing only the edges that can ever be
-- eligible. It touches the rows that actually moved and nothing else. The decay
-- law and the floor belong to syl-005.3.2; this file only requires that a hot
-- inferred edge always knows when it next crosses.
--
--
-- ## 5. Ids
--
-- `syl:memory_node:<uuidv7>` and `syl:memory_edge:<uuidv7>`, minted by
-- `backend/src/memory/schema.ts`. The kind lives in a column and NOT in the id,
-- for one specific reason: `syl:goal:<uuid>` already addresses a row in the
-- operational `goals` table, and a memory node of kind `goal` minting the same
-- prefix would make `syl:goal:…` in a log line ambiguous between two different
-- stores. The type prefix exists so a dangling reference is legible; a prefix
-- that means two things defeats its own purpose.
--
--
-- ## 6. A naming collision, called out because it will bite otherwise
--
-- `source_node` and `target_node` are the edge's ENDPOINTS. `source` is also a
-- node kind (a document, a message — the thing a fact came from), and
-- provenance is the column `asserted_by`. The endpoint names are fixed by the
-- bead and by syl-005.4.2, so the provenance column is the one that moved.


CREATE TABLE memory_nodes (
  id          TEXT NOT NULL PRIMARY KEY,

  -- Partition key, primary axis. Leads every scan index below. A new node is
  -- hot; supersession (syl-005.3.3) is what moves one to cold.
  tier        TEXT NOT NULL DEFAULT 'hot'
              CHECK (tier IN ('hot', 'cold', 'suppressed')),

  -- Partition key, secondary axis. Effectively immutable: a person does not
  -- become an event, and moving a node between partitions for a reason other
  -- than relevance would be a rewrite rather than a correction.
  kind        TEXT NOT NULL
              CHECK (kind IN ('fact', 'memory', 'person', 'source', 'event', 'goal', 'decision')),

  -- What this node is, in a few words. Non-blank, because the admin surface and
  -- every log line lean on it and an empty string is not a name.
  label       TEXT NOT NULL,

  -- The content, where there is more of it than the label. Nullable: a `person`
  -- node is often nothing but a name.
  body        TEXT,

  -- The seam between the graph and the life model: the operational row this
  -- node is about — a goal, a todo, a message, a conversation. Deliberately
  -- polymorphic, so it cannot carry a FOREIGN KEY; the CHECK pins the shape so
  -- a bare `goal-17` cannot get in. A dangling reference here is legible
  -- precisely because ids are type-prefixed.
  subject_id  TEXT,

  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,

  CHECK (id GLOB 'syl:memory_node:*' AND length(id) = 52),
  -- Note the explicit character set. SQLite's one-argument `trim` strips
  -- SPACES ONLY: a label of "\n" would otherwise satisfy a `trim(label) <> ''`
  -- check and be blank on every screen that shows it.
  CHECK (length(trim(label, char(32, 9, 10, 13))) > 0),
  CHECK (subject_id IS NULL OR subject_id GLOB 'syl:*:*'),
  CHECK (updated_at >= created_at)
) STRICT;

-- The candidate scan, partitioned: `tier` first so cold and suppressed nodes
-- are never read, `kind` second so a search restricted to one kind prunes
-- further, `updated_at` last so recency needs no sort.
CREATE INDEX memory_nodes_scan_idx ON memory_nodes (tier, kind, updated_at DESC);

-- "What does the graph know about this goal?" Partial, because most nodes are
-- about nothing in the operational store.
CREATE INDEX memory_nodes_subject_idx ON memory_nodes (subject_id)
  WHERE subject_id IS NOT NULL;


CREATE TABLE memory_edges (
  id              TEXT NOT NULL PRIMARY KEY,

  -- Partition key, primary axis. See §2. Crossing the relevance floor moves a
  -- row from 'hot' to 'cold'; the Commander rejecting an edge moves it to
  -- 'suppressed', from which reactivation must never bring it back.
  tier            TEXT NOT NULL DEFAULT 'hot'
                  CHECK (tier IN ('hot', 'cold', 'suppressed')),

  -- Partition key, secondary axis: the species. `observed` was asserted by a
  -- source and carries provenance. `inferred` was discovered by reflection and
  -- carries confidence, weight, and its reasoning.
  kind            TEXT NOT NULL CHECK (kind IN ('observed', 'inferred')),

  -- The endpoints. NOT provenance — see §6.
  source_node     TEXT NOT NULL REFERENCES memory_nodes (id),
  target_node     TEXT NOT NULL REFERENCES memory_nodes (id),

  -- The predicate. Part of an edge's IDENTITY, so two nodes can be related in
  -- more than one way without either relation duplicating the other.
  relation        TEXT NOT NULL,

  -- Ranking strength at `last_touched_at`. The DECAYED value is derived at read
  -- time from this and that stamp; it is never written back. Strictly greater
  -- than zero, because an edge whose strength had genuinely reached zero could
  -- not be promoted back, and constraint 6 says every edge can.
  weight          REAL NOT NULL DEFAULT 1.0 CHECK (weight > 0.0 AND weight <= 1.0),

  -- How sure the reflection was. Inferred edges only. Same asymptote, same
  -- reason: never zero.
  confidence      REAL CHECK (confidence IS NULL OR (confidence > 0.0 AND confidence <= 1.0)),

  -- WHY this edge exists. Inferred edges only, and MANDATORY for them — an
  -- inference nobody can audit is a rumour, and the Commander cannot suppress
  -- what he cannot see the argument for.
  reasoning       TEXT,

  -- Provenance. Observed edges only, and mandatory for them: "asserted by a
  -- source" is what makes an edge observed. Points at a node, usually of kind
  -- `source`.
  asserted_by     TEXT REFERENCES memory_nodes (id),

  -- When the weight was last set. Half of the derived-decay pair.
  last_touched_at TEXT NOT NULL,

  -- The instant this edge crosses the relevance floor, computed once when the
  -- weight is written. NULL means "never crosses on its own": every observed
  -- edge, and any inferred edge already out of the hot partition. See §4.
  demote_after    TEXT,

  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,

  CHECK (id GLOB 'syl:memory_edge:*' AND length(id) = 52),

  -- A node is not related to itself, and an edge that says so is a bug in
  -- whatever produced it rather than a fact about the world.
  CHECK (source_node <> target_node),
  CHECK (length(trim(relation, char(32, 9, 10, 13))) > 0),

  -- The two species, kept apart by the store rather than by convention. Each
  -- carries exactly what its species means and nothing belonging to the other,
  -- so "is this an observation or an inference?" is answerable from the row.
  CHECK (
    (kind = 'observed'
      AND asserted_by IS NOT NULL
      AND confidence IS NULL
      AND reasoning IS NULL
      AND demote_after IS NULL)
    OR
    (kind = 'inferred'
      AND asserted_by IS NULL
      AND confidence IS NOT NULL
      AND reasoning IS NOT NULL
      AND length(trim(reasoning, char(32, 9, 10, 13))) > 0)
  ),

  -- Every hot inferred edge knows when it next crosses the floor. Without this
  -- the demotion sweep is incomplete by exactly the rows that forgot to compute
  -- it, and the hot partition grows forever — silently, and only under load.
  CHECK (NOT (kind = 'inferred' AND tier = 'hot') OR demote_after IS NOT NULL),

  CHECK (last_touched_at >= created_at),
  CHECK (updated_at >= created_at)
) STRICT;

-- IDENTITY. Does not mention `tier`, and that is the point: it spans every
-- partition, so a cold or suppressed edge is found by a point lookup exactly as
-- cheaply as a live one. See §3 before changing this line.
--
-- UNIQUE, so the "does an edge already exist for this pair?" assertion in
-- syl-005.4.2 is backed by the store. An edge's identity is
-- (source, target, relation) — the species is a property, not part of it, so an
-- inference cannot silently duplicate an observation of the same relation.
CREATE UNIQUE INDEX memory_edges_identity_idx
  ON memory_edges (source_node, target_node, relation);

-- Traversal the other way. Also tier-free, for the same reason.
CREATE INDEX memory_edges_reverse_idx ON memory_edges (target_node, source_node);

-- The candidate scan, partitioned: `tier` leads, so cold and suppressed edges
-- never enter it however many of them accumulate. Species is deliberately
-- absent — ranking wants both at once.
CREATE INDEX memory_edges_rank_idx
  ON memory_edges (tier, source_node, weight DESC, last_touched_at DESC);

-- The demotion sweep, and nothing else: `tier` leads (it is a scan path, so it
-- is partitioned like every other scan path), then the crossing instant as a
-- range. The nightly pass is therefore a range scan over exactly the edges that
-- have actually crossed, never an UPDATE across the graph.
--
-- The partial predicate keeps every observed edge out of the index entirely,
-- since an observation has no scheduled crossing at all.
--
-- Written as `(tier, demote_after)` rather than as `(demote_after)` with `tier`
-- folded into the partial predicate. The second form indexes fewer rows and is
-- what you reach for first, and it is a trap: a constraint absorbed by a partial
-- predicate is invisible to the query planner's cost estimate, so SQLite scored
-- `memory_edges_rank_idx` as the cheaper plan and used that instead. Measured —
-- EXPLAIN QUERY PLAN in `memory-core-migration.test.ts` said so.
CREATE INDEX memory_edges_demote_idx ON memory_edges (tier, demote_after)
  WHERE demote_after IS NOT NULL;

-- "What did this source assert?" — needed to retract an observation when a
-- source turns out to be wrong.
CREATE INDEX memory_edges_asserted_by_idx ON memory_edges (asserted_by)
  WHERE asserted_by IS NOT NULL;

-- Constraint 6, made structural.
--
-- An inferred edge is never deleted, only demoted. Enforcing it here rather
-- than in a service means a future refactor, a stray cleanup job, or a
-- well-meaning `DELETE ... WHERE weight < 0.01` cannot quietly turn the memory
-- graph into a cache.
--
-- Observed edges are deliberately NOT covered. An observation can be retracted:
-- the source was wrong, or the Commander asked for something to be forgotten
-- outright, and that is a real requirement rather than a leak in the rule. An
-- inference cannot be retracted by deletion, because the next reflection pass
-- would simply rediscover it — suppression is the mechanism for that, and it is
-- a tier.
CREATE TRIGGER memory_edges_inferred_never_deleted
BEFORE DELETE ON memory_edges
WHEN OLD.kind = 'inferred'
BEGIN
  SELECT RAISE(
    ABORT,
    'an inferred edge is never deleted, only demoted: move it to the cold or suppressed tier'
  );
END;
