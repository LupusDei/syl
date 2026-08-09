import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { API_BASE_PATH, createApp } from "../../src/index.js";
import { inspectAdminBundle } from "../../src/ops/admin-bundle.js";
import { ADMIN_BASE_PATH } from "../../src/routes/admin.js";
import type { SylDatabase } from "../../src/services/database.js";
import { startTestApp, type RunningApp } from "../helpers/http.js";
import { testConfig, testDatabase, testDeps } from "../helpers/service.js";

/**
 * The **real** bundle, served from the **real** mount.
 *
 * `admin.test.ts` drives the router against a hand-made directory, which proves
 * the routing and proves nothing about the two constants that have to agree
 * across a workspace boundary: Vite's `base` and Express's mount path. Those
 * live in different languages in different packages, and when they disagree the
 * page loads, the browser asks for `/assets/index-<hash>.js`, gets Syl's JSON
 * 404, and renders a blank screen with a MIME type error in a console nobody on
 * a phone can open.
 *
 * So this builds the frontend for real and then follows every URL the emitted
 * `index.html` actually asks for. A mismatch turns it red here rather than on
 * the Commander's phone.
 *
 * The build runs on every pass, never "only when dist is missing" — a suite
 * that skips the build validates last week's code and reports green
 * (`docs/CONTEXT.md` §7).
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const adminDir = join(repoRoot, "frontend", "dist");

let running: RunningApp | undefined;
let db: SylDatabase | undefined;
let indexHtml: string;

/** Every absolute URL the built page asks the server for. */
function referencedUrls(html: string): readonly string[] {
  const found = new Set<string>();
  for (const match of html.matchAll(/(?:src|href)="(\/[^"]*)"/gu)) {
    const url = match[1];
    if (url !== undefined) found.add(url);
  }
  return [...found].sort();
}

beforeAll(async () => {
  // NODE_ENV is stripped rather than passed through. Vitest sets it to `test`,
  // and Vite feeds `NODE_ENV` straight into the bundle's `process.env.NODE_ENV`
  // — so inheriting it builds React's development copy, which is nearly twice
  // the size and is not the artefact `npm run build` produces. A test that
  // validates a different artefact than the one that ships is worth very little,
  // and this one also leaves its output in `frontend/dist` for the service to
  // serve.
  const { NODE_ENV: _testEnv, ...env } = process.env;
  execFileSync("npm", ["run", "build", "-w", "frontend"], {
    cwd: repoRoot,
    stdio: "inherit",
    env,
  });

  db = testDatabase();
  running = await startTestApp(createApp(testConfig({ adminDir }), testDeps(db)));
  indexHtml = readFileSync(join(adminDir, "index.html"), "utf8");
}, 120_000);

afterAll(async () => {
  await running?.close();
  running = undefined;
  db?.close();
  db = undefined;
});

/** The app under test. Narrowed once so every case can read `.baseUrl`. */
function app(): RunningApp {
  if (running === undefined) throw new Error("the service did not start");
  return running;
}

describe("the built admin served from Syl's own origin", () => {
  it("should produce a bundle the service recognises", () => {
    expect(inspectAdminBundle(adminDir).present).toBe(true);
  });

  it("should emit a real build rather than the dev server's module entry", () => {
    // `index.html` in the source tree points at `/src/main.tsx`, which only a
    // Vite dev server can serve. Seeing it here would mean the file was copied
    // rather than built.
    expect(indexHtml).not.toContain("/src/main.tsx");
    expect(referencedUrls(indexHtml).length).toBeGreaterThan(0);
  });

  it("should reference every asset under the path the service mounts the admin at", () => {
    // The cross-workspace pin: Vite's `base` and `ADMIN_BASE_PATH` are two
    // constants in two packages that must be the same string.
    for (const url of referencedUrls(indexHtml)) {
      expect(url.startsWith(`${ADMIN_BASE_PATH}/`), url).toBe(true);
    }
  });

  it("should answer every URL the built page asks for", async () => {
    const urls = referencedUrls(indexHtml);
    expect(urls.length).toBeGreaterThan(0);

    for (const url of urls) {
      const response = await fetch(`${app().baseUrl}${url}`);
      expect(response.status, url).toBe(200);
      // Never Syl's JSON envelope: that is what a base/mount mismatch returns,
      // and it is what a browser reports as a MIME type error.
      expect(response.headers.get("content-type"), url).not.toMatch(/application\/json/);
    }
  });

  it("should serve the page itself at /admin", async () => {
    const response = await fetch(`${app().baseUrl}${ADMIN_BASE_PATH}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/text\/html/);
    expect(await response.text()).toContain(`id="root"`);
  });

  it("should serve the same page for a deep link the router owns", async () => {
    const response = await fetch(`${app().baseUrl}${ADMIN_BASE_PATH}/jobs`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(indexHtml);
  });

  it("should leave the API untouched", async () => {
    const health = await fetch(`${app().baseUrl}${API_BASE_PATH}/health`);
    const unknown = await fetch(`${app().baseUrl}${API_BASE_PATH}/nope`);

    expect(health.status).toBe(200);
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("content-type")).toMatch(/application\/json/);
  });
});
