import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * The shared fixtures — the same bytes `shared/fixtures/` ships and the mock
 * server serves.
 *
 * Why this exists rather than `import { fixture } from "@syl/shared/fixtures"`:
 * that module resolves its paths through `shared/src/spec.ts`, which calls
 * `fileURLToPath(new URL(…, import.meta.url))`. Under the `jsdom` environment
 * `import.meta.url` is an `http:` URL, so the package's own loader throws
 * `The URL must be of scheme file` before a single fixture is read — and every
 * DOM test in this workspace runs under jsdom by necessity.
 *
 * Reading the JSON directly sidesteps that and costs nothing: the point of a
 * fixture is the bytes, and these are the bytes.
 */

let cachedRoot: string | undefined;

/** Walk up from the working directory until `shared/fixtures` appears. */
function fixturesDir(): string {
  if (cachedRoot !== undefined) return cachedRoot;

  // The suite runs from the repo root (`npm test`) and from this workspace
  // (`npm test -w frontend`), so neither can be assumed.
  let directory = resolve(process.cwd());
  for (;;) {
    const candidate = join(directory, "shared", "fixtures");
    if (existsSync(join(candidate, "manifest.json"))) {
      cachedRoot = candidate;
      return candidate;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error(`No shared/fixtures directory above ${process.cwd()}.`);
    }
    directory = parent;
  }
}

/** A fixture body by name, e.g. `http/jobs.page`. Exactly what goes on the wire. */
export function fixture(name: string): unknown {
  const path = join(fixturesDir(), `${name}.json`);
  if (!existsSync(path)) {
    throw new Error(`No fixture at ${path}. Check shared/fixtures/manifest.json.`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

/** A fixture wrapped in a `Response`, as the transport would hand it back. */
export function fixtureResponse(name: string, status = 200): Response {
  return new Response(JSON.stringify(fixture(name)), {
    status,
    headers: { "content-type": "application/json" },
  });
}
