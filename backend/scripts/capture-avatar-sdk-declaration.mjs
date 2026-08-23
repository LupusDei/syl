#!/usr/bin/env node
/**
 * Capture the avatar SDK's own type declaration, from the published tarball.
 *
 * ## Why this exists
 *
 * `syl-chzl.10`: the face page passed `onConnected` and `onDisconnected` to
 * `AvatarCall`, which accepts neither. React spread them onto a `div` and
 * dropped them, so the page's whole lifecycle was unreachable code in a shipped
 * build — and nothing could have caught it, because the SDK is imported from a
 * CDN at runtime. There is no install, no lockfile and no compiler between us
 * and the vendor's prop names.
 *
 * So the declaration is captured HERE and asserted against in
 * `tests/unit/face-page-vendor-props.test.ts`. It is a fixture in exactly the
 * sense this project already means: **real captured output, never written by
 * hand from our own idea of the shape.** Editing the fixture to make a test
 * pass is the one thing that would make all of this worthless.
 *
 * ## Usage
 *
 *     node backend/scripts/capture-avatar-sdk-declaration.mjs
 *
 * It reads {@link RUNWAY_AVATARS_VERSION} from the page module, so bumping the
 * pinned version and re-running is the whole refresh. It writes nothing if the
 * download does not look like a declaration, because a fixture that is silently
 * an error page is worse than no fixture.
 */
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");

const PACKAGE = "@runwayml/avatars-react";
/**
 * Where the capture lands, and **why it is `.txt` rather than `.d.ts`**.
 *
 * `backend/tsconfig.json` includes `tests/**\/*.ts`, so a `.d.ts` here is
 * compiled as a real declaration file — and this one imports
 * `@livekit/components-react`, `livekit-client` and `@runwayml/avatars`, none of
 * which are installed. It typechecks today only because `skipLibCheck` is on in
 * `tsconfig.base.json`. That is a load-bearing coincidence: turning that flag
 * off, which is an ordinary tightening someone will eventually propose, would
 * break the whole workspace's typecheck because of a **test fixture**.
 *
 * A captured artifact is data, not code. Naming it `.txt` says so and removes
 * the coupling entirely; the test reads it as text either way.
 */
export const FIXTURE_PATH = path.join(
  repo,
  "backend",
  "tests",
  "fixtures",
  "runway-avatars-react-declaration.txt",
);

/**
 * The pinned version, read from the page rather than from an argument.
 *
 * Parsed out of the source instead of imported, so this script needs no
 * TypeScript loader and cannot be broken by anything else in that module.
 */
async function pinnedVersion() {
  const source = await readFile(path.join(repo, "backend", "src", "routes", "face-page.ts"), "utf8");
  const found = /RUNWAY_AVATARS_VERSION = "([^"]+)"/.exec(source);
  if (!found) throw new Error("face-page.ts no longer declares RUNWAY_AVATARS_VERSION");
  return found[1];
}

async function main() {
  const version = await pinnedVersion();
  const spec = `${PACKAGE}@${version}`;
  console.log(`capturing the declaration for ${spec}`);

  const meta = await fetch(`https://registry.npmjs.org/${PACKAGE}/${version}`);
  if (!meta.ok) throw new Error(`npm returned ${meta.status} for ${spec}`);
  const tarball = (await meta.json()).dist?.tarball;
  if (!tarball) throw new Error(`no tarball url in the registry entry for ${spec}`);

  const work = path.join(tmpdir(), `syl-avatar-sdk-${process.pid}`);
  await mkdir(work, { recursive: true });
  try {
    const archive = path.join(work, "pkg.tgz");
    const download = await fetch(tarball);
    if (!download.ok) throw new Error(`the tarball returned ${download.status}`);
    await pipeline(Readable.fromWeb(download.body), createWriteStream(archive));
    await run("tar", ["xzf", archive, "-C", work]);

    const declaration = await readFile(path.join(work, "package", "dist", "index.d.ts"), "utf8");

    // A fixture that is quietly an error page, a redirect or an empty file is
    // worse than none: it would make the guard pass by matching nothing.
    if (!declaration.includes("declare function AvatarCall")) {
      throw new Error("the downloaded file does not declare AvatarCall; refusing to write it");
    }

    await writeFile(
      FIXTURE_PATH,
      // The version goes IN the file. The test compares it with the page's pin,
      // so bumping one without re-running this script fails rather than drifts.
      `// CAPTURED, NOT WRITTEN. ${spec}\n` +
        `// Source: ${tarball}\n` +
        `// Refresh: node backend/scripts/capture-avatar-sdk-declaration.mjs\n` +
        `// Do not edit to make a test pass — see the script's header.\n` +
        declaration,
      "utf8",
    );
    console.log(`wrote ${path.relative(repo, FIXTURE_PATH)} (${declaration.length} bytes)`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

await main();
