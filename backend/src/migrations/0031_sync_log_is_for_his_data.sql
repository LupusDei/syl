-- 0031_sync_log_is_for_his_data.sql — jobs and runs stop being synced resources.
--
-- `syl-020`, the second half. The first half taught the phone to ask for what it
-- stores; this stops the server writing what nothing asks for.
--
-- ## The measurement
--
-- 28,786 rows in `sync_log` on the Commander's own database, of which **28,198
-- — 98.0% — were types no client stores**. `job` alone was 15,316 and `run`
-- 10,210, against 23 `todo` rows: 0.09% of the feed was the resource whose
-- absence from his phone started this.
--
-- Nothing was looping. There are exactly SIX job rows in the system, rewritten
-- on every tick — `reminder_delivery` polls once a minute asking whether
-- anything is due, at zero turns and zero cost, and each tick rewrites the job
-- row and writes a run row. `run_steps` appends to the same `run` type
-- (see the note below its trigger in `0010`), so a run with several steps
-- writes several more. Ordinary scheduling at full fidelity, into a feed that
-- was never filtered.
--
-- ## Why the triggers go rather than the client filtering harder
--
-- **Nothing consumes them.** The web admin never calls `GET /sync` at all — it
-- reads `/jobs`, `/jobs/{id}/runs` and `/runs/{id}` directly, which is correct,
-- because those are the operator's live view of what the service is doing. The
-- only caller of the change feed is the iOS app, and `SyncEngine.upsert` has
-- always discarded `job` and `run` on arrival.
--
-- So this was a producer with no consumer, and every row it wrote pushed his
-- to-dos further behind a cursor that pages 500 changes at a time.
--
-- ## Why they leave the CONTRACT too, and not just the log
--
-- Keeping `job` and `run` as declared sync types while never logging one would
-- rebuild the exact trap `sync-service.ts` warns about at the top of the file:
-- a type the contract offers, that answers `200` with an empty page forever —
-- "a resource that silently never reaches a device, which is the exact class of
-- failure this endpoint's whole design is built to rule out."
--
-- A thing that is not synced should not be listed as synced. Telemetry about
-- what the service DID is not the Commander's data moving between his devices,
-- and the two were only ever conflated because one table could carry both.
--
-- ## The existing rows go as well
--
-- Dropping the triggers stops the growth and does nothing about the 25,526 rows
-- already in front of his to-dos. `seq` is an autoincrement the client compares
-- with `>`, so removing rows below a cursor is invisible to a device that has
-- passed them and a shortcut for one that has not. No cursor is invalidated:
-- a client holding a deleted `seq` still asks for everything after it.
--
-- This is not the SYSTEM discarding something it should keep. The jobs and runs
-- themselves are untouched in their own tables, with their own routes and the
-- admin's view of them intact; what is deleted is a redundant note saying "this
-- row changed", addressed to nobody.

DROP TRIGGER IF EXISTS sync_jobs_ai;
DROP TRIGGER IF EXISTS sync_jobs_au;
DROP TRIGGER IF EXISTS sync_jobs_ad;

DROP TRIGGER IF EXISTS sync_runs_ai;
DROP TRIGGER IF EXISTS sync_runs_au;
DROP TRIGGER IF EXISTS sync_runs_ad;

-- `run_steps` existed only to mark the run that carries it as changed. With
-- `run` no longer a synced type there is nothing left for it to mark.
DROP TRIGGER IF EXISTS sync_run_steps_ai;
DROP TRIGGER IF EXISTS sync_run_steps_au;
DROP TRIGGER IF EXISTS sync_run_steps_ad;

DELETE FROM sync_log WHERE type IN ('job', 'run');
