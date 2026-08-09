import { existsSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where the built web admin lives, and whether it is actually there.
 *
 * Kept apart from `routes/admin.ts` — which mounts it — for the same reason
 * `ops/tailnet-cert.ts` is apart from `routes/health.ts`: `config.ts` needs the
 * default path, and configuration may not depend on Express.
 *
 * **The failure this module exists to make loud.** `tsc` emits JavaScript and
 * copies nothing else, so a build that lost the `.sql` migrations started
 * cleanly, applied zero migrations and fell over hours later — which is why
 * `backend/scripts/copy-assets.mjs` fails the build when it copies nothing. A
 * missing frontend bundle is the same failure in a different costume: `/admin`
 * answers 404, the 404 reads as a routing bug, and nobody looks at the build.
 * So a missing bundle is reported at boot, in the startup lines, and answered
 * with a diagnostic 500 rather than a 404.
 *
 * What it deliberately does *not* do is refuse to start. Syl holds reminder
 * delivery guarantees; the admin is explicitly a development instrument. An
 * assistant that will not boot because a debug page was not compiled has traded
 * the important guarantee for the unimportant one.
 */

/**
 * The repo root, from `backend/src/ops/admin-bundle.ts`.
 *
 * Three levels either way: `backend/src/ops` and `backend/dist/ops` are both
 * two directories under `backend`, so the built service resolves this to the
 * same place the source one does.
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * Where `npm run build` leaves the admin.
 *
 * `frontend/dist` is the frontend workspace's own build output, so the bundle
 * Syl serves is the artefact `npm run build` already produces at the repo root
 * — not a copy that some extra step has to remember to make, and can therefore
 * forget.
 */
export const DEFAULT_ADMIN_DIR = join(REPO_ROOT, "frontend", "dist");

/** The built admin's directory, overridable for a deployment that moves it. */
export function defaultAdminDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env["SYL_ADMIN_DIR"]?.trim();
  return configured === undefined || configured === "" ? DEFAULT_ADMIN_DIR : configured;
}

/** A build output, as the service finds it on disk. */
export interface AdminBundle {
  /** The directory the static files are served from. */
  readonly root: string;
  /** The page every SPA route falls back to. */
  readonly indexPath: string;
  /** Whether {@link indexPath} exists right now. */
  readonly present: boolean;
}

/**
 * Look at the bundle directory.
 *
 * `index.html` is the probe rather than the directory itself: an empty `dist/`
 * left behind by a failed or interrupted build is a *missing* bundle, and
 * reporting it as present is exactly the silent degradation being guarded
 * against.
 *
 * Cheap enough to call per request, which is what `routes/admin.ts` does — so
 * running `npm run build` in one terminal does not require a restart in the
 * other. Friction there is what trains people to skip the build.
 */
export function inspectAdminBundle(root: string): AdminBundle {
  const indexPath = join(root, "index.html");
  return { root, indexPath, present: existsSync(indexPath) };
}

/**
 * Is this request for a file, or for a route the SPA should answer?
 *
 * The rule is the last segment's extension. A request for
 * `/assets/index-Bwe9VNQj.js` that misses must fail as a missing file; handing
 * back `index.html` instead makes the browser report a MIME type error, which
 * points at the wrong problem entirely and has cost whole afternoons elsewhere.
 *
 * The cost of the rule is that an SPA route whose last segment contains a dot
 * would be treated as a file. Syl's ids are `kind:ULID` — colons, never dots —
 * so no route the admin owns can hit that today.
 */
export function looksLikeFile(path: string): boolean {
  const lastSegment = path.slice(path.lastIndexOf("/") + 1);
  return extname(lastSegment) !== "";
}

/**
 * The startup lines for the admin.
 *
 * Shaped like `describeRuntime` and `describePower`: lines returned rather than
 * printed, so a test can read them. `startSyl` sends any line containing
 * WARNING to the log at warn level, which is what makes an unbuilt admin
 * visible on the boot the build was missed rather than on the day someone tries
 * to open it.
 */
export function describeAdmin(bundle: AdminBundle): readonly string[] {
  if (bundle.present) return [`[syl] admin at /admin (from ${bundle.root})`];

  return [
    `[syl] WARNING: no admin bundle at ${bundle.root}. /admin will answer 500, ` +
      `not a page, until \`npm run build\` runs. This build did not include the admin.`,
  ];
}
