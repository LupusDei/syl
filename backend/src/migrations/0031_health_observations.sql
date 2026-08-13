-- 0031_health_observations.sql — the observation store, and the column that is
-- deliberately not here.
--
-- `syl-t9tj.2.1`. Three tables: the measurements themselves, where each type's
-- upload got to, and what the phone was ALLOWED to read when it read.
--
--
-- ## There is no `memory_node_id`, and the absence IS the enforcement
--
-- Nothing in this file references `memory_nodes`. No foreign key, no id column,
-- no join table, and `memory/schema.ts` gains no health kind. A health sample
-- must be *unable* to become a node, and the only version of that which survives
-- a pull request that looks unrelated is one where there is nothing to misuse.
--
-- The reason is arithmetic rather than taste. The live memory graph holds about
-- **30 nodes**. One week of HealthKit samples is **tens of thousands**. Salience
-- ranks over incident edge weight and node kind, so dropping 50,000 measurements
-- into the graph destroys every ranking the working-memory projection depends
-- on: **his wife would be evicted by his step count.**
--
-- That is `syl-ulf` arriving through a new door. `syl-ulf` dropped the
-- Commander's own name, his wife, his son and his daughter out of the document
-- Syl reads every turn, and it was invisible until somebody measured the live
-- graph instead of reading the code. `syl-t9tj.2.5` is the test that measures it
-- here, on the real shape after a real upload, for exactly that reason.
--
-- Conclusions *drawn from* these rows do belong in the graph — `kind: "memory"`,
-- through `remember()`, with reasoning naming the window. Tens of them, judged,
-- not tens of thousands, copied. That path adds no column here either: it reads
-- this store and writes that one, and the direction never reverses.
--
--
-- ## Constraint 6 does NOT bind these rows
--
-- Stated because the never-delete rule is written down everywhere else in this
-- codebase, and the next reader will otherwise apply it to a table growing
-- 50,000 rows a week.
--
-- Constraint 6 — "the SYSTEM never deletes an inferred edge, it demotes it" —
-- protects **what he told her**. A heart-rate sample is not that. It is a
-- measurement his watch took, uploaded by a program, and downsampling a year of
-- per-minute readings to daily aggregates forgets nothing that was ever known:
-- the mean is the same mean. Retention is 60 days at full resolution, then daily
-- aggregates (the Commander's ruling, 2026-08-12), and the job that does the
-- downsampling is `syl-t9tj.2.11`.
--
-- What still binds, and is the actual content of the rule: a **conclusion** she
-- reached from these rows is a memory, lives in the graph, decays in confidence
-- and is never deleted by any automatic path. Nothing destroyed here can destroy
-- one of those, because a conclusion carries its own reasoning text and does not
-- point at a sample row.
--
--
-- ## Not synced, and not a memory
--
-- Deliberately absent from `sync_log`'s type CHECK, and no sync trigger. Same
-- argument `0019_working_memory.sql` makes: a device that uploaded 40,000 rows
-- would immediately be handed 40,000 change-feed entries describing its own
-- upload. The phone resumes from `health_watermarks`, which is one row per type,
-- and that is the whole of what it needs to know.

-- One measurement, exactly as the phone read it.
--
-- `value` carries no unit. Units are fixed per type in `health/contract.ts`
-- ({@link UNITS}), so a sample cannot relabel itself into a different quantity —
-- and, more to the point, a unit that travelled with the row would be a second
-- place for the two halves to disagree about what `54` means.
CREATE TABLE health_samples (
  type        TEXT NOT NULL,

  -- RFC 3339 UTC, millisecond precision, canonicalised by `health/samples.ts`
  -- BEFORE it reaches this table. That canonicalisation is load-bearing rather
  -- than tidy: identity below is a comparison of TEXT, so a phone that sent
  -- `…:00Z` on Monday and `…:00.000Z` on Tuesday would be storing the same
  -- measurement twice under two spellings, and the unique index would not see
  -- it. Never a fixed UTC offset — constraint 5.
  started_at  TEXT NOT NULL,
  -- Equal to `started_at` for an instantaneous reading.
  ended_at    TEXT NOT NULL,

  value       REAL NOT NULL,

  -- Which device or app recorded it. Part of the identity below, because the
  -- same minute genuinely measured by a watch and by a phone is two
  -- measurements rather than a duplicate, and averaging them silently would be
  -- inventing a third.
  source      TEXT NOT NULL,

  -- When WE wrote it, which is not when it was measured. The difference is the
  -- whole of a cold 60-day backfill: every row lands in one second and describes
  -- two months.
  recorded_at TEXT NOT NULL,

  -- The seven types, enumerated here as well as in `contract.ts`. A second
  -- place, deliberately: widening the set then costs a migration, which is where
  -- a decision about what Syl reads from his body ought to be made — visibly, in
  -- SQL, rather than by appending a string to an array. A type added to the
  -- contract and not to a migration fails loudly on the first insert, which is
  -- the right direction to fail in.
  CHECK (type IN (
    'heartRate', 'restingHeartRate', 'heartRateVariability',
    'sleep', 'steps', 'workout', 'bodyMass'
  )),
  CHECK (ended_at >= started_at),
  CHECK (length(trim(source)) > 0)
  -- No NaN check: SQLite stores a non-finite REAL as NULL, so `NOT NULL` above
  -- already refuses one. A CHECK here would read as the guard and be doing
  -- nothing.
) STRICT;

-- ## A sample's identity
--
-- `(type, started_at, ended_at, source)`, and this index is what makes
-- idempotence a fact about the database rather than a property of one code path.
-- A retry, a racing second device, or an app that lost its watermark all hit
-- this constraint instead of quietly doubling a measurement.
--
-- Duplicated samples are not a tidiness problem. A doubled sleep sample is a
-- wrong average, which is a wrong baseline, which is a conclusion about a
-- pattern that does not exist — surfaced to him, unprompted, at the level
-- reserved for things that matter.
--
-- The unit is not part of the identity: units are fixed per type, so including
-- one would let a client change a sample's identity by relabelling it.
CREATE UNIQUE INDEX health_samples_identity_idx
  ON health_samples (type, started_at, ended_at, source);

-- Every read of this table is "one type, over a window", both for the admin's
-- raw view and for the derivations. Leading with `type` because a series is
-- always asked for by type first.
CREATE INDEX health_samples_series_idx
  ON health_samples (type, started_at);

-- Where each type's upload got to, so the phone knows where to resume.
--
-- One row per type, upserted. `through` only ever moves FORWARD — see
-- `health/samples.ts`, which refuses to write a lower value. A watermark that
-- could go backwards would make a device re-upload a window it has already sent,
-- which is harmless by identity but is also the exact symptom that would make
-- somebody "fix" idempotence by loosening it.
CREATE TABLE health_watermarks (
  type       TEXT NOT NULL PRIMARY KEY,
  -- The latest `ended_at` this service is confirmed to hold for this type.
  through    TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  CHECK (type IN (
    'heartRate', 'restingHeartRate', 'heartRateVariability',
    'sleep', 'steps', 'workout', 'bodyMass'
  ))
) STRICT;

-- What the phone was ALLOWED to read, per type, as of the most recent upload.
--
-- ## This table is what stops "empty" and "denied" being the same answer
--
-- HealthKit's authorisation model is asymmetric in a way that makes a missing
-- permission SILENT: a type the Commander has not granted does not error and
-- does not report denial — **it reads as empty**. So without this table, "he
-- walked nowhere on Tuesday" and "we were never allowed to look at steps" are
-- the same zero rows in `health_samples`, forever, with every layer reporting
-- success.
--
-- Only the phone knows the difference, so it says so on every upload and the
-- server refuses an upload whose report is incomplete rather than defaulting the
-- missing types. A default would have to be a guess about permission, and a
-- guess is exactly what this table exists to abolish.
--
-- This is `syl-kqc` one subsystem over: a capability the payload claimed and the
-- binary had never been signed for, accepted, downgraded, and delivered
-- silently — server said delivered, Apple said accepted, the phone showed
-- nothing, and no layer recorded an error.
--
-- **A MISSING ROW IS A THIRD STATE and it is not `denied`.** No row means the
-- phone has never told us anything about this type — a build too old to report,
-- a device that has never uploaded. `notDetermined` means a prompt he has not
-- seen; `denied` means an answer he gave; absent means nobody asked us to
-- believe anything. Collapsing any two of those is the failure this whole
-- feature is arranged around, so `state` is NOT NULL and absence is carried by
-- the row not existing.
CREATE TABLE health_authorisation (
  type        TEXT NOT NULL PRIMARY KEY,
  state       TEXT NOT NULL,
  -- When the phone reported it, not when we stored it. A stale report is still
  -- a report, and "she has not heard from the watch in nine days" is a thing
  -- worth being able to notice.
  reported_at TEXT NOT NULL,

  CHECK (type IN (
    'heartRate', 'restingHeartRate', 'heartRateVariability',
    'sleep', 'steps', 'workout', 'bodyMass'
  )),
  -- **Five states, not three** (`syl-m3gi`). The three-state model is the one
  -- Apple's documentation reads like and is not the one iOS can answer:
  -- `authorizationStatus(for:)` reports SHARING and Syl requests read-only, so
  -- it says `.sharingDenied` for all seven types whatever he granted;
  -- `statusForAuthorizationRequest` proves only `notDetermined`; and
  -- `authorised` can be proven only by a sample actually coming back. So
  -- *denied*, *authorised-but-quiet* and *authorised-then-revoked* are ONE
  -- indistinguishable state on the platform, and narrowing them to `denied`
  -- would put the empty-versus-denied conflation back inside the very field
  -- built to abolish it. `undisclosed` names it.
  --
  -- `unavailable` is separate because the remedy differs: no watch means no
  -- HRV, and telling him to grant a permission he already granted is useless
  -- advice. That is the distinction the admin screen needs.
  --
  -- **Stored as reported, never collapsed.** A server that folded `undisclosed`
  -- into `denied` on the way in would be destroying the distinction one layer
  -- below the one that has to show it.
  CHECK (state IN ('authorised', 'denied', 'notDetermined', 'undisclosed', 'unavailable'))
) STRICT;
