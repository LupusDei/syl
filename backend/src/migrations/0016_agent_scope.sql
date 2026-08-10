-- 0016_agent_scope.sql — a third scope, for Syl herself.
--
-- `0014` gave a token a scope of `device | admin` and argued the point that
-- matters: **what makes a scope defensible is not the column, it is where a
-- value can be created.** `POST /auth/pair` always mints `device` and `pair()`
-- takes no scope argument at all, so no future route is one refactor away from
-- accepting one; `admin` comes from a console command that already needs write
-- access to this file, which is full compromise of the machine.
--
-- `agent` is the same statement about a third birthplace. It is minted by the
-- SERVICE, FOR ITSELF, in `bootstrap`, and by nothing else — no HTTP route
-- returns one, no CLI mints one, and the plaintext exists only in the memory of
-- the process that created it. Obtaining one over the network is not a matter
-- of guessing a password or finding a route with a missing guard; there is no
-- code path that emits an agent token to a socket at all.
--
--   device  POST /auth/pair. Network-reachable, gated on eight digits that
--           live for ten minutes.
--   admin   `npm run pair -- --admin`, at the machine's own console.
--   agent   the service itself, at boot, into this table. Never returned.
--
-- ## What she may reach, which is the actual content of the scope
--
-- Reminders, to-dos and goals — the product's own nouns, and the ones she was
-- given hands for. Not `/logs`: that is the record of everything she DID on the
-- Commander's machine, and an assistant that can read and edit her own audit
-- trail is not auditable. Not `/devices`, and not pairing: a credential that
-- can pair another device can mint itself a `device` key and step around this
-- table entirely. The confinement is in `middleware/auth.ts`; this file only
-- makes the value expressible.
--
-- ## Why this rebuilds the table instead of altering it
--
-- SQLite has no `ALTER TABLE ... DROP CONSTRAINT`, and a CHECK cannot be
-- widened in place. The documented alternative is the twelve-step rebuild:
-- create, copy, drop, rename, recreate the indexes. It is a heavier operation
-- than everything before it in this directory and every way it goes wrong is
-- silent, so three things are worth stating rather than leaving to a reader:
--
-- 1. **The column list is spelled out on both sides.** `INSERT INTO x SELECT *`
--    depends on the physical column order matching, and this table's order is
--    an accident of history — `pairing_code_id` was appended by `0011` and
--    `scope` by `0014`, so the order is not the order `0002` declares. A
--    positional copy that silently transposed two TEXT columns would put a
--    device name in a token hash and nothing would raise.
-- 2. **Every index is recreated, and `api_keys_pairing_code_idx` is the one
--    that matters.** `DROP TABLE` takes a table's indexes with it. `0011` puts
--    the single-use guarantee for a pairing code in that UNIQUE index and
--    explicitly not in TypeScript; a rebuild that forgot it would remove the
--    guarantee, break no test that was looking elsewhere, and be discovered by
--    a replayed pairing code minting a second key.
-- 3. **Nothing references `api_keys`.** The only foreign key on it points
--    outward, at `pairing_codes`. So the drop cannot orphan a child row, and
--    the rename cannot rewrite a reference in another table's DDL — which is
--    what would otherwise make this operation unsafe inside the runner's
--    transaction, where `PRAGMA foreign_keys` is a no-op.
--
-- ## Nothing backfills
--
-- Existing rows keep the scope they have. `0014` made the same call for the
-- same reason and it is worth repeating: widening an existing credential is
-- invisible, because nothing fails. Every key that was `device` yesterday is
-- `device` after this runs, and the first `agent` row in any database is the
-- one the service writes for itself on the next boot.

CREATE TABLE api_keys_rebuilt (
  id             TEXT NOT NULL PRIMARY KEY,
  token_hash     TEXT NOT NULL UNIQUE,
  token_suffix   TEXT NOT NULL,
  device_name    TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  expires_at     TEXT,
  last_used_at   TEXT,
  revoked_at     TEXT,
  revoked_reason TEXT,
  pairing_code_id TEXT REFERENCES pairing_codes (id) ON DELETE SET NULL,
  scope          TEXT NOT NULL DEFAULT 'device'
                 CHECK (scope IN ('device', 'admin', 'agent'))
) STRICT;

INSERT INTO api_keys_rebuilt
  (id, token_hash, token_suffix, device_name, created_at, expires_at,
   last_used_at, revoked_at, revoked_reason, pairing_code_id, scope)
SELECT
   id, token_hash, token_suffix, device_name, created_at, expires_at,
   last_used_at, revoked_at, revoked_reason, pairing_code_id, scope
FROM api_keys;

DROP TABLE api_keys;

ALTER TABLE api_keys_rebuilt RENAME TO api_keys;

-- All three, exactly as the migrations that introduced them spelled them.
-- Listing keys for an admin screen: live ones first, newest first (0002).
CREATE INDEX api_keys_revoked_created_idx
  ON api_keys (revoked_at, created_at DESC);
-- One pairing code mints at most one key (0011). The single-use guarantee.
CREATE UNIQUE INDEX api_keys_pairing_code_idx ON api_keys (pairing_code_id);
-- "Is there a key of this scope on this machine, and is it still live" (0014),
-- which is now also the question `ensureAgentKey` asks on every boot.
CREATE INDEX api_keys_scope_idx ON api_keys (scope, revoked_at);
