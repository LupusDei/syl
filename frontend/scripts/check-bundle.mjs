#!/usr/bin/env node
/**
 * Fail the build if the admin bundle is not actually there.
 *
 * Syl serves this bundle at `/admin` from her own origin. A build that omits
 * it, or emits it under the wrong prefix, does not fail — it produces a 404 or
 * a blank page, hours later, on a phone, and it reads as a routing bug rather
 * than as a build step that did nothing. That is the same failure
 * `backend/scripts/copy-assets.mjs` was written for: `tsc` silently dropped the
 * `.sql` migrations, the service started cleanly, applied zero migrations, and
 * fell over on the first query. This is that discipline applied to the admin.
 *
 * Three checks, each of which has a way of quietly coming true:
 *
 *  1. `index.html` exists. Without it there is no page and no history fallback.
 *  2. The page references at least one asset. A valid HTML file with zero
 *     assets is a shell, not a build, and it renders as a blank admin.
 *  3. Every absolute URL it references starts with the base the service serves
 *     from, and names a file that was actually emitted. `base` left at `/` is
 *     the likeliest way to break this and the hardest to see: the page loads,
 *     asks for `/assets/index-<hash>.js`, and gets Syl's JSON 404 — which the
 *     browser reports as a MIME type error, pointing at the wrong problem.
 *
 * The base defaults to `/admin/` and must equal `ADMIN_BASE_PATH` in
 * `backend/src/routes/admin.ts`. Nothing here can enforce that across the
 * workspace boundary; `backend/tests/integration/admin-bundle.test.ts` builds
 * this bundle for real and checks the two agree.
 *
 * Usage:
 *   node scripts/check-bundle.mjs [--dist <dir>] [--base <path>]
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = join(scriptDir, "..");

/** Where the built admin lives, and the path it is served under. */
export const DEFAULT_BASE = "/admin/";

/**
 * @param {readonly string[]} argv
 * @returns {{ distDir: string, base: string }}
 */
export function parseArgs(argv) {
  let distDir = join(workspaceRoot, "dist");
  let base = DEFAULT_BASE;

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--dist" || flag === "--base") {
      if (value === undefined) throw new Error(`${flag} needs a value.`);
      if (flag === "--dist") distDir = value;
      else base = value;
      i += 1;
    } else {
      throw new Error(
        `Unknown argument ${flag}. Usage: check-bundle.mjs [--dist <dir>] [--base <path>]`,
      );
    }
  }

  // A base is a directory prefix; the trailing slash is what makes
  // `/adminx/...` fail to match `/admin/`. Accepted either way, normalised once.
  return { distDir, base: base.endsWith("/") ? base : `${base}/` };
}

/**
 * Every absolute URL the page asks the server for.
 *
 * Only absolute ones: a relative URL resolves against the page's own location
 * and so is correct under any base, and an external one is not this gate's
 * business.
 *
 * @param {string} html
 * @returns {string[]}
 */
export function referencedUrls(html) {
  /** @type {Set<string>} */
  const found = new Set();
  for (const match of html.matchAll(/(?:src|href)="(\/[^"]*)"/gu)) {
    if (match[1] !== undefined) found.add(match[1]);
  }
  return [...found].sort();
}

/**
 * Check a built bundle.
 *
 * @param {{ distDir: string, base: string }} options
 * @returns {{ problems: string[], urls: string[] }}
 */
export function checkBundle({ distDir, base }) {
  /** @type {string[]} */
  const problems = [];
  const indexPath = join(distDir, "index.html");

  if (!existsSync(indexPath)) {
    problems.push(`there is no index.html at ${indexPath}`);
    return { problems, urls: [] };
  }

  const urls = referencedUrls(readFileSync(indexPath, "utf8"));

  if (urls.length === 0) {
    problems.push(
      "index.html references no assets at all, which is a shell rather than a build",
    );
  }

  for (const url of urls) {
    if (!url.startsWith(base)) {
      problems.push(
        `${url} is not under ${base}, so the service will answer it with a 404 ` +
          `(is Vite's \`base\` still "${base}"?)`,
      );
      continue;
    }
    const onDisk = join(distDir, url.slice(base.length));
    if (!existsSync(onDisk)) {
      problems.push(`${url} is referenced but ${onDisk} was not emitted`);
    }
  }

  return { problems, urls };
}

function main() {
  const { distDir, base } = parseArgs(process.argv.slice(2));
  const { problems, urls } = checkBundle({ distDir, base });

  if (problems.length > 0) {
    console.error(
      [
        "",
        "[syl] BUILD FAILED: the admin bundle is not servable.",
        "",
        `  dist: ${distDir}`,
        `  base: ${base}`,
        "",
        ...problems.map((problem) => `  - ${problem}`),
        "",
        "  Syl serves this bundle at /admin from her own origin. A build that",
        "  omits it does not fail — it produces a 404 or a blank page, hours",
        "  later, on a phone, and it reads as a routing bug rather than as a",
        "  build step that did nothing. Exactly how the missing .sql migrations",
        "  took a server down.",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }

  console.log(
    `[syl] admin bundle ok in ${relative(workspaceRoot, distDir) || distDir}: ` +
      `index.html and ${urls.length} asset${urls.length === 1 ? "" : "s"} under ${base}`,
  );
  for (const url of urls) console.log(`        ${url}`);
}

// Run only when executed directly, so importing this module checks nothing.
if (process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
