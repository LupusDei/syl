-- 0025_memory_provenance.sql — where a remembered fact CAME FROM: his words,
-- and the step from his words to the thing she filed. `syl-016.5`.
--
-- Her diagnosis, and it is the whole bead:
--
--     "The reasoning is gone and only the residue is filed."
--
-- She keeps conclusions and loses why. A memory that cannot say where it came
-- from cannot be CORRECTED by him — he can tell her a fact is wrong, and he can
-- never tell her she reasoned wrongly from something true. Those are different
-- repairs and only one of them was available.
--
--
-- ## 1. This is `syl-y82` one layer down
--
-- `remind_me` REQUIRED a `because` since it shipped, refused the call without
-- one, and then dropped it on the floor. artanis found the damage the only way
-- it could be found: reading the store while chasing something else, seeing a
-- reminder with a message already drafted, and telling the Commander nobody had
-- asked her for it. He had asked.
--
-- Extraction had the same shape. `saidIn` already pointed at the message that
-- asserted the fact, and what reached the graph was the sentence with
-- `(said in syl:message:…)` glued onto the end of it — plumbing smeared through
-- the fact's own text, no words, no reasoning. The exchange was in front of the
-- turn and none of it was kept.
--
--
-- ## 2. The asymmetry, which is the lesson and not a detail
--
-- `syl-y82`'s `origin` column is asymmetric on purpose: DERIVE what can be
-- derived, and let her DECLARE only what cannot be checked. Three columns here,
-- and the split is the point:
--
--   said_in   DERIVED. `asExtraction` has already checked the ordinal against
--             the exact transcript the turn was shown, so the service reads the
--             message id out of that transcript. The turn never says it.
--   quote     DERIVED. HIS OWN WORDS, taken from the same message. Never asked
--             for and never echoed back, so it cannot be fabricated, cannot
--             drift from what he said, and cannot be transcribed wrong. A quote
--             the model supplies is a claim; a quote the service copies is
--             evidence.
--   why       DECLARED. How she got from those words to this fact. Nothing can
--             check it — it is a claim about a step of reasoning, not about the
--             world — so it is bound by the rule that covers `finish_todo`
--             rather than the one that covers `urgentBecauseHeSaid`: where
--             evidence cannot be compared, make the consequence SAYABLE, and
--             say it.
--
-- The three travel together or not at all, and the CHECK below enforces it.
-- That is the structural half of the `syl-y82` repair: you cannot file the
-- conclusion while dropping the reason, because the row will not go in.
--
--
-- ## 3. Why a table beside the graph, and not a column on the edge
--
-- The obvious home is the `stated` edge from the conversation to the fact —
-- that edge IS the assertion. It cannot be, and the reason is worth keeping:
-- `0012_memory_core.sql` CHECKs that an `observed` edge has `reasoning IS
-- NULL`, because reasoning is what makes an edge an INFERENCE. Widening that
-- CHECK to fit this would blur the two species the graph is built on, and the
-- cheap frequent path would gain the ability to look like the speculative one.
-- Extraction files observations. It keeps that property here.
--
-- Nor a column on `memory_nodes`. Provenance is per ASSERTION, not per node: a
-- fact he states in March and again in August is one node with two provenances,
-- and a column would hold only whichever arrived first.
--
-- So: one row per (fact node, extraction). The grain of the `memory_extractions`
-- ledger, which is the grain at which an exchange was actually judged.
--
--
-- ## 4. The residue rule, made structural
--
-- CLAUDE.md constraint 6's exception says his explicit order REMOVES a memory,
-- and warns exactly about this table's shape: *"the residue is real, because an
-- inference's reasoning text can quote what it reasoned over."* This table does
-- not merely quote what it reasoned over — it is literally his sentences.
--
-- A new store holding his words is a new place a deletion has to remember to
-- reach, and `0020_memory_deletions.sql` already made the case that a guarantee
-- held by somebody remembering is not a guarantee. So it is not remembered:
--
--   * `node_id` is `REFERENCES memory_nodes (id) ON DELETE CASCADE`, and
--     `PRAGMA foreign_keys` is ON (`services/database.ts` sets it and then
--     reads it back). Deleting the node takes his words with it, through the
--     authorised path in `forget.ts` and through any path added later.
--   * `digest` cascades from `memory_extractions` for the same reason: forget
--     the exchange, forget what was reasoned out of it.
--
-- There is deliberately NO never-deleted trigger here, and that is the opposite
-- of an oversight. Constraint 6 protects him from a system that quietly forgets
-- and never from his own authority over his own data; a guard here would make
-- his words the one thing he could not order removed.
--
--
-- ## 5. Not synced
--
-- Absent from `sync_log`'s type CHECK and given no sync trigger, like
-- `memory_extractions` above it. This is the record of Syl's own filing.

CREATE TABLE memory_provenance (
  -- The fact this is the provenance OF. Cascades: see §4.
  node_id    TEXT NOT NULL REFERENCES memory_nodes (id) ON DELETE CASCADE,

  -- The extraction it came out of — the SHA-256 of the transcript the turn was
  -- actually shown, which is also the unit of idempotence. Cascades: see §4.
  digest     TEXT NOT NULL REFERENCES memory_extractions (digest) ON DELETE CASCADE,

  -- DERIVED. The Commander's message that asserted it, resolved by the service
  -- from the ordinal `asExtraction` already checked. A row in `messages`, so
  -- "where did she get that?" is a lookup rather than a search.
  said_in    TEXT NOT NULL,

  -- DERIVED. His words, copied out of that message. Bounded, because a pasted
  -- article is a legitimate message and this table is not a second copy of the
  -- conversation; `extract-apply.ts` owns the bound and marks a shortened quote
  -- so a truncation is never mistaken for the end of a sentence.
  quote      TEXT NOT NULL,

  -- DECLARED. How the turn got from those words to this fact. The one column
  -- here that is a model's claim rather than a copy, which is why it is the one
  -- the Commander is being handed something to argue with.
  why        TEXT NOT NULL,

  created_at TEXT NOT NULL,

  -- One provenance per fact per exchange. Re-applying the same digest is
  -- stopped by the ledger long before it reaches here; this is the store
  -- saying so rather than a service being trusted to.
  PRIMARY KEY (node_id, digest),

  CHECK (node_id GLOB 'syl:memory_node:*' AND length(node_id) = 52),
  CHECK (length(digest) = 64),
  CHECK (said_in GLOB 'syl:message:*'),

  -- Explicit character set, for the reason `0012` spells out: SQLite's
  -- one-argument `trim` strips SPACES ONLY, so a quote of "\n" would satisfy
  -- `trim(quote) <> ''` and be blank on every screen that shows it.
  CHECK (length(trim(quote, char(32, 9, 10, 13))) > 0),
  CHECK (length(trim(why, char(32, 9, 10, 13))) > 0)
) STRICT;

-- "What did this exchange conclude, and out of what?" — the audit view beside
-- `memory_extractions_conversation_idx`, and the query a deletion pass runs
-- when it is working from an exchange rather than from a node. The primary key
-- already leads with `node_id`, which is the other direction: "where did this
-- fact come from?"
CREATE INDEX memory_provenance_digest_idx ON memory_provenance (digest);
