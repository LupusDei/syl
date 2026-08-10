-- 0016_supersession_ledger.sql — facts are never deleted; they are RETIRED with
-- a validity interval. `syl-005.3.3`.
--
-- The counterpart to `0012_memory_core.sql`. That file made constraint 6 true
-- for edges — never deleted, only demoted. This one makes the other half of the
-- same sentence true for facts: **nodes are superseded, edges are demoted,
-- nothing is destroyed.**
--
--
-- ## 1. Why this is a LEDGER and not a similarity check
--
-- The obvious implementation of "has this fact changed?" is to embed the new
-- statement, compare it with what is stored, and treat a close match as an
-- update. It does not work, and it does not fail in a way you would notice:
--
--   **Embedding similarity cannot tell STALE from CURRENT.** A contradiction of
--   a stored fact is on average *more* cosine-similar to it than a genuine
--   duplicate is — "he works at Acme" and "he no longer works at Acme" share
--   almost every token. Discriminating the two by cosine distance performs
--   barely better than chance.
--
-- The measured consequence: a deterministic ledger reaches 0.95–1.00 accuracy
-- on evolving benchmarks where ordinary similarity retrieval gets 0.20–0.47,
-- and serves a superseded value essentially never against 15–40% for retrieval.
-- A personal assistant that answers with last year's job, last month's address
-- or a cancelled plan 15–40% of the time is not slightly worse; it is not
-- trustworthy at all.
--
-- So supersession here is **deterministic and structural**: it is keyed on
-- `(subject, relation)` and decided by a UNIQUE index, with no threshold to
-- tune and **no model call at read time**. Reading the current value of a fact
-- is a point lookup, not an inference.
--
--
-- ## 2. The key is `(subject, relation)`, and the invariant is ONE OPEN ROW
--
-- A fact is a triple: subject, relation, value. The first two are its identity
-- — "the Commander's employer" — and the third is what changes. So a new value
-- for a key that already has an open row CLOSES that row and OPENS a new one.
--
-- `memory_assertions_current_idx` is UNIQUE on `(subject, relation)` and
-- PARTIAL on `superseded_at IS NULL`. That single line is the whole mechanism:
--
--   * It makes "at most one current value per key" an invariant the STORE
--     enforces, not one a service remembers to maintain. A check-then-write in
--     TypeScript is a race a retry can slip past, and the symptom of losing that
--     race is two current values for one fact — from which every later read
--     picks arbitrarily.
--   * It makes reading the current value a point lookup on a partial index
--     whose size is the number of live facts, NOT the number of rows. Ten years
--     of history costs the read nothing. This is why **bounded growth is a
--     consequence of supersession rather than a goal pursued by compression** —
--     and that distinction is load-bearing, because both directions of
--     compression have been measured and both are worse:
--       - aggressive near-duplicate MERGING collapses accuracy, 0.82 → 0.62.
--       - naive retain-everything raises fabrication roughly SIXFOLD.
--     The ledger does neither. It retains everything and reads only what is
--     open.
--
-- Identical re-assertion of the SAME value is idempotent — it opens no row —
-- and that is byte equality, not a similarity threshold. Two values that merely
-- look alike are always two rows. Idempotence is not merging.
--
--
-- ## 3. BI-TEMPORAL: two clocks, because "when" is two questions
--
--   * VALID TIME — `valid_from` / `valid_to`. When the claim was true *in the
--     world*.
--   * TRANSACTION TIME — `recorded_at` / `superseded_at`. When Syl *believed*
--     it.
--
-- They come apart constantly and the difference is the interesting part. If the
-- Commander changed jobs in March and mentioned it in June, the new assertion
-- is valid from March and recorded in June; for those three months Syl believed
-- something that was already false. Only two clocks can say that.
--
-- The bead asks for **"what did I believe in March?"** and that is transaction
-- time: the row where `recorded_at <= t AND (superseded_at IS NULL OR
-- superseded_at > t)`. Exactly one row satisfies it per key, because the unique
-- index guarantees the open intervals never overlap. `trueAt` asks the other
-- question — what does she NOW think was the case in March — and reads valid
-- time instead. Both are one indexed lookup.
--
--
-- ## 4. History is retained, not overwritten — and that is enforced
--
-- The same instinct as constraint 4 (never silently drop a reminder) and
-- constraint 6 (never delete an inferred edge): the system does not get to
-- discard things quietly.
--
--   * `memory_assertions_never_deleted` refuses every DELETE. Unlike
--     `memory_edges`, there is no carve-out: an observation can be retracted
--     because a source was wrong, but a superseded fact is the ANSWER to "what
--     did I believe in March", so deleting it destroys the only thing this
--     table exists for.
--   * `memory_assertions_history_is_immutable` refuses any UPDATE that rewrites
--     what a row claimed, when it claimed it, or that RE-OPENS a closed row.
--     The only legal update is closing an open row. Without it, "supersede" and
--     "quietly edit the past" are the same statement with different bind
--     values, and nothing downstream could tell them apart.
--
--
-- ## 5. Relationship to the graph
--
-- `value_node` is the optional graph node a value corresponds to, and it is why
-- `memory_nodes.tier` says "supersession (syl-005.3.3) is what moves one to
-- cold". When an assertion is superseded, the node carrying the stale value
-- MOVES to the cold partition: it leaves every scan, so retrieval stops
-- surfacing it, and it stays addressable by id, so the history above still
-- resolves. Demotion and partitioning are the same mechanism here too.
--
-- Note what is NOT here: no confidence, no trust score, no feedback. A ledger
-- entry is not more or less believed — it is current or it is closed, and that
-- is a fact about the interval, not a number to tune.


CREATE TABLE memory_assertions (
  id            TEXT NOT NULL PRIMARY KEY,

  -- The thing the claim is about. A type-prefixed id — usually a memory node,
  -- but an operational row (`syl:goal:…`) is equally addressable. Polymorphic,
  -- so no FOREIGN KEY; the CHECK pins the shape so a bare `goal-17` cannot get
  -- in, and a dangling reference stays legible because ids carry their type.
  subject       TEXT NOT NULL,

  -- The predicate. Half of the key, so one subject can carry many independent
  -- facts, each with its own history.
  relation      TEXT NOT NULL,

  -- The claim, verbatim. Compared by BYTE EQUALITY and never by similarity —
  -- see §1. Two values that merely look alike are two assertions.
  value         TEXT NOT NULL,

  -- The graph node this value corresponds to, where there is one. Superseding
  -- an assertion demotes it to the cold tier. See §5.
  value_node    TEXT REFERENCES memory_nodes (id),

  -- VALID TIME: when this was true in the world. `valid_to IS NULL` means "as
  -- far as Syl knows, still true".
  valid_from    TEXT NOT NULL,
  valid_to      TEXT,

  -- TRANSACTION TIME: when Syl believed it. `superseded_at IS NULL` means "this
  -- is the current belief", and it is the partial index's predicate.
  recorded_at   TEXT NOT NULL,
  superseded_at TEXT,

  -- What replaced it. NULL with a non-null `superseded_at` is a RETIREMENT:
  -- "this stopped being true and nothing took its place", which is a real thing
  -- to learn and must not be forced into inventing a successor.
  --
  -- DEFERRABLE INITIALLY DEFERRED, and it has to be. A supersession closes the
  -- old row *pointing at* the new one and then opens the new one, in that
  -- order, because the UNIQUE PARTIAL index below refuses two open rows for one
  -- key — so the successor cannot exist yet when the link is written. The other
  -- order is impossible and the other shape (link it afterwards, in a third
  -- statement) would mean UPDATEing a closed row, which is the one thing
  -- `memory_assertions_history_is_immutable` exists to forbid. Deferring says
  -- the honest thing: this reference is meaningful once the transaction is
  -- whole, and it is still checked, at COMMIT.
  superseded_by TEXT REFERENCES memory_assertions (id) DEFERRABLE INITIALLY DEFERRED,

  -- Provenance: the node — usually of kind `source` — this came from.
  asserted_by   TEXT REFERENCES memory_nodes (id),

  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,

  CHECK (id GLOB 'syl:memory_assertion:*' AND length(id) = 57),

  -- Explicit character set: SQLite's one-argument `trim` strips SPACES ONLY, so
  -- a relation of "\n" would otherwise pass and be blank on every screen.
  CHECK (subject GLOB 'syl:*:*'),
  CHECK (length(trim(relation, char(32, 9, 10, 13))) > 0),
  CHECK (length(trim(value, char(32, 9, 10, 13))) > 0),

  -- A validity interval runs forwards. Zero length is allowed: a backdated
  -- correction can legitimately say the previous value was never true for any
  -- duration, and losing that row would be worse than keeping an empty one.
  CHECK (valid_to IS NULL OR valid_to >= valid_from),

  -- Belief runs forwards too, and a successor implies a close. The converse is
  -- deliberately NOT required — see `superseded_by` above.
  CHECK (superseded_at IS NULL OR superseded_at >= recorded_at),
  CHECK (superseded_by IS NULL OR superseded_at IS NOT NULL),
  CHECK (superseded_by IS NULL OR superseded_by <> id),

  CHECK (updated_at >= created_at)
) STRICT;

-- THE INVARIANT. At most one open row per (subject, relation), enforced by the
-- store rather than by a check-then-write a retry could slip past.
--
-- Also the current-value read: a point lookup on an index whose size is the
-- number of LIVE facts, not the number of rows. Read §2 before changing this
-- line — dropping the partial predicate would make supersession impossible, and
-- dropping the UNIQUE would make it silently unreliable, which is worse.
CREATE UNIQUE INDEX memory_assertions_current_idx
  ON memory_assertions (subject, relation)
  WHERE superseded_at IS NULL;

-- "What did I believe in March?" — transaction time. Also the full history of a
-- key, in the order it was learned.
CREATE INDEX memory_assertions_belief_idx
  ON memory_assertions (subject, relation, recorded_at);

-- "What was actually true in March?" — valid time. A separate index because the
-- two clocks are genuinely different orderings of the same rows; that is what
-- bi-temporal means, and collapsing them into one index would make one of the
-- two questions a table scan.
CREATE INDEX memory_assertions_validity_idx
  ON memory_assertions (subject, relation, valid_from);

-- "Which assertion is this node the value of?" — needed to demote the right
-- node when a fact changes. Partial, because most assertions are plain text.
CREATE INDEX memory_assertions_value_node_idx
  ON memory_assertions (value_node)
  WHERE value_node IS NOT NULL;

-- Nothing is destroyed.
--
-- No carve-out, unlike `memory_edges` where an observation can be retracted. A
-- superseded assertion IS the answer to "what did I believe in March", so a
-- DELETE here does not tidy the table — it destroys the only thing the table
-- exists for. Correcting a mistaken assertion is a supersession like any other.
CREATE TRIGGER memory_assertions_never_deleted
BEFORE DELETE ON memory_assertions
BEGIN
  SELECT RAISE(
    ABORT,
    'an assertion is never deleted, only superseded: close it and open the new value instead'
  );
END;

-- History is retained, not OVERWRITTEN.
--
-- The only legal update is closing an open row — setting `valid_to`,
-- `superseded_at`, `superseded_by`, `updated_at`. Anything that rewrites what a
-- row claimed, when it was true, or when it was learned is refused, as is
-- re-opening a row that has already been closed.
--
-- Without this, "supersede" and "quietly edit the past" are the same UPDATE
-- with different bind values, and no reader could tell which had happened.
CREATE TRIGGER memory_assertions_history_is_immutable
BEFORE UPDATE ON memory_assertions
WHEN OLD.subject <> NEW.subject
  OR OLD.relation <> NEW.relation
  OR OLD.value <> NEW.value
  OR OLD.valid_from <> NEW.valid_from
  OR OLD.recorded_at <> NEW.recorded_at
  OR OLD.created_at <> NEW.created_at
  OR (OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS NULL)
BEGIN
  SELECT RAISE(
    ABORT,
    'an assertion''s history is retained, never rewritten: only closing an open row is allowed'
  );
END;
