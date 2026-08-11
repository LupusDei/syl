-- 0002_api_keys.sql — the bearer tokens that reach Syl's API.
--
-- There is exactly one principal. This table is not a user table and must not
-- grow into one: it records *devices that have been paired*, each holding a
-- token that speaks for the Commander. The allowlist is the trust boundary.
--
-- The token itself is never stored. `token_hash` is the SHA-256 of it, and
-- that is what lookup happens by, so a stolen database yields nothing that can
-- be presented to the API. `token_suffix` exists purely so an admin screen can
-- say which key it is showing without the row containing anything usable.
--
-- Revocation is a timestamp rather than a delete: "which device was this, and
-- when did we cut it off" is a question worth being able to answer after the
-- fact, and a deleted row answers nothing.

CREATE TABLE api_keys (
  id             TEXT NOT NULL PRIMARY KEY,
  token_hash     TEXT NOT NULL UNIQUE,
  token_suffix   TEXT NOT NULL,
  device_name    TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  expires_at     TEXT,
  last_used_at   TEXT,
  revoked_at     TEXT,
  revoked_reason TEXT
) STRICT;

-- Listing keys for an admin screen: live ones first, newest first.
CREATE INDEX api_keys_revoked_created_idx
  ON api_keys (revoked_at, created_at DESC);
