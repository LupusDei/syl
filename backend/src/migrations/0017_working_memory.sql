-- 0017_working_memory.sql — the working-memory projection, and the uniqueness
-- that makes a projected handle a handle.
--
-- ## Working memory is NOT a fourth store
--
-- The master plan's §4 lists four stores and was never amended; Proposal A §5
-- corrects it, and this file follows the correction. **Working memory is a
-- PROJECTION of the graph's hot region** — distilled nightly, small enough to
-- load into every turn, and thrown away and rebuilt rather than appended to.
--
-- Read only the master plan and you will build a fourth store. It will look
-- right, it will pass review, and within a month it will be the authority on
-- facts the graph has since changed, because a store accumulates and a
-- projection does not.
--
-- ## Why one row, enforced by a CHECK
--
-- `CHECK (id = 1)` is the entire argument made structural. A projection that
-- can only ever be ONE ROW cannot quietly become a history table:
--
--   - There is no `INSERT` that grows it. Regeneration is an UPSERT onto row 1.
--   - There is nothing to page, nothing to prune, and no "latest" query that
--     could accidentally read a stale generation.
--   - "Regenerated, not accumulated" is a property of the schema rather than a
--     rule somebody has to remember while adding a column.
--
-- The alternative — one row per generation, with a `current` flag or a
-- timestamp ordering — is how every accumulating store starts, and it is
-- exactly the shape this bead exists to refuse.
--
-- ## Why the byte ceiling is a CHECK and not a comment
--
-- This text is prepended to EVERY turn. That is the same cliff the auto-memory
-- index fell off (`syl-03d`): past a size limit the thing stops being loaded
-- and **nothing says so**. A projection that silently stopped being loaded
-- would look exactly like a projection that was working, because Syl would
-- still answer — just without knowing who she was talking to.
--
-- So the budget is written down where it cannot be skipped. `working.ts` fits
-- entries into {@link WORKING_MEMORY_MAX_BYTES} (4,000) and names in the text
-- itself anything that did not fit; this CHECK is the backstop at 4,096 for a
-- code path that forgot to fit. If the two ever disagree, the write fails
-- loudly instead of the projection silently going dark.
--
-- ## Not synced
--
-- Deliberately absent from `sync_log`'s type CHECK, and no sync trigger. A
-- nightly regeneration would otherwise push a full-text row to every device
-- every night, and the projection is Syl's own prompt preamble — not the
-- Commander's data.

CREATE TABLE working_memory (
  -- One row. See the header: this is what makes it a projection.
  id            INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),

  -- The rendered projection, exactly as it is prepended to a turn.
  text          TEXT    NOT NULL,

  -- SHA-256 of `text`. Regeneration compares digests and writes nothing when
  -- the graph has not moved, which is what keeps `generated_at` meaningful:
  -- it is when the projection last CHANGED, not when a job last ran.
  digest        TEXT    NOT NULL,

  bytes         INTEGER NOT NULL,
  lines         INTEGER NOT NULL,

  -- How many hot nodes made it in, and how many were named as not fitting.
  -- `dropped` is reported in the text too; a projection never drops silently.
  included      INTEGER NOT NULL,
  dropped       INTEGER NOT NULL,

  generated_at  TEXT    NOT NULL,

  CHECK (bytes > 0 AND bytes <= 4096),
  CHECK (lines > 0),
  CHECK (included >= 0 AND dropped >= 0),
  CHECK (length(trim(text, char(32, 9, 10, 13))) > 0)
) STRICT;

-- ## One handle per life-model row
--
-- Proposal B: every life-model row projects into the graph as a node carrying
-- exactly `{ id, type, label, ref }`. "A row is the record. A node is the
-- handle." Two handles for one row is two answers to "which node addresses
-- this goal?", and the loser drifts silently — it keeps whatever label it had
-- when it was written and nothing ever errors.
--
-- Regeneration in `projection.ts` looks a handle up by `(subject_id, kind)`
-- before writing, so it never creates a second one. This index is what makes
-- that a fact about the database rather than a property of one code path: a
-- concurrent regeneration, a retry, or a future second call site all hit a
-- UNIQUE violation instead of quietly forking the handle.
--
-- **Partial on the kinds a projector actually mints**, and no wider. A
-- life-model row of type `goal` projects to a node of kind `goal`; an intake
-- source projects to one of kind `source`. It must NOT cover `memory`, `fact`
-- or `event`: many memories about one goal is the normal, intended state of
-- the graph, and a unique index over those kinds would forbid the graph from
-- knowing more than one thing about anything. Adding a projector for a new
-- kind means widening this index in a new migration — deliberately, in SQL,
-- where the decision is visible.
CREATE UNIQUE INDEX memory_nodes_handle_idx
  ON memory_nodes (subject_id, kind)
  WHERE subject_id IS NOT NULL AND kind IN ('goal', 'source');
