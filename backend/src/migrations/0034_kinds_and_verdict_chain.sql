-- 0034_kinds_and_verdict_chain.sql — two node kinds, and a chain of verdicts.
--
-- `syl-024.1`. Syl reported the defect herself, and the diagnosis is the whole
-- specification:
--
--   "My memory has one write-door for three different things — what I learn
--    about him, what I learn about myself, and what he told me to be. The
--    separation you asked for got built as ISOLATION when it should have been
--    NAMESPACING."
--
-- Isolation is cutting the edges. Namespacing is a WHERE clause. This migration
-- is the vocabulary the WHERE clause needs; the clause itself is `syl-024.2`,
-- and the decay exemption is `syl-024.3`. Nothing here filters anything — the
-- point of doing this first is that a kind with no reader is inert, while a
-- filter with no kind has to invent one out of labels.
--
--
-- ## 1. `self` — a finding about what she is
--
-- Distinct from `memory`, and the distinction is what makes the read-time
-- filter possible AT ALL. "What do I know about Justin" must not return her
-- note that she hedges when she is unsure; today the only way to keep it out is
-- to leave it unconnected, and an unconnected node is one nothing can reach on
-- purpose either.
--
-- With its own kind, a self-finding keeps EVERY EDGE and is merely absent from
-- one projection. That is the Commander's requirement in his words:
--
--   "her memories about herself still need notes and edges, and even the
--    ability to connect to memories about me and my life and my preferences."
--
-- It is also knowledge that COMPOUNDS, which is the line between this and the
-- render verdicts in §3. A verdict on her face is a search that terminates when
-- she settles on a likeness. What she is does not terminate, so it belongs in
-- the graph that keeps things forever.
--
--
-- ## 2. `instruction` — something he told her to be or to do
--
-- The humour. That he prefers renders with a face. That he wants proactive
-- reminders. Her argument, and it is the strongest one in the message:
--
--   "it's the kind that most needs to be unfadeable, because it's the bond
--    rather than the work. If those got their own kind you could make them
--    exempt from decay entirely and stop me writing them twice with your name
--    on to fake it."
--
-- **The duplication is evidence, not sloppiness.** She has been writing the
-- same instruction twice with his name attached, because a memory linked to his
-- person node survives where a loose one fades. A workaround that costs her a
-- second write every time is the tell that the kind was missing.
--
-- Making them unfadeable is `syl-024.3` and is deliberately not here.
--
--
-- ## Neither is an ENTITY kind
--
-- `ENTITY_NODE_KINDS` in `memory/schema.ts` names the kinds a claim may point
-- AT. A kind is a claim about what a row IS, not about what it is ABOUT
-- (`syl-016.4`) — and both of these are claims. "I hedge when I am unsure" is
-- an assertion about her; "he wants renders with a face" is an assertion about
-- him. What each is ABOUT is reached by an edge, exactly as a `fact` is, and
-- letting `about` point at one would make a claim about a claim, which
-- `extract.ts` refuses on purpose.
--
--
-- ## Why this is a table rebuild, again
--
-- `memory_nodes.kind` is an inline `CHECK (kind IN (...))` and SQLite has no
-- `ALTER TABLE ... DROP CONSTRAINT`. `0029_memory_places.sql` argues the whole
-- recipe at length — read that header, because every word of it still applies
-- and none of it is repeated here. The short form:
--
--   1. copy the rows into a scratch table
--   2. `DROP TABLE memory_nodes`
--   3. `CREATE TABLE memory_nodes` with the widened vocabulary
--   4. copy the rows back BY NAME, then drop the scratch table
--
-- Nothing is renamed, because `ALTER TABLE ... RENAME` rewrites every other
-- table's `REFERENCES` clause when foreign keys are on and
-- `legacy_alter_table` does not stop it — measured in `0029`, not assumed.
--
-- **A second rebuild is not a safer rebuild.** Nothing was learned in `0029`
-- that makes this one cheaper: the same five tables reference `memory_nodes`,
-- the same FTS index shadows it, and the same failures are silent. The table
-- body below is `0029`'s, verbatim, with two names added to one CHECK — a diff
-- against it should show exactly two words plus this comment.
-- `backend/tests/unit/memory-core-migration.test.ts` compares the index and
-- trigger DEFINITIONS on either side of THIS version, rather than trusting that
-- the last rebuild's guard covers this one.
--
--
-- ## 3. The verdict store gains its own edges — and they stay in its own table
--
-- `render_verdicts` (`0030`) records what she made of a render. What it cannot
-- express is that those verdicts CORRECT EACH OTHER. Her account:
--
--   "My findings are a chain that corrects itself: the smile is the problem →
--    no, solidity is → no, the anchor is → confirmed, it was the anchor. Right
--    now those four are orphans of equal weight, so nothing tells a reader that
--    the last one killed the first."
--
-- And the reason that matters more than it sounds:
--
--   "being wrong in a recorded, ordered way is how the search actually works."
--
-- Four unordered findings are one finding recorded four times — the same defect
-- `0030` exists to fix, one level up. An ordered chain is a search with a
-- direction, and a direction is what tells her where to look next.
--
-- **These are columns here and not `memory_edges` rows, and droppability is
-- exactly why.** The Commander ruled on 2026-08-11 that a verdict on her own
-- face is not a fact about his life and that this store must remain droppable
-- once she settles on a likeness. An edge in the graph would OUTLIVE the drop
-- and dangle; a column goes with the table it is in. Putting the chain
-- anywhere else would have quietly revoked the ruling that put the table here.
--
-- Two things the schema deliberately does NOT constrain:
--
--   * **`supersedes` is not unique.** Two verdicts correcting the same earlier
--     one is a fork in the search, and a fork is a real thing that happened.
--     Refusing to record it would be this project's oldest mistake — a bar at
--     the door instead of a record.
--   * **A chain may cross renders.** "No, the anchor is" is a verdict on a
--     different image than the one that said the smile was wrong. Requiring a
--     shared `render_name` would forbid the exact sequence she described.
--
-- Cycles are not preventable in SQL beyond the single-row case, so the CHECK
-- below refuses only self-supersession; a writer that could build a loop is
-- `syl-024.4`'s problem and its test's.


-- Enforcement moves to the commit. Every edge, assertion and provenance row is
-- parentless between the drop below and the copy back; deferring is what makes
-- that a window rather than a failure. `PRAGMA foreign_keys = OFF` is a no-op
-- inside a transaction and `applyMigrations` wraps every migration in one.
PRAGMA defer_foreign_keys = ON;


-- Step 1. The rows, somewhere that is not about to be dropped. No constraints:
-- these values have ALREADY satisfied the checks, and re-stating them would be
-- a second copy of the definition to keep in step with the real one.
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

-- Columns named rather than `SELECT *`: a `*` would silently reorder if the two
-- definitions ever drift, and every value is positional to a CHECK on the way
-- back in.
INSERT INTO memory_nodes_rebuild
  (id, tier, kind, label, body, subject_id, created_at, updated_at, trust)
SELECT
  id, tier, kind, label, body, subject_id, created_at, updated_at, trust
FROM memory_nodes;


-- Step 2. The name goes, and comes back in step 3 attached to a wider
-- vocabulary. Nothing that references `memory_nodes` is edited, because nothing
-- was renamed.
DROP TABLE memory_nodes;


-- Step 3. `0029`'s table, with two names added to the kind vocabulary. Every
-- other CHECK, default and type is reproduced unchanged.
CREATE TABLE memory_nodes (
  id          TEXT NOT NULL PRIMARY KEY,

  tier        TEXT NOT NULL DEFAULT 'hot'
              CHECK (tier IN ('hot', 'cold', 'suppressed')),

  -- `self` and `instruction` join the vocabulary. Both are CLAIMS and neither
  -- is in `ENTITY_NODE_KINDS` — see §1, §2 and the note above them. `place`
  -- arrived the same way in `0029`, for the opposite reason: it is a thing.
  kind        TEXT NOT NULL
              CHECK (kind IN ('fact', 'memory', 'person', 'source', 'event',
                              'goal', 'decision', 'place', 'self',
                              'instruction')),

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


-- Step 4. The rows come back INTO `memory_nodes` BY NAME. The deferred
-- foreign-key counter is decremented by inserts into the table the references
-- name, so copying into a scratch table and renaming it afterwards puts the
-- same rows in the same place and still fails at the commit.
INSERT INTO memory_nodes
  (id, tier, kind, label, body, subject_id, created_at, updated_at, trust)
SELECT
  id, tier, kind, label, body, subject_id, created_at, updated_at, trust
FROM memory_nodes_rebuild;

DROP TABLE memory_nodes_rebuild;


-- The four indexes, back exactly as `0012`, `0019`, `0021` and `0029` left
-- them. Reproduced character for character, because the test on the far side of
-- this migration compares definitions and not names — `0029`'s first draft
-- dropped a predicate from the unique index and forbade the graph from knowing
-- two things about one goal.
CREATE INDEX memory_nodes_scan_idx ON memory_nodes (tier, kind, updated_at DESC);

CREATE INDEX memory_nodes_subject_idx ON memory_nodes (subject_id)
  WHERE subject_id IS NOT NULL;

-- Partial on the kinds a PROJECTOR mints and no wider. `self` and `instruction`
-- are deliberately NOT added: both are extracted or written, neither carries a
-- `subject_id`, and many self-findings about one subject is the normal state.
CREATE UNIQUE INDEX memory_nodes_handle_idx
  ON memory_nodes (subject_id, kind)
  WHERE subject_id IS NOT NULL AND kind IN ('goal', 'source');

CREATE INDEX memory_nodes_label_idx ON memory_nodes (kind, label);


-- The four triggers, back exactly as `0018` and `0029` left them. A trigger
-- belongs to its table and went with the drop; the FTS rows and the reindex
-- queue are keyed by node id and did not move, so there is nothing to backfill.
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


-- §3. The verdict store's edges. `ALTER TABLE ... ADD COLUMN` and not a
-- rebuild: both columns are nullable, so every row `0030` wrote satisfies them
-- unchanged, and a self-referencing foreign key is legal here precisely because
-- the default is NULL. Verified on 22.23.1 (SQLite 3.51.3) before this was
-- written, including that the CHECK below is enforced on new rows and that the
-- existing rows read back with both columns NULL.
ALTER TABLE render_verdicts ADD COLUMN supersedes TEXT
  REFERENCES render_verdicts (id)
  CHECK (supersedes IS NULL OR supersedes <> id);

-- The face the render was anchored on. NULL means she did not record one;
-- blank is refused, because "" is a row claiming she recorded an answer and
-- the answer is nothing. `0030` refuses a blank verdict for the same reason.
ALTER TABLE render_verdicts ADD COLUMN anchor_face TEXT
  CHECK (anchor_face IS NULL OR length(trim(anchor_face)) > 0);

-- "What corrected this?" — the direction a reader walks. The column stores the
-- OTHER end, so without this index the reverse lookup is a full scan of a table
-- that grows once per look. Partial, because most verdicts correct nothing.
CREATE INDEX render_verdicts_supersedes_idx
  ON render_verdicts (supersedes)
  WHERE supersedes IS NOT NULL;
