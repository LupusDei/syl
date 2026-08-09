-- 0009_pairing_codes.sql — the short-lived secret a device is paired with.
--
-- ## Why this is a table and not a field on the service object
--
-- It used to be neither: `ApiKeyService` held the live code in a private
-- field, and the comment there argued that keeping a credential off disk was
-- the whole point. That argument is sound and it does not survive contact with
-- how the Commander actually pairs a phone.
--
-- The service runs under launchd. To pair, he needs a code *now*, on a machine
-- where the service is already running — so the thing that issues the code is
-- a second process (`npm run pair`), and a second process cannot reach into
-- the first one's memory. The database file is the only medium the two share.
-- An in-memory code also dies on every restart, and launchd's `KeepAlive`
-- restarts this service for reasons that have nothing to do with pairing.
--
-- So the code goes on disk, and the obligation is to put it there in a form
-- that is worth having.
--
-- ## `code_hash` is scrypt, not SHA-256
--
-- Eight digits is 10^8 possibilities. A SHA-256 of one is reversible in
-- seconds on any machine that can read this file, which would turn read access
-- to `syl.db` — which yields no usable credential today, because `api_keys`
-- stores only hashes of high-entropy tokens — into the ability to mint one.
--
-- scrypt with N=16384 costs about 40ms per guess. That is 133 single-core
-- years for the full space against a code that is dead in ten minutes, and it
-- doubles as the rate limit on the unauthenticated `POST /auth/pair`: nobody
-- gets more than ~24 guesses a second out of this service no matter how they
-- ask.
--
-- ## Single use is a UNIQUE index, not a code path
--
-- `api_keys.pairing_code_id` is UNIQUE. **One pairing code can mint at most
-- one key, and the store is what says so** — not a check-then-write in
-- TypeScript that a second process, a retry, or a future refactor can slip
-- past. Redemption also runs `UPDATE ... WHERE redeemed_at IS NULL` inside the
-- same transaction as the INSERT, so the ordinary path never reaches the
-- constraint; the constraint is there for the day something does.
--
-- SQLite treats NULLs as distinct in a UNIQUE index, so the many keys minted
-- without a pairing code (the console bootstrap path) do not collide.
--
-- Rows are kept for a day after they die, so "that code has already been used"
-- and "that code has expired" stay answerable for exactly as long as the
-- Commander might still be holding the slip of paper. `ON DELETE SET NULL`
-- lets that purge happen without disturbing the keys it granted.

CREATE TABLE pairing_codes (
  id          TEXT NOT NULL PRIMARY KEY,
  -- scrypt(code, salt), hex. The code itself never touches disk.
  code_hash   TEXT NOT NULL,
  salt        TEXT NOT NULL,
  issued_at   TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  redeemed_at TEXT,
  -- A code cannot have been redeemed before it was issued. Cheap, and it makes
  -- a clock that ran backwards visible as a constraint failure rather than as
  -- a pairing that silently looks fine.
  CHECK (redeemed_at IS NULL OR redeemed_at >= issued_at)
) STRICT;

-- The lookup redemption does: the handful of codes that are still worth
-- comparing against, newest first.
CREATE INDEX pairing_codes_issued_idx ON pairing_codes (issued_at DESC);

ALTER TABLE api_keys
  ADD COLUMN pairing_code_id TEXT REFERENCES pairing_codes (id) ON DELETE SET NULL;

-- The constraint the whole scheme rests on. See the note above.
CREATE UNIQUE INDEX api_keys_pairing_code_idx ON api_keys (pairing_code_id);
