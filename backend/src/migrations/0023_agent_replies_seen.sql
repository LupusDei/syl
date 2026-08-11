-- 0023_agent_replies_seen.sql — which answers from the fleet Syl has already
-- been shown, so one reply reaches the Commander exactly once.
--
-- ## NUMBERING, FOR WHOEVER MERGES THIS
--
-- Written as 0022 and renamed to 0023. 0021 was the highest on ORIGIN, checked
-- immediately before the file was created; `0022_reminder_provenance.sql`
-- landed in the same tree two minutes earlier, from another agent's work in
-- flight. That is the collision CLAUDE.md describes, and it behaved the way it
-- is supposed to: `readMigrations` refused BOTH files by name in one error, so
-- it cost a rename rather than a day.
--
-- Renamed rather than renumbering the other file — it was first, and 0023 is
-- then the lowest free number, which is the rule. A missing HIGHEST number is
-- not a gap, so this is safe to land before or after anything else.
--
-- `readMigrations` requires a contiguous sequence and fails every
-- database-backed test on a gap, so a number claimed from a stale view takes
-- down a suite for a reason its author did not cause. Check ORIGIN, not your
-- branch, and check it again immediately before you write the file.
--
-- ## What this is for
--
-- The poller asks Adjutant "what has been said to Syl" and gets back
-- everything addressed to her, every time — reading is a plain REST call with
-- no server-side cursor. Without a record of what has already been handled,
-- the second poll re-delivers the first poll's answers and his phone buzzes
-- again with the treasurer telling him what his insurance costs.
--
-- ## Why a row per message and not a high-water mark
--
-- The obvious shape is one row per agent holding the newest instant seen, and
-- it is wrong. A watermark is exactly-once only while messages arrive in time
-- order, and they do not have to: two agents write concurrently, one of them
-- retries, and an answer stamped 00:10 shows up after one stamped 00:30. A
-- watermark swallows it in silence — which is CLAUDE.md constraint 4 wearing
-- different clothes, because a vanished answer is a vanished reminder. The
-- reply also cost him money and an agent's time, so losing it is worse than
-- losing a poll.
--
-- Recording the message id costs one small row per answer the fleet ever
-- sends. Answers are rare — she asks, she does not coordinate — so this table
-- grows at the rate of a conversation, not of a log.
--
-- The per-agent cursor `syl-014.3.1` asks for is still here; it is DERIVED
-- (`agent_replies_seen_agent_idx`) rather than mutated in place, so reading
-- "the last thing the treasurer told her" cannot be the thing that loses an
-- answer.
--
-- ## Ordering, and why the id is in the index
--
-- `(agent_id, message_at DESC, message_id DESC)` — the instant alone does not
-- totally order anything. Two answers stamped the same millisecond are
-- ordinary, and "the most recent one" has to mean something rather than
-- depending on page order.
--
-- ## Not synced
--
-- Deliberately absent from `sync_log`'s type CHECK, and no sync trigger. This
-- is a record of what Syl's own poller has handled — telemetry about her
-- plumbing, not the Commander's data — and the phone has no use for it.

CREATE TABLE agent_replies_seen (
  -- Adjutant's id for the message. The unit of exactly-once, and the primary
  -- key rather than a UNIQUE index so the database refuses a duplicate rather
  -- than the code remembering to check.
  message_id TEXT NOT NULL PRIMARY KEY,

  -- Which agent said it, as Adjutant knows them: `treasurer`, `raynor`. Not
  -- constrained to `agents/roster.ts` — the roster is who she may ASK, and it
  -- can change under a row that has already been recorded. A CHECK against a
  -- list that lives in TypeScript is a list in two places, and the one in SQL
  -- is the one nobody remembers to edit.
  agent_id   TEXT NOT NULL,

  -- When the agent said it, per Adjutant. An `Instant`: RFC 3339, UTC.
  message_at TEXT NOT NULL,

  -- When Syl's poller picked it up. Not the same value, and the difference is
  -- the only thing that answers "why did he hear about this an hour late?".
  seen_at    TEXT NOT NULL,

  CHECK (length(message_id) > 0),
  CHECK (length(agent_id) > 0),
  CHECK (length(message_at) > 0),
  CHECK (length(seen_at) > 0)
) STRICT;

-- "What is the last thing this agent told her?" — the derived cursor, and the
-- admin's view of who has answered.
CREATE INDEX agent_replies_seen_agent_idx
  ON agent_replies_seen (agent_id, message_at DESC, message_id DESC);
