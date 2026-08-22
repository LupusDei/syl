-- 0036_face_sessions.sql — the ledger behind her live face (`syl-chzl.3.3`).
--
-- One row per Runway `gwm1_avatars` realtime session: when it opened, when and
-- HOW it ended, what it cost, and the one credential that may speak to it.
--
-- ## Why a table and not a Map in the broker
--
-- Two questions need an answer that outlives the process.
--
-- **"Has today's ceiling been reached?"** `face-cost-guard.ts` holds the
-- rolling tally in memory, which is right for a guard that has to be pure and
-- exhaustively testable — and completely wrong as the only copy. A crash at
-- noon would hand the afternoon a fresh $3, and a crash loop would hand it one
-- per restart. The guard is seeded from `creditsOnDayOf` at boot; this table is
-- the thing that makes the ceiling real.
--
-- **"What is still open?"** A face bills by the second whether or not anybody
-- is looking at it. If the process dies with a session live, the only record
-- that it EXISTS is here — and a session nothing knows about is precisely the
-- silent leak the idle reaper was given its own task to prevent. `closed_at IS
-- NULL` after a restart is the recovery query, and it is why the partial index
-- below exists.
--
-- ## The id is Runway's, not ours
--
-- Every other table in this schema uses `syl:<type>:<uuidv7>`. This one does
-- not, and the reason is that the row is a record OF a provider session rather
-- than an entity of Syl's own. Its whole purpose is to be joinable to what
-- Runway billed, and a second identifier would mean every question about money
-- goes through a translation table that can drift. A row is created only after
-- a successful create call, so the id always exists by the time there is
-- anything to record.
--
-- ## `ended` is four values, and none of them is "not closed"
--
-- `closed` (he hung up), `reaped` (the idle auto-disconnect cut it), `expired`
-- (it hit the provider's session cap) and `failed` (it was created, charged,
-- and never reached READY). NULL means still open, and that is a different
-- statement from any of the four.
--
-- Distinguishing `reaped` from `closed` is not bookkeeping pedantry: it is the
-- only evidence that the auto-disconnect is doing its job. A month of `closed`
-- rows and no `reaped` ones means either he is diligent or the reaper is dead,
-- and those must not look the same.
--
-- `failed` exists for the conservative-accounting rule: Runway charges the
-- upfront credits at create, so a session that never readies still cost real
-- money and the ledger says so. A row that recorded nothing because the session
-- did not work would under-report spend, and a cost guard that under-reports is
-- worse than no cost guard, because it claims a safety it has not verified.
--
-- ## Why the ask_syl credential lives HERE
--
-- `ask_secret_hash` is the SHA-256 of the per-session secret the avatar's
-- backend RPC tool must present. It is a column of the session rather than a
-- row in `api_keys`, and that is the security argument rather than a storage
-- convenience:
--
--   * **It expires with the session, structurally.** There is no sweeper to
--     run and no TTL to remember. Settling the session is what invalidates the
--     credential, because the credential is a field of the thing being settled.
--   * **It cannot be minted.** `POST /auth/pair` writes `api_keys`; nothing in
--     this schema lets an HTTP caller write `face_sessions`. The only way one
--     of these exists is that the broker created a provider session and paid
--     for it.
--   * **It is not a scope.** A `device` or `admin` key is a standing credential
--     for the Commander's own data with a Principal behind it. This is a
--     one-purpose token for a machine, alive for minutes. Reusing the scope
--     column would have put a five-minute machine credential in the same table
--     as the key on his phone, and the first person to widen a scope check
--     would have joined them.
--
-- Only the HASH is stored, the same rule `api_keys` follows: a copy of `syl.db`
-- must contain nothing that can be presented to the service.
--
-- ## Spend is attributed to the day a session OPENED
--
-- A session that opens at 23:58 and closes at 00:04 counts entirely against the
-- day it began. The alternative — splitting it — needs per-block accounting the
-- provider does not give us, and attributing it to the close day would let a
-- session opened just before midnight escape the ceiling it was opened under.
-- The in-memory guard rolls at midnight regardless, so the two disagree for one
-- session per day at most; both are bounded and neither can lose spend.

CREATE TABLE face_sessions (
  -- Runway's realtime-session id. See the header: deliberately not `syl:…`.
  id                TEXT NOT NULL PRIMARY KEY CHECK (length(trim(id)) > 0),

  -- Which avatar spoke. Recorded because the likeness is still being chosen
  -- (`syl-chzl.6`), so "what did the session that used THAT face cost" is a
  -- question with a future.
  avatar_id         TEXT NOT NULL CHECK (length(trim(avatar_id)) > 0),

  opened_at         TEXT NOT NULL,
  -- NULL while the session is live. Set exactly once, with `ended`.
  closed_at         TEXT,

  -- Everything charged for this session so far, upfront included. Updated on
  -- settle to the whole-session total, never incremented by the streaming
  -- portion alone -- one row, one number, no arithmetic to get wrong twice.
  credits           INTEGER NOT NULL CHECK (credits >= 0),
  dollars           REAL NOT NULL CHECK (dollars >= 0),

  -- NULL while open. See the header for why there are four.
  ended             TEXT CHECK (ended IN ('closed', 'reaped', 'expired', 'failed')),

  -- What the idle reaper reads. Moved forward by every ask_syl call.
  last_activity_at  TEXT NOT NULL,

  -- SHA-256 of the per-session ask_syl secret, hex. Never the secret itself.
  ask_secret_hash   TEXT NOT NULL CHECK (length(trim(ask_secret_hash)) > 0),
  -- The credential's hard stop, independent of the row being settled. Belt and
  -- braces: a session whose settle never ran must not leave a live credential.
  ask_expires_at    TEXT NOT NULL,

  -- `closed_at` and `ended` are one fact written in two columns, so the schema
  -- refuses the two states where they disagree: a row closed without saying how,
  -- and a row that says how while claiming to still be open.
  CHECK ((closed_at IS NULL) = (ended IS NULL))
) STRICT;

-- The recovery query, and the reaper's sweep: everything still open, oldest
-- first. Partial, because the interesting set is tiny and permanently so while
-- the settled set grows forever.
CREATE INDEX face_sessions_live_idx
  ON face_sessions (opened_at, id)
  WHERE closed_at IS NULL;

-- The day's total, for seeding the ceiling at boot. Range-scanned on the
-- ISO-8601 prefix, which sorts lexically exactly because instants are stored
-- UTC with a literal Z.
CREATE INDEX face_sessions_day_idx
  ON face_sessions (opened_at);
