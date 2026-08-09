import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ApiError } from "@syl/shared";
import { afterEach, describe, expect, it } from "vitest";

import { API_BASE_PATH, createApp, NO_ROUTE_MESSAGE } from "../../src/index.js";
import {
  DEFAULT_ADMIN_DIR,
  defaultAdminDir,
  describeAdmin,
  inspectAdminBundle,
  looksLikeFile,
} from "../../src/ops/admin-bundle.js";
import { ADMIN_BASE_PATH } from "../../src/routes/admin.js";
import type { SylDatabase } from "../../src/services/database.js";
import { startTestApp, type RunningApp } from "../helpers/http.js";
import { testConfig, testDatabase, testDeps } from "../helpers/service.js";

/**
 * Serving the built admin from Syl's own origin.
 *
 * Two things are being tested and only one of them is "does a file come back".
 * The other is **ordering**: the SPA needs a history fallback, a history
 * fallback is by nature a catch-all, and a catch-all mounted carelessly eats
 * the API. `/api/v1/<unknown>` returning Syl's JSON envelope after the admin is
 * mounted is the regression this file exists to pin — an HTML page there would
 * tell every client that Syl is not Syl.
 */

/** Either envelope, as a test reads it. */
interface Envelope<T = unknown> {
  readonly success: boolean;
  readonly data?: T;
  readonly error?: ApiError;
}

const scratches: string[] = [];
let running: RunningApp | undefined;
let db: SylDatabase | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
  db?.close();
  db = undefined;
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A throwaway directory, removed after the test. */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "syl-admin-"));
  scratches.push(dir);
  return dir;
}

/** What the asset file is called, so a test can ask for it by name. */
const ASSET = "index-Bwe9VNQj.js";

/**
 * A bundle shaped like the one `vite build` emits: an `index.html` whose asset
 * URLs are absolute and already prefixed with the mount path.
 *
 * @param under an extra directory to nest it in, for the dot-directory case.
 */
function fakeBundle(under = ""): string {
  const root = under === "" ? scratch() : join(scratch(), under);
  mkdirSync(join(root, "assets"), { recursive: true });
  writeFileSync(
    join(root, "index.html"),
    `<!doctype html><html><head><script type="module" src="${ADMIN_BASE_PATH}/assets/${ASSET}"></script></head><body><div id="root"></div></body></html>`,
  );
  writeFileSync(join(root, "assets", ASSET), "export const admin = true;\n");
  return root;
}

/** Start the whole app with the admin pointed at `adminDir`. */
async function serve(adminDir: string): Promise<RunningApp> {
  db?.close();
  db = testDatabase();
  running = await startTestApp(createApp(testConfig({ adminDir }), testDeps(db)));
  return running;
}

describe("inspectAdminBundle", () => {
  it("should report a bundle present when index.html is there", () => {
    const bundle = inspectAdminBundle(fakeBundle());

    expect(bundle.present).toBe(true);
    expect(bundle.indexPath.endsWith("index.html")).toBe(true);
  });

  it("should report a bundle missing when the directory does not exist", () => {
    expect(inspectAdminBundle(join(scratch(), "never-built")).present).toBe(false);
  });

  it("should report a bundle missing when the directory exists but holds no index.html", () => {
    // The shape a half-finished or wrongly-configured build leaves behind.
    const root = scratch();
    mkdirSync(join(root, "assets"), { recursive: true });
    writeFileSync(join(root, "assets", ASSET), "export const admin = true;\n");

    expect(inspectAdminBundle(root).present).toBe(false);
  });
});

describe("defaultAdminDir", () => {
  it("should point at the frontend workspace's build output by default", () => {
    expect(defaultAdminDir({})).toBe(DEFAULT_ADMIN_DIR);
    expect(DEFAULT_ADMIN_DIR.endsWith(join("frontend", "dist"))).toBe(true);
  });

  it("should take SYL_ADMIN_DIR when one is set", () => {
    expect(defaultAdminDir({ SYL_ADMIN_DIR: "/srv/syl/admin" })).toBe("/srv/syl/admin");
  });

  it("should treat a blank SYL_ADMIN_DIR as unset rather than as the empty path", () => {
    expect(defaultAdminDir({ SYL_ADMIN_DIR: "   " })).toBe(DEFAULT_ADMIN_DIR);
  });
});

describe("describeAdmin", () => {
  it("should name the mount path and the directory it is served from", () => {
    const root = fakeBundle();

    const line = describeAdmin(inspectAdminBundle(root)).join("\n");

    expect(line).toContain(ADMIN_BASE_PATH);
    expect(line).toContain(root);
  });

  it("should warn loudly, and say how to fix it, when the bundle is absent", () => {
    // A missing admin must be visible at boot rather than discovered by a 404
    // hours later. `startSyl` routes any line containing WARNING to warn level.
    const root = join(scratch(), "never-built");

    const line = describeAdmin(inspectAdminBundle(root)).join("\n");

    expect(line).toContain("WARNING");
    expect(line).toContain(root);
    expect(line).toContain("npm run build");
  });
});

describe("looksLikeFile", () => {
  it("should treat a path whose last segment has an extension as a file request", () => {
    expect(looksLikeFile(`/assets/${ASSET}`)).toBe(true);
    expect(looksLikeFile("/favicon.ico")).toBe(true);
  });

  it("should treat an extensionless path as a route the SPA should answer", () => {
    expect(looksLikeFile("/")).toBe(false);
    expect(looksLikeFile("/jobs")).toBe(false);
    expect(looksLikeFile("/conversations/conv:01JABCDEF")).toBe(false);
  });

  it("should only look at the last segment", () => {
    // A dot earlier in the path is not a file extension.
    expect(looksLikeFile("/v1.2/jobs")).toBe(false);
  });
});

describe("the admin at /admin", () => {
  describe("happy path", () => {
    it("should serve the bundle's index.html at the mount path itself", async () => {
      const app = await serve(fakeBundle());

      const response = await fetch(`${app.baseUrl}${ADMIN_BASE_PATH}`);
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toMatch(/text\/html/);
      expect(body).toContain(`id="root"`);
    });

    it("should redirect the bare mount path to its trailing-slash form", async () => {
      // `fetch` follows this, which is why the case above reads as a plain 200.
      // Asserted separately so the redirect is a decision rather than a
      // coincidence: it is what keeps a relative URL inside the page resolving
      // against /admin/ rather than against /.
      const app = await serve(fakeBundle());

      const response = await fetch(`${app.baseUrl}${ADMIN_BASE_PATH}`, { redirect: "manual" });

      expect(response.status).toBe(301);
      expect(response.headers.get("location")).toBe(`${ADMIN_BASE_PATH}/`);
    });

    it("should serve it at the mount path with a trailing slash as well", async () => {
      const app = await serve(fakeBundle());

      const response = await fetch(`${app.baseUrl}${ADMIN_BASE_PATH}/`);

      expect(response.status).toBe(200);
      expect(await response.text()).toContain(`id="root"`);
    });

    it("should serve index.html for a deep link the SPA owns, so a reload works", async () => {
      // The history fallback. Without it, opening /admin/jobs directly — or
      // reloading it — is a 404 from a server that has never heard of the
      // route, and the admin appears broken only on refresh.
      const app = await serve(fakeBundle());

      const response = await fetch(`${app.baseUrl}${ADMIN_BASE_PATH}/jobs`);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toMatch(/text\/html/);
      expect(await response.text()).toContain(`id="root"`);
    });

    it("should serve a hashed asset with its own content type", async () => {
      const app = await serve(fakeBundle());

      const response = await fetch(`${app.baseUrl}${ADMIN_BASE_PATH}/assets/${ASSET}`);

      expect(response.status).toBe(200);
      expect(await response.text()).toContain("export const admin");
      expect(response.headers.get("content-type")).toMatch(/javascript/);
    });

    it("should let a hashed asset be cached forever and never the HTML", async () => {
      // The filename carries the hash, so the asset is immutable by
      // construction. index.html is not, and caching it is how a rebuilt admin
      // keeps loading last week's JavaScript.
      const app = await serve(fakeBundle());

      const asset = await fetch(`${app.baseUrl}${ADMIN_BASE_PATH}/assets/${ASSET}`);
      const page = await fetch(`${app.baseUrl}${ADMIN_BASE_PATH}/`);

      expect(asset.headers.get("cache-control")).toContain("immutable");
      expect(page.headers.get("cache-control")).toMatch(/no-store|no-cache/);
    });

    it("should serve a bundle that lives under a dot-directory", async () => {
      // Not hypothetical: `send` refuses any ABSOLUTE path containing a
      // dot-directory, so a bundle under `~/.syl/admin` — or an agent worktree
      // in `.claude/` — answered 404 with no explanation and looked precisely
      // like a missing file. Caught by the real-bundle integration test only
      // because this checkout happens to sit under one.
      const app = await serve(fakeBundle(join(".hidden", "dist")));

      const page = await fetch(`${app.baseUrl}${ADMIN_BASE_PATH}/`);
      const asset = await fetch(`${app.baseUrl}${ADMIN_BASE_PATH}/assets/${ASSET}`);

      expect(page.status).toBe(200);
      expect(await page.text()).toContain(`id="root"`);
      expect(asset.status).toBe(200);
    });

    it("should pick the bundle up without a restart once it is built", async () => {
      // Presence is decided per request, not once at mount. The alternative
      // makes `npm run build` in one terminal require a restart in the other,
      // which is exactly the friction that trains people to skip the build.
      const root = scratch();
      const app = await serve(root);

      const before = await fetch(`${app.baseUrl}${ADMIN_BASE_PATH}/`);
      expect(before.status).toBe(500);

      mkdirSync(join(root, "assets"), { recursive: true });
      writeFileSync(join(root, "index.html"), `<!doctype html><div id="root"></div>`);

      const after = await fetch(`${app.baseUrl}${ADMIN_BASE_PATH}/`);
      expect(after.status).toBe(200);
    });
  });

  describe("error path", () => {
    it("should refuse loudly with a 500, not a 404, when the bundle was never built", async () => {
      // The failure this whole route was written around. `tsc` losing the .sql
      // migrations produced a service that started cleanly and failed hours
      // later; a missing frontend bundle has the identical shape, and a 404
      // here reads as a routing bug rather than as a build that omitted the
      // admin. So it must be a different answer, and it must say what to do.
      const root = join(scratch(), "never-built");
      const app = await serve(root);

      const response = await fetch(`${app.baseUrl}${ADMIN_BASE_PATH}/`);
      const body = (await response.json()) as Envelope;

      expect(response.status).toBe(500);
      expect(response.headers.get("content-type")).toMatch(/application\/json/);
      expect(body.success).toBe(false);
      expect(body.error?.code).not.toBe("NOT_FOUND");
      expect(body.error?.message).toContain("npm run build");
      expect(body.error?.details?.["adminDir"]).toBe(root);
    });

    it("should answer a missing asset with the contract's 404, not with the SPA page", async () => {
      // A stale index.html asking for an asset that is not there must fail as
      // a missing file. Answering HTML makes the browser report a MIME type
      // error instead, which points at the wrong problem entirely.
      const app = await serve(fakeBundle());

      const response = await fetch(`${app.baseUrl}${ADMIN_BASE_PATH}/assets/gone.js`);
      const body = (await response.json()) as Envelope;

      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toMatch(/application\/json/);
      expect(body.error?.code).toBe("NOT_FOUND");
    });

    it("should not answer a write to the admin path with a page", async () => {
      const app = await serve(fakeBundle());

      const response = await fetch(`${app.baseUrl}${ADMIN_BASE_PATH}/jobs`, { method: "POST" });
      const body = (await response.json()) as Envelope;

      expect(response.status).toBe(404);
      expect(body.error?.code).toBe("NOT_FOUND");
    });

    it("should not serve a file from outside the bundle directory", async () => {
      const root = fakeBundle();
      writeFileSync(join(root, "..", "syl-admin-secret.txt"), "not yours");
      const app = await serve(root);

      const response = await fetch(`${app.baseUrl}${ADMIN_BASE_PATH}/..%2fsyl-admin-secret.txt`);

      expect(response.status).not.toBe(200);
      expect(await response.text()).not.toContain("not yours");
    });
  });

  describe("mount ordering — the API must stay the API", () => {
    it("should leave an unknown API path answering the contract's JSON 404", async () => {
      // THE regression this file exists for. A history fallback is a catch-all;
      // mounted one line too early, or scoped one path segment too wide, it
      // answers /api/v1/anything with an HTML page — and a client that cannot
      // parse Syl's envelope is entitled to conclude it is not talking to Syl.
      const app = await serve(fakeBundle());

      const response = await fetch(`${app.baseUrl}${API_BASE_PATH}/nope`);
      const body = (await response.json()) as Envelope;

      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toMatch(/application\/json/);
      expect(body.error?.code).toBe("NOT_FOUND");
      expect(body.error?.message).toBe(NO_ROUTE_MESSAGE);
    });

    it("should leave an unknown API path a JSON 404 even when the bundle is absent", async () => {
      // The missing-bundle branch is a second catch-all with a second chance to
      // swallow the API, and it fails 500 rather than 404 — which would be a
      // far worse thing to hand a client.
      const app = await serve(join(scratch(), "never-built"));

      const response = await fetch(`${app.baseUrl}${API_BASE_PATH}/nope`);
      const body = (await response.json()) as Envelope;

      expect(response.status).toBe(404);
      expect(body.error?.message).toBe(NO_ROUTE_MESSAGE);
    });

    it("should leave the health endpoint answering", async () => {
      const app = await serve(fakeBundle());

      const response = await fetch(`${app.baseUrl}${API_BASE_PATH}/health`);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toMatch(/application\/json/);
    });

    it("should leave every other unrouted path a JSON 404 rather than the admin page", async () => {
      // Static serving is additive. `/` is not the admin, and nothing outside
      // /admin may start returning HTML because the admin now exists.
      const app = await serve(fakeBundle());

      for (const path of ["/", "/nope", "/adminx", "/admin-not-really"]) {
        const response = await fetch(`${app.baseUrl}${path}`);
        const body = (await response.json()) as Envelope;

        expect(response.status, path).toBe(404);
        expect(body.error?.message, path).toBe(NO_ROUTE_MESSAGE);
      }
    });
  });
});
