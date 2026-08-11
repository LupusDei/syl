-- 0024_working_memory_budget.sql — raise the working-memory ceiling from
-- 4,096 to 32,768 bytes.
--
-- ## Why this migration has to exist at all
--
-- `0019` wrote the budget into the schema on purpose, and that decision was
-- right: the CHECK is the backstop under `working.ts`, so a code path that
-- forgot to fit fails loudly instead of letting the projection silently go
-- dark. The cost of that correctness is exactly this file — the constant
-- cannot move on its own. Raising `WORKING_MEMORY_MAX_BYTES` to 32,000 without
-- this migration would produce a fitter that packs 32 KB and a database that
-- refuses to store it, and the failure would land on the first projection to
-- grow past 4 KB rather than in any test that merely reads the constant.
--
-- ## Why the number moved
--
-- Measured against the live graph on 2026-08-11 (`syl-ulf`): the 4,000-byte
-- budget admitted 23 of 30 nodes and dropped the Commander's own name, his
-- wife, his son and his daughter. `0019`'s argument reasoned in "distilled
-- lines" — but nothing distils, so entries are the raw body truncated at 160
-- characters, and the real ceiling was ~25 entries. A budget sized for fifty
-- thousand memories could not hold thirty.
--
-- Raised on the Commander's explicit order, 2026-08-11, with the recurring
-- per-turn cost accepted and the rollback path named: if it proves expensive,
-- the number comes back down. This is a STOPGAP. The real fixes are
-- distillation (so entries are summaries rather than truncations) and a
-- salience signal that is not a constant (`syl-5co`) — a bigger budget filled
-- by a broken ranker is simply more of the wrong things, in recency order.
--
-- ## Why the ceiling is 32,768 and not 32,000
--
-- The same relationship `0019` had: `working.ts` fits to 32,000 and names what
-- did not fit inside the text; this CHECK is the backstop above it. Leaving
-- headroom between the two is what makes a disagreement between code and
-- schema a loud write failure rather than a boundary both sides sit exactly
-- on.
--
-- NOT a MEMORY.md concern: this text reaches a turn through
-- `--append-system-prompt` (`harness/session.ts`), not through Claude Code's
-- auto-memory index, so `syl-03d`'s 25 KB silent-truncation cliff does not
-- apply to it. That cliff is why the budget is enforced at all; it is not a
-- ceiling on this particular number.
--
-- ## Why a table rebuild
--
-- SQLite cannot ALTER a CHECK constraint. The twelve-step procedure reduces to
-- four here because `working_memory` carries no indexes, no triggers, no
-- foreign keys in either direction, and is deliberately absent from `sync_log`
-- — verified against the live database before writing this. The row is copied
-- column-for-column; `id = 1` keeps it a projection rather than a history.

CREATE TABLE working_memory_new (
  -- One row. See `0019`: this is what makes it a projection and not a store.
  id            INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),

  -- The rendered projection, exactly as it is prepended to a turn.
  text          TEXT    NOT NULL,

  -- SHA-256 of `text`. Regeneration compares digests and writes nothing when
  -- the graph has not moved, which is what keeps `generated_at` meaningful.
  digest        TEXT    NOT NULL,

  bytes         INTEGER NOT NULL,
  lines         INTEGER NOT NULL,

  -- How many hot nodes made it in, and how many were named as not fitting.
  included      INTEGER NOT NULL,
  dropped       INTEGER NOT NULL,

  generated_at  TEXT    NOT NULL,

  -- The only line that changed. 4096 -> 32768.
  CHECK (bytes > 0 AND bytes <= 32768),
  CHECK (lines > 0),
  CHECK (included >= 0 AND dropped >= 0),
  CHECK (length(trim(text, char(32, 9, 10, 13))) > 0)
) STRICT;

INSERT INTO working_memory_new (
  id, text, digest, bytes, lines, included, dropped, generated_at
)
SELECT id, text, digest, bytes, lines, included, dropped, generated_at
FROM working_memory;

DROP TABLE working_memory;

ALTER TABLE working_memory_new RENAME TO working_memory;
