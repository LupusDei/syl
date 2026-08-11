import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ApiError, LogPage } from "@syl/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp, type AppDependencies } from "../../src/index.js";
import { toLogEntry } from "../../src/routes/logs.js";
import type { SylDatabase } from "../../src/services/database.js";
import { startTestApp, type RunningApp } from "../helpers/http.js";
import { testConfig, testDatabase, testDeps } from "../helpers/service.js";

/**
 * `GET /logs` — the surface that says what Syl actually DID.
 *
 * Two properties are being held here and they pull in opposite directions:
 *
 * 1. The Commander must be able to ask "every tool she called today" without a
 *    shell. That is the filter and paging half.
 * 2. **A paired phone must not be able to ask it at all.** That is the scope
 *    half, and it is the reason this endpoint is different from every other
 *    read in the contract — the log is not his data, it is the record of what a
 *    pre-authorised program did on his machine.
 *
 * The log is a real file in a real temp directory. A stubbed reader would let
 * the route pass while pointing at the wrong path, which is the whole failure
 * mode `ops/log-query.ts` exists to handle.
 */

interface Envelope<T> {
  readonly success: boolean;
  readonly data?: T;
  readonly error?: ApiError;
}

let db: SylDatabase;
let deps: AppDependencies;
let running: RunningApp;
let logDirectory: string;
/** A key minted the way `POST /auth/pair` mints one. */
let deviceToken: string;
/** A key minted the way `npm run pair -- --admin` mints one. */
let adminToken: string;

/** Nine records over nine minutes; the even ones are tool calls. */
function writeLog(directory: string): void {
  const lines: string[] = [];
  for (let index = 0; index < 9; index += 1) {
    lines.push(
      JSON.stringify({
        ts: `2026-08-10T13:0${String(index)}:00.000Z`,
        level: index === 4 ? "error" : "info",
        event: index % 2 === 0 ? "turn.tool" : "turn.done",
        pid: 4242,
        ...(index % 2 === 0 ? { tool: `Tool${String(index)}` } : { turns: index }),
      }),
    );
  }
  writeFileSync(join(directory, "syl.log"), `${lines.join("\n")}\n`);
}

beforeEach(async () => {
  logDirectory = mkdtempSync(join(tmpdir(), "syl-logs-route-"));
  writeLog(logDirectory);

  db = testDatabase();
  deps = testDeps(db);
  running = await startTestApp(createApp(testConfig({ logDirectory }), deps));
  deviceToken = deps.keys.pair(deps.keys.issuePairingCode().code, "Commander's iPhone").token;
  adminToken = deps.keys.mint("Web admin (console)", { scope: "admin" }).token;
});

afterEach(async () => {
  await running.close();
  db.close();
  rmSync(logDirectory, { recursive: true, force: true });
});

async function api(path: string, token: string = adminToken): Promise<Response> {
  return fetch(`${running.baseUrl}/api/v1${path}`, {
    ...(token === "" ? {} : { headers: { authorization: `Bearer ${token}` } }),
  });
}

async function body<T>(path: string, token?: string): Promise<Envelope<T>> {
  return (await (await api(path, token)).json()) as Envelope<T>;
}

describe("GET /api/v1/logs", () => {
  it("should hand back the log newest first", async () => {
    const page = await body<LogPage>("/logs");

    expect(page.success).toBe(true);
    expect(page.data?.items).toHaveLength(9);
    // Newest first, unlike every other page in the contract — a log view
    // answers "what just happened" far more often than "what happened first".
    expect(page.data?.items[0]?.ts).toBe("2026-08-10T13:08:00.000Z");
    expect(page.data?.items[8]?.ts).toBe("2026-08-10T13:00:00.000Z");
  });

  it("should refuse a level it does not know, rather than ignoring it", async () => {
    // The structured-error case. A `level=warning` silently read as "no filter"
    // hands back a page of `info` lines that looks like the answer, and the
    // reader concludes nothing went wrong.
    const response = await api("/logs?level=warning");
    const failure = (await response.json()) as Envelope<never>;

    expect(response.status).toBe(400);
    expect(failure.success).toBe(false);
    expect(failure.error?.code).toBe("VALIDATION_FAILED");
    expect(failure.error?.details).toMatchObject({ field: "level" });
  });

  it("should answer 'every tool she called today' in one request", async () => {
    // The Commander's actual question, and the reason the endpoint exists.
    const page = await body<LogPage>(
      "/logs?event=turn.tool&since=2026-08-10T00:00:00.000Z&until=2026-08-10T23:59:59.999Z",
    );

    expect(page.data?.items.map((item) => item.event)).toEqual(Array<string>(5).fill("turn.tool"));
    expect(page.data?.items[0]?.fields["tool"]).toBe("Tool8");
  });

  it("should treat `event` as a prefix, so a family can be asked for at once", async () => {
    const all = await body<LogPage>("/logs?event=turn");
    const tools = await body<LogPage>("/logs?event=turn.tool");

    expect(all.data?.items).toHaveLength(9);
    expect(tools.data?.items).toHaveLength(5);
  });

  it("should filter by level, keeping everything at or above it", async () => {
    const page = await body<LogPage>("/logs?level=warn");

    expect(page.data?.items).toHaveLength(1);
    expect(page.data?.items[0]?.level).toBe("error");
  });

  it("should include both ends of a time range", async () => {
    const page = await body<LogPage>(
      "/logs?since=2026-08-10T13:02:00.000Z&until=2026-08-10T13:04:00.000Z",
    );

    expect(page.data?.items.map((item) => item.ts)).toEqual([
      "2026-08-10T13:04:00.000Z",
      "2026-08-10T13:03:00.000Z",
      "2026-08-10T13:02:00.000Z",
    ]);
  });

  it("should accept an instant without milliseconds and still compare it correctly", async () => {
    // `2026-08-10T13:08:00Z` is valid RFC 3339 and sorts LATER than
    // `2026-08-10T13:08:00.000Z` as a string, because `.` precedes `Z`. Without
    // normalisation the newest record would drop out of its own range.
    const page = await body<LogPage>("/logs?since=2026-08-10T13:08:00Z");

    expect(page.data?.items).toHaveLength(1);
    expect(page.data?.items[0]?.ts).toBe("2026-08-10T13:08:00.000Z");
  });

  it("should refuse an inverted range rather than answering it emptily", async () => {
    const response = await api(
      "/logs?since=2026-08-10T13:05:00.000Z&until=2026-08-10T13:01:00.000Z",
    );
    const failure = (await response.json()) as Envelope<never>;

    expect(response.status).toBe(400);
    expect(failure.error?.code).toBe("VALIDATION_FAILED");
    expect(failure.error?.details).toMatchObject({ field: "since" });
  });

  it("should refuse a `since` that is not an instant", async () => {
    const failure = await body<never>("/logs?since=yesterday");

    expect(failure.error?.code).toBe("VALIDATION_FAILED");
    expect(failure.error?.details).toMatchObject({ field: "since" });
  });

  it("should page, and the second page should continue where the first stopped", async () => {
    const first = await body<LogPage>("/logs?limit=4");
    expect(first.data?.hasMore).toBe(true);
    expect(first.data?.nextCursor).not.toBeNull();
    expect(first.data?.items.map((item) => item.ts)).toEqual([
      "2026-08-10T13:08:00.000Z",
      "2026-08-10T13:07:00.000Z",
      "2026-08-10T13:06:00.000Z",
      "2026-08-10T13:05:00.000Z",
    ]);

    const second = await body<LogPage>(
      `/logs?limit=4&cursor=${encodeURIComponent(first.data?.nextCursor ?? "")}`,
    );
    expect(second.data?.items[0]?.ts).toBe("2026-08-10T13:04:00.000Z");
    expect(second.data?.hasMore).toBe(true);
  });

  it("should say hasMore is false on the last page and offer no cursor", async () => {
    const page = await body<LogPage>("/logs?limit=200");

    expect(page.data?.hasMore).toBe(false);
    expect(page.data?.nextCursor).toBeNull();
  });

  it("should keep the filter applied across a page boundary", async () => {
    // Paging that filters only the first page is the kind of bug nobody
    // notices: page two is full, the rows are real, and they are the wrong
    // rows.
    const first = await body<LogPage>("/logs?event=turn.tool&limit=2");
    const second = await body<LogPage>(
      `/logs?event=turn.tool&limit=2&cursor=${encodeURIComponent(first.data?.nextCursor ?? "")}`,
    );

    expect(second.data?.items.map((item) => item.event)).toEqual(["turn.tool", "turn.tool"]);
    expect(second.data?.items[0]?.ts).toBe("2026-08-10T13:04:00.000Z");
  });

  it("should refuse a cursor it did not issue", async () => {
    const response = await api("/logs?cursor=not-a-cursor");
    const failure = (await response.json()) as Envelope<never>;

    expect(response.status).toBe(400);
    expect(failure.error?.code).toBe("VALIDATION_FAILED");
    expect(failure.error?.details).toMatchObject({ field: "cursor" });
  });

  it("should answer an empty page when the log directory does not exist", async () => {
    // A machine on its first boot, or a test environment. An empty log is not
    // an error, and a 500 here would send whoever is debugging into the route.
    rmSync(logDirectory, { recursive: true, force: true });
    const page = await body<LogPage>("/logs");

    expect(page.success).toBe(true);
    expect(page.data?.items).toEqual([]);
    expect(page.data?.hasMore).toBe(false);
  });
});

describe("the scope on GET /api/v1/logs", () => {
  it("should serve a paired device, because he carries the phone and not the laptop", async () => {
    // RESTATED, `2026-08-10`, by the Commander: "Remove the need for another
    // key for the admin panel. Too annoying."
    //
    // This asserted the old policy correctly and the policy changed, so it is
    // inverted rather than deleted — a test that quietly disappears takes the
    // record of the decision with it. A paired device may now read this. What
    // still holds is asserted below and in the anonymous case: authentication
    // is required, and it is what was doing the real work all along.
    const response = await api("/logs", deviceToken);

    expect(response.status).toBe(200);
  });

  it("should give an anonymous caller the ordinary 401 and disclose no scope", async () => {
    // Order matters: authenticate first, authorise second. Reversed, a caller
    // with no token learns that an admin surface exists here.
    const response = await api("/logs", "");
    const failure = (await response.json()) as Envelope<never>;

    expect(response.status).toBe(401);
    expect(failure.error?.code).toBe("UNAUTHORIZED");
    expect(failure.error?.message).not.toContain("scope");
    expect(failure.error?.message).not.toContain("admin");
  });

  it("should still serve every other route to a paired device", async () => {
    // The gate must be on this one endpoint and nowhere else. A scope check
    // that crept onto the router above would lock the Commander's phone out of
    // his own reminders, which is a far worse failure than the one it prevents.
    expect((await api("/jobs", deviceToken)).status).toBe(200);
    expect((await api("/reminders", deviceToken)).status).toBe(200);
    expect((await api("/todos", deviceToken)).status).toBe(200);
  });

  it("should still turn away a token the service has never seen", async () => {
    // What survived the Commander's ruling, and it is the half that was doing
    // the real work: the scope came off, AUTHENTICATION did not. Kept in the
    // inverted form so the route cannot quietly become open to anyone — the
    // failure this guards is "no gate at all", which looks identical to
    // "device tokens allowed" from the outside.
    const whoami = await fetch(`${running.baseUrl}/api/v1/auth/whoami`, {
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(whoami.status).toBe(200);
    expect((await api("/logs", deviceToken)).status).toBe(200);

    expect((await api("/logs", "syl_pat_never_issued")).status).toBe(401);
  });
});

describe("toLogEntry", () => {
  it("should keep the four named fields and put everything else in `fields`", () => {
    const entry = toLogEntry({
      ts: "2026-08-10T13:00:00.000Z",
      level: "info",
      event: "turn.tool",
      pid: 4242,
      tool: "Bash",
      command: "ls",
    });

    expect(entry).toEqual({
      ts: "2026-08-10T13:00:00.000Z",
      level: "info",
      event: "turn.tool",
      pid: 4242,
      fields: { tool: "Bash", command: "ls" },
    });
  });

  it("should give a record with nothing extra an empty object, never null", () => {
    // The contract says `fields` is required and never null. A client that has
    // to test for null before iterating is a client that will forget once.
    const entry = toLogEntry({
      ts: "2026-08-10T13:00:00.000Z",
      level: "warn",
      event: "service.notice",
      pid: 1,
    });

    expect(entry.fields).toEqual({});
  });
});
