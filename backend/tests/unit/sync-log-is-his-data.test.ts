import { beforeEach, describe, expect, it } from "vitest";

import { testDatabase } from "../helpers/service.js";
import type { SylDatabase } from "../../src/services/database.js";

/**
 * The change feed carries the Commander's data, not a record of what the service did.
 *
 * `syl-020`, second half. Measured on his own database: 28,786 rows in `sync_log`, of
 * which 28,198 — **98.0%** — were types no client stores. `job` alone was 15,316 and
 * `run` 10,210, against 23 `todo` rows. The resource whose absence from his phone
 * started the whole investigation was 0.09% of the feed it was buried in.
 *
 * Nothing was looping. Six job rows exist, rewritten on every tick: `reminder_delivery`
 * polls once a minute at zero turns and zero cost, and each tick rewrites the job row
 * and writes a run row. Ordinary scheduling, logged at full fidelity, into a feed nobody
 * had filtered.
 *
 * **It was a producer with no consumer.** The web admin never calls `GET /sync` — it
 * reads `/jobs`, `/jobs/{id}/runs` and `/runs/{id}` directly, which is the operator's
 * live view and stays exactly as it was. The only caller of the change feed is the phone,
 * and `SyncEngine.upsert` discarded `job` and `run` on arrival from the first day.
 *
 * These tests are about the RULE rather than about jobs: telemetry describing what the
 * service did is not his data moving between his devices, and the two were only ever
 * conflated because one table could carry both.
 */
describe("what the change feed is for", () => {
  let db: SylDatabase;

  beforeEach(() => {
    db = testDatabase();
  });

  const logged = (): string[] =>
    (db.handle.prepare("SELECT DISTINCT type FROM sync_log").all() as { type: string }[]).map(
      (row) => row.type,
    );

  it("should not log a job, however many times the scheduler rewrites it", () => {
    // The exact shape of the flood: one job row, rewritten on every tick. Before
    // `0031` each of these UPDATEs appended a feed row addressed to nobody.
    db.handle.exec(`
      INSERT INTO jobs (id, kind, state, priority, trigger_json, delivery_class,
                        catch_up_json, budget_json, breaker_state, breaker_failures,
                        speaks, created_at, updated_at)
      VALUES ('job-1', 'reminder_delivery', 'pending', 'scheduled', '{}', 'at_least_once', '{}', '{}',
              'closed', 0, 0, '2026-08-12T00:00:00.000Z', '2026-08-12T00:00:00.000Z');
    `);
    for (let tick = 0; tick < 25; tick += 1) {
      db.handle
        .prepare("UPDATE jobs SET updated_at = ? WHERE id = 'job-1'")
        .run(`2026-08-12T00:${String(tick).padStart(2, "0")}:00.000Z`);
    }

    expect(logged()).not.toContain("job");
  });

  it("should not log a run, nor the steps that make one", () => {
    // `run_steps` appended to the `run` type as well, so a run with several steps
    // multiplied itself in the feed. With `run` no longer synced there is nothing
    // left for that trigger to mark.
    db.handle.exec(`
      INSERT INTO jobs (id, kind, state, priority, trigger_json, delivery_class,
                        catch_up_json, budget_json, breaker_state, breaker_failures,
                        speaks, created_at, updated_at)
      VALUES ('job-2', 'maintenance', 'pending', 'scheduled', '{}', 'at_least_once', '{}', '{}',
              'closed', 0, 0, '2026-08-12T00:00:00.000Z', '2026-08-12T00:00:00.000Z');
      INSERT INTO runs (id, job_id, kind, trigger_instant, outcome, attempts, started_at)
      VALUES ('run-1', 'job-2', 'maintenance', '2026-08-12T00:00:00.000Z', 'success', 1,
              '2026-08-12T00:00:00.000Z');
    `);

    expect(logged()).not.toContain("run");
  });

  it("should still log everything that IS his", () => {
    // The half that must not be broken by the half above. A todo, a reminder and a
    // goal are his data moving between his devices, and removing the noise must not
    // take any of the signal with it.
    db.handle.exec(`
      INSERT INTO todos (id, text, status, pinned, source, created_at, updated_at)
      VALUES ('syl:todo:t1', 'Verify the insurance', 'open', 1, 'commander',
              '2026-08-12T00:00:00.000Z', '2026-08-12T00:00:00.000Z');
    `);

    expect(logged()).toContain("todo");
  });

  it("should not offer a resource type it will never log", async () => {
    // Keeping `job` in the contract while logging none would rebuild the trap
    // `sync-service.ts` warns about at the top of the file: an endpoint answering
    // 200 with an empty page forever, for a resource that silently never arrives.
    // That is the failure this endpoint's whole design exists to rule out, and it
    // would have been the comfortable half-fix.
    const { SYNC_RESOURCE_TYPES } = await import("../../src/services/sync-service.js");

    expect(SYNC_RESOURCE_TYPES).not.toContain("job");
    expect(SYNC_RESOURCE_TYPES).not.toContain("run");
    expect(SYNC_RESOURCE_TYPES).toContain("todo");
  });
});
