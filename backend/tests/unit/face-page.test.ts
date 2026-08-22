import type { ApiError } from "@syl/shared";
import { afterEach, describe, expect, it } from "vitest";

import { API_BASE_PATH, createApp } from "../../src/index.js";
import { FACE_PAGE_HTML, FACE_PAGE_PATH } from "../../src/routes/face-page.js";
import type { SylDatabase } from "../../src/services/database.js";
import { startTestApp, type RunningApp } from "../helpers/http.js";
import { testConfig, testDatabase, testDeps } from "../helpers/service.js";

/**
 * The page her face is drawn on — `syl-chzl.7.5`.
 *
 * The phone opens a full-screen `WKWebView` over this document and the document
 * does the WebRTC, which is the whole reason no LiveKit SDK is compiled into the
 * app. So the tests here are about the two things that can go wrong with a
 * static surface that stands in front of a paid stream:
 *
 * 1. **It carries nothing secret.** Not the org secret, not a session key, and
 *    not anything a caller put in the URL — a page that reflects its query
 *    string is a page that will one day reflect a credential into a proxy log.
 * 2. **It is scoped.** It is served from its own prefix, mounted after the
 *    contract, and `/api/v1/<unknown>` still answers with Syl's JSON envelope.
 *    That is the same regression `admin.test.ts` pins, for the same reason.
 */

/** Either envelope, as a test reads it. */
interface Envelope<T = unknown> {
  readonly success: boolean;
  readonly data?: T;
  readonly error?: ApiError;
}

let running: RunningApp | undefined;
let db: SylDatabase | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
  db?.close();
  db = undefined;
});

async function serve(): Promise<RunningApp> {
  db = testDatabase();
  running = await startTestApp(createApp(testConfig(), testDeps(db)));
  return running;
}

describe("the live face page", () => {
  it("should serve a document at its own path", async () => {
    const app = await serve();

    const response = await fetch(`${app.baseUrl}${FACE_PAGE_PATH}/live`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const body = await response.text();
    expect(body).toContain("<!DOCTYPE html>");
    // The mount point the phone is pointed at, and the SDK the page draws with.
    expect(body).toContain("avatars-react");
  });

  it("should never be cached", async () => {
    const app = await serve();

    const response = await fetch(`${app.baseUrl}${FACE_PAGE_PATH}/live`);

    // A page that stands in front of a session-scoped credential must not be
    // held by an intermediary. It is one document and it costs nothing to fetch.
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("should carry no credential of any kind in its source", () => {
    // The org secret's own env name, and the shape of every credential in this
    // subsystem. Asserted against the SOURCE rather than a response, so a page
    // that gains a baked-in key is red at the module rather than at one route.
    expect(FACE_PAGE_HTML).not.toContain("RUNWAYML_API_SECRET");
    expect(FACE_PAGE_HTML).not.toContain("stk_");
    expect(FACE_PAGE_HTML).not.toMatch(/Bearer\s+\S/);
  });

  it("should not reflect anything a caller puts in the URL", async () => {
    const app = await serve();

    const smuggled = "stk_thiscamefromthequerystring";
    const response = await fetch(
      `${app.baseUrl}${FACE_PAGE_PATH}/live?sessionKey=${smuggled}&x=%3Cscript%3E`,
    );

    const body = await response.text();
    // **The reason the credential travels in the fragment, not the query.** A
    // static page cannot leak what it never reads, and a fragment is never sent
    // to the server at all — so there is no access log, no proxy log and no
    // referrer header anywhere on the path that has seen a session key.
    expect(body).not.toContain(smuggled);
    expect(body).not.toContain("<script>");
    expect(body).toBe(FACE_PAGE_HTML);
  });

  it("should refuse a method that is not a page request", async () => {
    const app = await serve();

    const response = await fetch(`${app.baseUrl}${FACE_PAGE_PATH}/live`, { method: "POST" });

    // Falls through to the service's own terminal 404 rather than answering a
    // POST with a document.
    expect(response.status).toBe(404);
    const body = (await response.json()) as Envelope;
    expect(body.success).toBe(false);
  });

  it("should leave the contract's 404 alone", async () => {
    const app = await serve();

    const response = await fetch(`${app.baseUrl}${API_BASE_PATH}/no-such-route`);

    // The page router is mounted at the root, so this is the ordering check:
    // an HTML page here would tell every client that Syl is not Syl.
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as Envelope;
    expect(body.success).toBe(false);
  });

  it("should be reachable without a bearer token", async () => {
    const app = await serve();

    const response = await fetch(`${app.baseUrl}${FACE_PAGE_PATH}/live`);

    // Deliberate, and the same argument the admin bundle makes: the document
    // holds nothing, and the credential it needs is handed to it by the host
    // that already paid for the session. Gating the shell would mean inventing
    // a second credential to reach the page that consumes the first one — and
    // the `WKWebView` has no device token, which is exactly the point.
    expect(response.status).toBe(200);
  });
});
