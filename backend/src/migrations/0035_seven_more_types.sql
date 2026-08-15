-- 0035_seven_more_types.sql — the type set widens from seven to fourteen.
--
-- `syl-8ys9.1.1`. `0032` enumerated the seven types in SQL as well as in
-- `health/contract.ts` and said why:
--
-- > A second place, deliberately: widening the set then costs a migration,
-- > which is where a decision about what Syl reads from his body ought to be
-- > made — visibly, in SQL, rather than by appending a string to an array.
--
-- This is that migration, and the decision is the Commander's: he sent Oura's
-- Apple Health permission screen and said get all of it. The seven added here
-- are **everything else that source publishes** — the selection principle moved
-- from "what would be useful to reason over" to "what his ring will hand us".
--
--   activeEnergy        kcal   Active Energy
--   basalEnergy         kcal   Resting Energy
--   bodyFatPercentage   %      Body Fat Percentage
--   vo2Max              mL/min·kg  Cardio Fitness
--   height              cm     Height
--   leanBodyMass        lb     Lean Body Mass
--   respiratoryRate     count/min  Respiratory Rate
--
-- Four things on his list are deliberately NOT here. Date of Birth and Sex are
-- HealthKit *characteristics* — facts, with no time series, no watermark and
-- nothing a baseline could be computed from; they belong in the memory graph
-- (`syl-8ys9.4`). Blood Pressure is a correlation of two values and this table
-- holds one. Workout Routes is GPS — where he has been rather than how his body
-- is, and it waits on his explicit yes.
--
-- Two types already in the set will never carry a row from his ring: Oura
-- publishes neither Heart Rate Variability nor Resting Heart Rate to Apple
-- Health. They stay in the CHECK because another source could, and because the
-- honest name for their silence is a judgement this table does not make.
--
--
-- ## Why this rebuilds three tables instead of altering them
--
-- SQLite has no `ALTER TABLE ... DROP CONSTRAINT` and a CHECK cannot be widened
-- in place, so the documented rebuild is the only route: create, copy, drop,
-- rename, recreate the indexes. `0016` walks the same path and states the three
-- traps; they apply here too, and one of them bites harder.
--
-- 1. **The column list is spelled out on both sides.** `INSERT ... SELECT *`
--    depends on physical column order, and a positional copy that transposed
--    two TEXT columns would put a source name into `started_at` with nothing
--    raising — every column in `health_samples` except `value` is TEXT.
-- 2. **Both indexes are recreated, and `health_samples_identity_idx` is the one
--    that matters.** `DROP TABLE` takes a table's indexes with it, and that
--    index is where idempotence lives — `0032` puts it in the database on
--    purpose and explicitly not in TypeScript. A rebuild that forgot it would
--    remove the guarantee, break no test that was looking elsewhere, and be
--    discovered by a re-upload silently doubling every measurement. Which is a
--    wrong average, which is a wrong baseline, which is a conclusion about a
--    pattern that does not exist.
-- 3. **Nothing references any of these three tables.** No foreign key points at
--    them and none points outward either — `0032` has no `memory_node_id` and
--    that absence IS the enforcement. So the drop cannot orphan a child row and
--    the rename cannot rewrite a reference in another table's DDL.
--
-- ## Nothing backfills, and nothing can
--
-- Existing rows keep the types they have; a widened CHECK admits new values and
-- changes no old one. The first `activeEnergy` row in any database arrives from
-- the phone, and until the Commander grants the seven new permissions the phone
-- will report them `undisclosed` and send nothing — which is the correct answer
-- and not an error.
--
-- ## Still no column into the graph
--
-- Every rebuilt table below is the `0032` table with one CHECK widened. No new
-- column, no foreign key, no `memory_node_id`. Seven more types is seven more
-- chances to violate that, and `a-health-sample-cannot-become-a-memory-node`
-- now uploads all fourteen for exactly that reason.

CREATE TABLE health_samples_rebuilt (
  type        TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  ended_at    TEXT NOT NULL,
  value       REAL NOT NULL,
  source      TEXT NOT NULL,
  recorded_at TEXT NOT NULL,

  CHECK (type IN (
    'heartRate', 'restingHeartRate', 'heartRateVariability',
    'sleep', 'steps', 'workout', 'bodyMass',
    'activeEnergy', 'basalEnergy', 'bodyFatPercentage',
    'vo2Max', 'height', 'leanBodyMass', 'respiratoryRate'
  )),
  CHECK (ended_at >= started_at),
  CHECK (length(trim(source)) > 0)
) STRICT;

INSERT INTO health_samples_rebuilt (type, started_at, ended_at, value, source, recorded_at)
SELECT type, started_at, ended_at, value, source, recorded_at FROM health_samples;

DROP TABLE health_samples;
ALTER TABLE health_samples_rebuilt RENAME TO health_samples;

-- Idempotence. `(type, started_at, ended_at, source)` — the unit is deliberately
-- not part of it, because units are fixed per type and including one would let a
-- client change a sample's identity by relabelling it.
CREATE UNIQUE INDEX health_samples_identity_idx
  ON health_samples (type, started_at, ended_at, source);

-- Every read is "one type, over a window". Leading with `type`.
CREATE INDEX health_samples_series_idx
  ON health_samples (type, started_at);

CREATE TABLE health_watermarks_rebuilt (
  type       TEXT NOT NULL PRIMARY KEY,
  through    TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  CHECK (type IN (
    'heartRate', 'restingHeartRate', 'heartRateVariability',
    'sleep', 'steps', 'workout', 'bodyMass',
    'activeEnergy', 'basalEnergy', 'bodyFatPercentage',
    'vo2Max', 'height', 'leanBodyMass', 'respiratoryRate'
  ))
) STRICT;

INSERT INTO health_watermarks_rebuilt (type, through, updated_at)
SELECT type, through, updated_at FROM health_watermarks;

DROP TABLE health_watermarks;
ALTER TABLE health_watermarks_rebuilt RENAME TO health_watermarks;

-- A MISSING ROW IS A THIRD STATE and it is not `denied`: no row means the phone
-- has never told us anything about this type. After this migration that is the
-- state all seven new types are in on every existing database, and it is the
-- literally true one.
CREATE TABLE health_authorisation_rebuilt (
  type        TEXT NOT NULL PRIMARY KEY,
  state       TEXT NOT NULL,
  reported_at TEXT NOT NULL,

  CHECK (type IN (
    'heartRate', 'restingHeartRate', 'heartRateVariability',
    'sleep', 'steps', 'workout', 'bodyMass',
    'activeEnergy', 'basalEnergy', 'bodyFatPercentage',
    'vo2Max', 'height', 'leanBodyMass', 'respiratoryRate'
  )),
  CHECK (state IN ('authorised', 'denied', 'notDetermined', 'undisclosed', 'unavailable'))
) STRICT;

INSERT INTO health_authorisation_rebuilt (type, state, reported_at)
SELECT type, state, reported_at FROM health_authorisation;

DROP TABLE health_authorisation;
ALTER TABLE health_authorisation_rebuilt RENAME TO health_authorisation;
