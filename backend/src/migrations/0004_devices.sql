-- 0004_devices.sql — push targets, and the idempotency ledger every write uses.
--
-- Two tables that look unrelated and arrive together because the first write
-- endpoint Syl gains (`POST /devices`) is also the first one the contract
-- requires an `Idempotency-Key` on. The mobile client keeps a local outbox and
-- retries by design; without a ledger the first retry registers a second row
-- for the same phone, and the second phone is the one that stops getting
-- reminders.

CREATE TABLE devices (
  id            TEXT    NOT NULL PRIMARY KEY,
  platform      TEXT    NOT NULL CHECK (platform IN ('ios')),

  -- Per token, never a server-wide setting. Xcode-installed builds always
  -- produce sandbox tokens; TestFlight and App Store builds always produce
  -- production ones, and during development both exist at once. A global
  -- setting therefore breaks one of them, and the only symptom is
  -- `BadDeviceToken` on every send — no log line, no exception, no delivery.
  environment   TEXT    NOT NULL CHECK (environment IN ('sandbox', 'production')),

  -- The full APNs token. It is a credential for pushing to his phone, so it
  -- lives here and is never returned by a read endpoint; `token_suffix` is what
  -- goes on the wire.
  token         TEXT    NOT NULL UNIQUE,
  token_suffix  TEXT    NOT NULL,

  name          TEXT    NOT NULL,
  app_version   TEXT    NOT NULL,
  os_version    TEXT    NOT NULL,

  -- Set to 0 on APNs 410 or BadDeviceToken. Dead tokens are unregistered
  -- reactively rather than accumulating and being retried forever.
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),

  registered_at TEXT    NOT NULL,
  last_seen_at  TEXT    NOT NULL
) STRICT;

-- The send path asks exactly one question: which tokens are live?
CREATE INDEX devices_active_idx ON devices (active, registered_at DESC);

-- The idempotency ledger.
--
-- The key is the primary key on its own rather than being scoped to an
-- endpoint. A client that reuses one key across two different requests has a
-- bug, and the contract's answer is 409 — which is only possible if reuse is
-- visible, and it is invisible if the endpoint is part of the key.
--
-- `fingerprint` covers method, path and body, so a byte-identical retry
-- replays the stored response and anything else is a conflict.
CREATE TABLE idempotency_keys (
  key           TEXT    NOT NULL PRIMARY KEY,
  fingerprint   TEXT    NOT NULL,
  status        INTEGER NOT NULL,
  response_json TEXT    NOT NULL,
  created_at    TEXT    NOT NULL
) STRICT;

-- Keys are retained for 24 hours, so pruning walks them by age.
CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);
