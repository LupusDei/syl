-- 0014_api_key_scope.sql — what a bearer token is allowed to ask for.
--
-- Until now every token could reach every route. That was defensible while the
-- contract held to-dos, reminders and conversations: everything on it is the
-- Commander's own data, and every token speaks for the Commander.
--
-- `GET /logs` breaks that symmetry. The log is not *his data*; it is the record
-- of what Syl DID on his machine, running pre-authorised — every tool call,
-- every turn, every command. A stolen phone, or a pairing code read over a
-- shoulder, must not turn into a transcript of the machine's activity. So the
-- token gains a scope, on the table that already exists, rather than a second
-- authentication mechanism beside it.
--
-- ## Two values, and the difference between them is where they can be minted
--
--   device  POST /auth/pair mints this. Network-reachable, gated on eight
--           digits that live for ten minutes.
--   admin   `npm run pair -- --admin` mints this, at the machine's own
--           console, and no HTTP route can. Obtaining one requires write
--           access to syl.db, which is already full compromise.
--
-- The scope is therefore not a permission an attacker can escalate into over
-- the network; it is a statement about which side of the loopback boundary the
-- credential was created on.
--
-- ## Why existing rows become `device`
--
-- Least privilege, and it is the safe direction of the two. Backfilling to
-- `admin` would silently hand the new surface to every phone already paired —
-- exactly the outcome this migration exists to prevent — and would do it
-- invisibly, because nothing would fail. Backfilling to `device` costs one
-- command at the console the first time the admin wants the logs view, which
-- is a cost that announces itself.
--
-- CHECK rather than an application-level enum: a STRICT table already refuses
-- the wrong type, and a scope is exactly the column where a typo ("Admin",
-- "adminstrator") must fail at the write rather than at the comparison. A
-- comparison against an unknown value denies access, which is safe — and then
-- looks like a bug in the middleware, which is expensive.

ALTER TABLE api_keys
  ADD COLUMN scope TEXT NOT NULL DEFAULT 'device'
  CHECK (scope IN ('device', 'admin'));

-- Answering "is there an admin key on this machine, and is it still live" is
-- what the console command needs before it offers to mint another.
CREATE INDEX api_keys_scope_idx ON api_keys (scope, revoked_at);
