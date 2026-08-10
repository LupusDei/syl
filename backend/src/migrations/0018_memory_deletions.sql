-- 0018_memory_deletions.sql — the Commander's explicit order, made structural.
-- `syl-eg3`, `syl-010.3.1`, `syl-010.3.2`.
--
-- His ruling, 2026-08-10: *"if I give the explicit order to delete a memory,
-- that memory and edges should be removed."*
--
--
-- ## 1. This is not a hole in constraint 6. It is the sentence constraint 6
-- ##    always meant
--
-- `0012` made "an inferred edge is never deleted, only demoted" true of the
-- STORE, and `0015` did the same for assertions. Read those rules for what they
-- defend: **a memory system that quietly forgets.** Decay, the nightly sweep,
-- a cleanup job, a well-meaning `DELETE ... WHERE weight < 0.01` — those are
-- what the triggers exist to stop, and they still cannot delete anything after
-- this file.
--
-- The rule never bound HIM. A "forget this" that leaves the thing on disk is
-- not honouring the constraint, it is disobeying him — and the residue is real,
-- because an inference's `reasoning` is prose and prose quotes what it reasoned
-- over.
--
-- So the exception is not a mode, a flag, or a privileged connection. Those all
-- turn a structural guarantee into a convention. It is:
--
--     A ROW MAY BE DELETED ONLY WHILE AN AUDIT RECORD NAMING THAT EXACT ROW,
--     ON THE COMMANDER'S INSTRUCTION, IS OPEN.
--
-- Which makes the two halves of `syl-010.3` the same mechanism. **You cannot
-- delete without writing down that you did**, because the write-down is the
-- permission. That is stronger than an audit a service remembers to emit: a
-- deletion nobody can audit is indistinguishable from data loss, which is the
-- failure constraint 4 exists to prevent, and here it cannot happen.
--
-- Three properties make the exception narrow rather than advisory:
--
--   * **Per row.** `memory_deletion_scope` names ids. An open window for one
--     edge does not reach the edge beside it.
--   * **Per instant.** The window is `executed_at IS NULL`, and `forget.ts`
--     opens and closes it inside ONE transaction. A leftover audit row is not a
--     standing permission.
--   * **Named authority.** `instructed_by` is CHECKed against a single literal,
--     `'commander'`. Widening who may order a deletion is a migration, written
--     in SQL, where the decision is visible — not a string a caller passes.
--
--
-- ## 2. Why the audit record holds no content, and what it holds instead
--
-- The tension is real and it is the first thing anyone asks: recording
-- "deleted the node about X" reintroduces X, and the audit becomes the residue
-- it was meant to prove was gone.
--
-- The resolution is that an audit of a deletion has three jobs, and none of
-- them is remembering what was deleted:
--
--   1. **Prove it happened**, so the absence is a deletion and not a loss —
--      counts and opaque ids do that. `memory_deletion_scope` says exactly which
--      rows went. `syl:memory_edge:<uuid>` identifies a row uniquely and says
--      nothing about it, which is precisely the property `0012` §5 minted the
--      type prefix for.
--   2. **Prove who ordered it**, so it was authority and not a bug —
--      `instructed_by` plus `instruction_ref`. The reference points at WHERE he
--      said it (a message row), never at WHAT he said. If he later deletes that
--      message too, this degrades to a dangling reference that is still legible,
--      which is the whole reason ids carry their type.
--   3. **Let a specific question be answered later**, without holding the
--      answer — `digest`, a SHA-256 over the material removed. Given a candidate
--      text you can prove it WAS deleted here. You cannot go the other way. That
--      is the exact asymmetry this record needs: verifiable, not readable.
--
-- `note` is the one free-text column and it is for the OPERATION, not the
-- memory — "retention purge of a sensitive source". Nothing enforces that,
-- because nothing can; it is documented here and `forget.ts` defaults it empty.
--
--
-- ## 3. The audit is as un-erasable as the ledger it authorises deletions from
--
-- An audit that can be deleted is not an audit — it is a note. So this table
-- gets the same two triggers `0015` gives `memory_assertions`: no DELETE ever,
-- and no UPDATE except closing an open window. There is deliberately NO
-- carve-out here and there must never be one. If a deletion could delete its own
-- record, the whole mechanism above collapses to "trust the caller".
--
-- Note the consequence, and accept it: this table grows forever, one row per
-- explicit deletion. That is the smallest thing in this database and the last
-- one that should ever be swept.


-- ---------------------------------------------------------------------------
-- memory_deletions — the record, and the authority. One row per order.
-- ---------------------------------------------------------------------------

CREATE TABLE memory_deletions (
  -- `syl:memory_deletion:<uuidv7>`. Type-prefixed because this id IS referenced
  -- from outside: `memory_deletion_scope` points at it, and every redaction
  -- tombstone left in surviving prose names it so the reader can find out what
  -- happened. A dangling reference to a deletion must stay legible.
  id              TEXT NOT NULL PRIMARY KEY,

  -- WHO. A single permitted literal, on purpose. Constraint 6 binds the system;
  -- this column is the sentence "and it never bound him", written where the
  -- store can enforce it. Adding an authority is a migration.
  instructed_by   TEXT NOT NULL CHECK (instructed_by = 'commander'),

  -- WHERE he said it — `syl:message:<uuid>`, `syl:conversation:<uuid>`. Never
  -- WHAT he said: his words name the thing he asked to forget. See §2.
  instruction_ref TEXT CHECK (instruction_ref IS NULL OR instruction_ref GLOB 'syl:*:*'),

  -- The digest of the PLAN he was shown and approved. `forget.ts` re-plans at
  -- execution time and refuses if this no longer matches, so "he confirmed"
  -- means "he confirmed THIS" rather than "he clicked yes once".
  confirmation    TEXT NOT NULL CHECK (length(confirmation) = 64),

  -- SHA-256 over the material removed. Verifies, never reveals. See §2.3.
  digest          TEXT NOT NULL CHECK (length(digest) = 64),

  -- The shape of what went. Counts, because counts are not content.
  nodes           INTEGER NOT NULL CHECK (nodes >= 0),
  edges           INTEGER NOT NULL CHECK (edges >= 0),
  assertions      INTEGER NOT NULL CHECK (assertions >= 0),
  -- Prose left standing but emptied — surviving inferences and dream-log rows
  -- that quoted the forgotten thing. The number that says the residue was
  -- actually chased rather than assumed absent.
  redactions      INTEGER NOT NULL DEFAULT 0 CHECK (redactions >= 0),

  -- About the OPERATION, not the memory. See §2.
  note            TEXT,

  requested_at    TEXT NOT NULL,
  -- NULL means the authority window is OPEN. `forget.ts` opens and closes it
  -- inside one transaction, so in a consistent database this is never NULL —
  -- and `Forgetting.pending()` exists so a NULL is visible rather than quiet.
  executed_at     TEXT,

  CHECK (id GLOB 'syl:memory_deletion:*' AND length(id) = 56),
  CHECK (executed_at IS NULL OR executed_at >= requested_at)
) STRICT;

-- "What has he ordered forgotten, most recently first?" — the admin read, and
-- the one that answers "is anything half-deleted right now?" from its tail.
CREATE INDEX memory_deletions_recent_idx ON memory_deletions (requested_at DESC, id DESC);

-- The open windows, and nothing else. Partial, so its size is the number of
-- deletions IN FLIGHT — normally zero — rather than the number of rows. This is
-- the index the trigger predicates below ride on, which is what keeps the cost
-- of "may this row be deleted?" independent of how much has ever been deleted.
CREATE INDEX memory_deletions_open_idx ON memory_deletions (id)
  WHERE executed_at IS NULL;


-- ---------------------------------------------------------------------------
-- memory_deletion_scope — exactly which rows, by id. The permission, and the
-- detail of the audit, are the same rows.
-- ---------------------------------------------------------------------------
--
-- **No FOREIGN KEY to `memory_edges` or `memory_assertions`, deliberately.**
-- These rows outlive their targets by design: the entire point is that the
-- target is gone and this is the proof. A foreign key would either forbid the
-- deletion or cascade away the evidence of it. Same argument `0013` makes for
-- the dream log holding graph ids as opaque TEXT.

CREATE TABLE memory_deletion_scope (
  deletion_id TEXT NOT NULL REFERENCES memory_deletions (id),

  -- An opaque `syl:memory_edge:<uuid>` / `syl:memory_assertion:<uuid>` /
  -- `syl:memory_node:<uuid>`. Identifies a row uniquely; says nothing about it.
  target      TEXT NOT NULL CHECK (target GLOB 'syl:*:*'),

  -- Which store the id addresses. `node` is carried for the audit only — nodes
  -- have no BEFORE DELETE trigger, because a node's deletion is already gated
  -- by the edges and assertions that reference it.
  kind        TEXT NOT NULL CHECK (kind IN ('node', 'edge', 'assertion')),

  PRIMARY KEY (deletion_id, target)
) STRICT;

-- The trigger predicate's access path: "is THIS id authorised right now?" is a
-- point lookup on `(target, kind)`, not a scan of everything ever deleted.
CREATE INDEX memory_deletion_scope_target_idx ON memory_deletion_scope (target, kind);


-- ---------------------------------------------------------------------------
-- The audit cannot be erased or rewritten. See §3.
-- ---------------------------------------------------------------------------

CREATE TRIGGER memory_deletions_never_deleted
BEFORE DELETE ON memory_deletions
BEGIN
  SELECT RAISE(
    ABORT,
    'a deletion record is never deleted: it is the only proof that a removal was ordered rather than lost'
  );
END;

CREATE TRIGGER memory_deletion_scope_never_deleted
BEFORE DELETE ON memory_deletion_scope
BEGIN
  SELECT RAISE(
    ABORT,
    'a deletion record is never deleted: its scope is what says which rows went'
  );
END;

-- The only legal update is closing an open window. Re-opening one would hand
-- back a permission that has already been spent.
CREATE TRIGGER memory_deletions_never_rewritten
BEFORE UPDATE ON memory_deletions
WHEN OLD.id <> NEW.id
  OR OLD.instructed_by <> NEW.instructed_by
  OR OLD.confirmation <> NEW.confirmation
  OR OLD.digest <> NEW.digest
  OR OLD.requested_at <> NEW.requested_at
  OR (OLD.executed_at IS NOT NULL AND OLD.executed_at IS NOT NEW.executed_at)
BEGIN
  SELECT RAISE(
    ABORT,
    'a deletion record is never rewritten: only closing an open authority window is allowed'
  );
END;


-- ---------------------------------------------------------------------------
-- The named exception, applied to the two guarded stores
-- ---------------------------------------------------------------------------
--
-- Both triggers keep their original ABORT wording, extended. Every automatic
-- path hits exactly the same refusal it hit yesterday, with the same message,
-- because for every automatic path nothing has changed: none of them opens an
-- authority window, and opening one requires writing an audit row that names a
-- human authority.

DROP TRIGGER memory_edges_inferred_never_deleted;

CREATE TRIGGER memory_edges_inferred_never_deleted
BEFORE DELETE ON memory_edges
WHEN OLD.kind = 'inferred'
 AND NOT EXISTS (
   SELECT 1 FROM memory_deletion_scope s
   JOIN memory_deletions d ON d.id = s.deletion_id
   WHERE s.target = OLD.id AND s.kind = 'edge' AND d.executed_at IS NULL
 )
BEGIN
  SELECT RAISE(
    ABORT,
    'an inferred edge is never deleted, only demoted: move it to the cold or suppressed tier ' ||
    '(the sole exception is the Commander''s explicit order, which opens an audited authority ' ||
    'window naming this exact edge — see 0018_memory_deletions.sql)'
  );
END;


DROP TRIGGER memory_assertions_never_deleted;

CREATE TRIGGER memory_assertions_never_deleted
BEFORE DELETE ON memory_assertions
WHEN NOT EXISTS (
  SELECT 1 FROM memory_deletion_scope s
  JOIN memory_deletions d ON d.id = s.deletion_id
  WHERE s.target = OLD.id AND s.kind = 'assertion' AND d.executed_at IS NULL
)
BEGIN
  SELECT RAISE(
    ABORT,
    'an assertion is never deleted, only superseded: close it and open the new value instead ' ||
    '(the sole exception is the Commander''s explicit order, which opens an audited authority ' ||
    'window naming this exact row — see 0018_memory_deletions.sql)'
  );
END;
