import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where her renders live, which is deliberately **not in this repository**.
 *
 * A fifteen-second render is 12–15MB and the eight existing loops are over
 * 100MB; `assets/*.mp4` is gitignored here for exactly that reason. The toolkit
 * repo owns the media, this repo owns the *recipe* — which is the part worth
 * versioning, and the part that was missing when the first eight were made.
 *
 * `scripts/video/generate.mjs` resolves the same directory the same way, from
 * `SYL_VIDEO_STUDIO` or from `../runwayml` beside the repo. One place, one
 * layout: a render Syl made and a render the script made sit in the same
 * directory, under the same naming rule, and either can be found by the other.
 */

/**
 * The still everything hangs on. See `docs/VIDEO.md`.
 *
 * **NOT the upscaled one, and the difference is a hard API limit rather than a
 * preference.** `syl-r3f`: her first two renders both died at Runway's
 * validator before reaching the renderer, and the reason was here.
 *
 *     syl_source.png            1120x832    1.7MB  ->  2.3MB as a data URI
 *     syl_source_upscaled.png   2240x1664   6.8MB  ->  9.1MB as a data URI
 *
 * Runway caps a base64 image at **5MB** (`RUNWAY_API_INDEX.md` §5.2), and
 * base64 adds a third on top of the file. So the upscaled reference cannot be
 * sent at all — the request is rejected as malformed before a single credit is
 * spent, which is why it failed identically twice and read as configuration
 * rather than a blip. She diagnosed that correctly from the error text.
 *
 * The plain still is what produced all eight existing loops, so this is not a
 * downgrade to fit a limit; it is the reference that was always working. And
 * the upscale buys nothing here regardless: §5.4 says a reference outside
 * 640x640-4K is resized anyway, so the extra pixels were being paid for in
 * payload and discarded on arrival.
 *
 * If a larger reference is ever genuinely needed, the route is the ephemeral
 * upload (`POST /v1/uploads` -> a `runway://` URI, 200MB, reusable for 24h),
 * not a bigger data URI.
 */
export const DEFAULT_REFERENCE = "characters/syl/syl_source.png";

/**
 * The prefix on every render Syl made herself.
 *
 * Distinct from `syl-loop-`, which is what `generate.mjs` writes. Not
 * cosmetic: the eight loops predate the sidecar and have no record of what
 * produced them or of what they cost, so the ledger must be able to tell hers
 * from his. It does that by reading *records*, not files — but a name that says
 * which is which is worth having when a person is looking at the directory.
 */
export const RENDER_PREFIX = "syl-";

/**
 * A render name, as a route parameter and as a filename at the same time.
 *
 * Lowercase, digits and hyphens, and nothing else — so it cannot spell `..`,
 * cannot spell a leading `/`, and cannot spell a URL escape that decodes into
 * either. A name that addresses a file is a file read wearing a route, and the
 * cheapest place to close that is at the shape of the name.
 */
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/u;

export function isRenderName(value: unknown): value is string {
  return typeof value === "string" && NAME_PATTERN.test(value);
}

/** The paths a render occupies. */
export interface Studio {
  /** The toolkit checkout that owns the media. */
  readonly root: string;
  /** Where mp4s and their sidecars go. */
  readonly videoDir: string;
  /** Where extracted stills go, one directory per render. */
  readonly frameDir: string;
  /** The reference image handed to the model, absolute. */
  reference(relative?: string): string;
  /** The mp4 for a render. */
  video(name: string): string;
  /** The sidecar beside it — `<video>.json`, exactly as `generate.mjs` writes. */
  sidecar(name: string): string;
  /** Where this render's stills are kept. */
  frames(name: string): string;
}

/** A studio rooted at a given directory. */
export function studioAt(root: string): Studio {
  const videoDir = resolve(root, "characters", "syl", "video");
  const frameDir = resolve(root, "characters", "syl", "frames");

  return {
    root,
    videoDir,
    frameDir,
    reference: (relative = DEFAULT_REFERENCE) => resolve(root, relative),
    video: (name) => resolve(videoDir, `${name}.mp4`),
    // `<video>.json` rather than `<name>.json`: `generate.mjs` writes it that
    // way, and a sidecar that does not sit beside its video under its video's
    // own name is a sidecar somebody moves the video away from.
    sidecar: (name) => resolve(videoDir, `${name}.mp4.json`),
    frames: (name) => resolve(frameDir, name),
  };
}

/**
 * Where the studio is on this machine.
 *
 * `SYL_VIDEO_STUDIO`, or the toolkit checkout beside this one. Resolved from
 * the module's own location rather than from `cwd`, because the service is
 * started by launchd with a working directory nobody chose.
 */
export function studioRootFrom(
  env: NodeJS.ProcessEnv = process.env,
  here: string = dirname(dirname(fileURLToPath(import.meta.url))),
): string {
  const declared = env["SYL_VIDEO_STUDIO"]?.trim();
  if (declared !== undefined && declared !== "") return resolve(declared);
  // `here` is `backend/src` from source and `backend/dist` from a build — the
  // same depth either way — so three levels up is the directory the repository
  // sits in, and the toolkit checkout sits beside it. The same arithmetic
  // `scripts/video/generate.mjs` does, from its own location.
  return resolve(here, "..", "..", "..", "runwayml");
}
