import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * The build gate for the admin bundle.
 *
 * Driven as a subprocess rather than imported, for the same reason
 * `backend/tests/unit/copy-assets.test.ts` drives its own: what is being tested
 * is a *gate*, and a gate is its exit code. Importing the functions would test
 * the checking and skip the only behaviour that stops a broken build shipping.
 *
 * Why the gate exists at all: Syl serves this bundle at `/admin`. A build that
 * omits it produces a 404 from a route that looks perfectly well written, hours
 * later, on a phone. `backend/scripts/copy-assets.mjs` exists because `tsc`
 * silently dropped the `.sql` migrations and took a server down; this is the
 * same failure wearing a different hat, and it gets the same discipline.
 */
const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "scripts",
  "check-bundle.mjs",
);

interface RunResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function run(distDir: string, base = "/admin/"): RunResult {
  try {
    const stdout = execFileSync(
      process.execPath,
      [SCRIPT, "--dist", distDir, "--base", base],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    // Safe assertion: `execFileSync` throws this shape on a non-zero exit, and
    // every field is re-tested by the callers below.
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? -1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

let scratch: string;
let distDir: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "syl-bundle-"));
  distDir = join(scratch, "dist");
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** Write a bundle in the shape `vite build --base /admin/` emits. */
function writeBundle(options: { readonly html?: string; readonly asset?: boolean } = {}): void {
  mkdirSync(join(distDir, "assets"), { recursive: true });
  if (options.asset !== false) {
    writeFileSync(join(distDir, "assets", "index-abc123.js"), "export const admin = true;\n");
    writeFileSync(join(distDir, "assets", "index-abc123.css"), ":root{}\n");
  }
  writeFileSync(
    join(distDir, "index.html"),
    options.html ??
      `<!doctype html><html><head>` +
        `<link rel="stylesheet" href="/admin/assets/index-abc123.css">` +
        `<script type="module" src="/admin/assets/index-abc123.js"></script>` +
        `</head><body><div id="root"></div></body></html>`,
  );
}

describe("check-bundle", () => {
  describe("happy path", () => {
    it("should accept a bundle whose every referenced asset is present under the base", () => {
      writeBundle();

      const result = run(distDir);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("index.html");
    });

    it("should ignore external and relative URLs, which are not this gate's business", () => {
      writeBundle({
        html:
          `<!doctype html><html><head>` +
          `<link rel="preconnect" href="https://example.com/x.css">` +
          `<script type="module" src="/admin/assets/index-abc123.js"></script>` +
          `</head><body><div id="root"></div></body></html>`,
      });

      expect(run(distDir).status).toBe(0);
    });
  });

  describe("error path", () => {
    it("should fail when the build output directory does not exist at all", () => {
      const result = run(join(scratch, "never-built"));

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("BUILD FAILED");
      expect(result.stderr).toContain(join(scratch, "never-built"));
    });

    it("should fail when index.html is missing", () => {
      mkdirSync(join(distDir, "assets"), { recursive: true });
      writeFileSync(join(distDir, "assets", "index-abc123.js"), "export const admin = true;\n");

      const result = run(distDir);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("index.html");
    });

    it("should fail when the page references nothing, which is a shell rather than a build", () => {
      // The exact shape of a silent failure: a valid HTML file, zero assets,
      // and a blank admin that looks like a routing bug.
      writeBundle({ html: `<!doctype html><html><body><div id="root"></div></body></html>` });

      const result = run(distDir);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("BUILD FAILED");
    });

    it("should fail when an asset is referenced outside the base the service serves", () => {
      // `base` left at "/" is the likeliest way to break this, and it produces
      // a page that loads and then asks for files Syl answers with a JSON 404.
      writeBundle({
        html:
          `<!doctype html><html><head>` +
          `<script type="module" src="/assets/index-abc123.js"></script>` +
          `</head><body><div id="root"></div></body></html>`,
      });

      const result = run(distDir);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("/admin/");
      expect(result.stderr).toContain("/assets/index-abc123.js");
    });

    it("should fail when a referenced asset was not actually emitted", () => {
      writeBundle({ asset: false });

      const result = run(distDir);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("index-abc123.js");
    });
  });

  describe("edge cases", () => {
    it("should reject an unknown argument rather than silently checking the default", () => {
      let status = 0;
      try {
        execFileSync(process.execPath, [SCRIPT, "--nope"], { stdio: ["ignore", "pipe", "pipe"] });
      } catch (error) {
        status = (error as { status?: number }).status ?? -1;
      }

      expect(status).not.toBe(0);
    });

    it("should accept a base given without its trailing slash", () => {
      writeBundle();

      expect(run(distDir, "/admin").status).toBe(0);
    });
  });
});
