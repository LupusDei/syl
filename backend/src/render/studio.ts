import { constants, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where her renders live, which is **her own home**.
 *
 * ## The ruling, 2026-08-11
 *
 * The Commander: *"her videos should be generated and placed within her context
 * I think. certainly not in temp or in the runway project."*
 *
 * Both halves of that were true of the first version of this file, and both
 * were wrong for the same reason.
 *
 * **They lived in somebody else's repository.** The root defaulted to
 * `../runwayml`, a separate toolkit checkout beside this one. Everything else
 * of hers is under `~/.syl` — her database, her sessions, her memory, her
 * `tools/hands.json` — and a render is her record of her own face. She must not
 * stop being able to render because a directory beside the repo was moved or
 * deleted, and a checkout that belongs to a different project must not be
 * holding the one picture everything she looks like hangs on.
 *
 * **And nothing of hers may sit where the operating system may empty it.**
 * macOS purges `/tmp`. `SOUL.md` says *"Never delete a render, and never let
 * one be deleted. Not the failures, especially not the failures"* — so any part
 * of the record written somewhere temporary makes that instruction quietly
 * false. The stills are part of the record: they are the only way a language
 * model can look at fifteen seconds of video.
 *
 * The keeping-media-out-of-git argument that put the renders in the toolkit is
 * still correct and is unaffected. A fifteen-second render is 12–15MB. Her home
 * is not a repository; it is where her data has always gone.
 *
 * ## The layout
 *
 *     ~/.syl/renders/<name>.mp4          the render
 *     ~/.syl/renders/<name>.mp4.json     what made it
 *     ~/.syl/renders/reference.png       her likeness, what they all anchor on
 *     ~/.syl/renders/frames/<name>/      the stills she looked at
 *
 * Flat and obvious on purpose. `characters/syl/video` was the *toolkit's*
 * nesting — it disambiguated her from other characters in a repository that
 * had several, and under her own home it says nothing a person opening the
 * directory needs.
 *
 * `scripts/video/generate.mjs` resolves the same directory by the same rule, so
 * a render she made and a render the script made land in the same place under
 * the same naming rule, and either can find the other.
 */

/**
 * Her likeness, in her home, relative to it.
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
 *
 * The name says what the file is FOR rather than where it came from, because in
 * her home there is exactly one reference and a person opening the directory
 * should be able to tell what it does. Its provenance — the 1120x832
 * `syl_source.png` the eight loops were made against — is {@link referenceSeed}
 * and `docs/VIDEO.md`.
 */
export const DEFAULT_REFERENCE = "renders/reference.png";

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
  /** Her home. Everything below is inside it. */
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

/** A studio rooted at a given directory, which is normally her home. */
export function studioAt(root: string): Studio {
  const videoDir = resolve(root, "renders");
  // Inside `renders/` rather than beside it: the stills belong to the render
  // they came out of, and one directory called `renders` is what a person
  // opening her home is looking for.
  const frameDir = resolve(videoDir, "frames");

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
 * **Her home**, which `bootstrap` has already worked out with `sylHome` — the
 * same answer `turnHome` and `tools/hands.json` are given, rather than a second
 * one computed here that could drift from it.
 *
 * `SYL_VIDEO_STUDIO` still overrides, because tests and other machines need
 * one: it is what keeps the suite out of `~/.syl`, so it is a mechanism rather
 * than a convenience.
 *
 * @param env Where an override would be declared.
 * @param home `sylHome(config)` — absent only for an in-memory database.
 * @param here This module's directory: `backend/src` from source and
 *   `backend/dist` from a build, which is the same depth either way.
 */
export function studioRootFrom(
  env: NodeJS.ProcessEnv = process.env,
  home?: string,
  here: string = dirname(dirname(fileURLToPath(import.meta.url))),
): string {
  const declared = env["SYL_VIDEO_STUDIO"]?.trim();
  if (declared !== undefined && declared !== "") return resolve(declared);
  if (home !== undefined && home.trim() !== "") return resolve(home);
  // No home means an in-memory database, which means a test. `.syl/` beside the
  // source is where `DEFAULT_DATABASE_PATH` puts the database when nothing says
  // otherwise, so this is the same home arrived at the same way — and it is
  // emphatically not a temp directory, which is the thing this file exists to
  // stop. Resolved from the module rather than from `cwd`, because the service
  // is started by launchd with a working directory nobody chose.
  return resolve(here, "..", "..", ".syl");
}

/**
 * The reference that ships with the source, used to seed her home.
 *
 * `assets/syl_source.png` is the 1120x832 still every one of the eight loops
 * was rendered against, byte for byte. It is in the repository so that her
 * likeness does not depend on another project existing: it is the single thing
 * every render hangs on, and losing it does not fail loudly — it renders a
 * stranger, expensively.
 */
export function referenceSeed(
  here: string = dirname(dirname(fileURLToPath(import.meta.url))),
): string {
  // `here` is `backend/src` from source and `backend/dist` from a build, so two
  // levels up is the repository root either way.
  return resolve(here, "..", "..", "assets", "syl_source.png");
}

/** What a boot did about her likeness. */
export type ReferencePlacement =
  /** It was already in her home. Nothing was touched. */
  | "present"
  /** It was not, and the copy that ships with the source was placed there. */
  | "copied"
  /** It is not there and could not be placed. She will refuse to render. */
  | "unplaced";

/**
 * Put her likeness in her home if it is not there already.
 *
 * Two rules, and they are the same rule twice:
 *
 * - **Never overwrite.** What is in her home is hers. A boot does not get to
 *   replace it with whatever happened to ship in this checkout — that is how a
 *   reference she chose would silently revert to the one he guessed.
 * - **Never throw.** A boot must not die because a picture is missing.
 *   `RenderService.start` already refuses with a sentence naming the missing
 *   path, which is where a person can act on it, and no credit is spent.
 */
export function ensureReference(studio: Studio, seed: string = referenceSeed()): ReferencePlacement {
  const target = studio.reference();
  if (existsSync(target)) return "present";
  if (!existsSync(seed)) return "unplaced";

  try {
    mkdirSync(dirname(target), { recursive: true });
    // `COPYFILE_EXCL` makes "never overwrite" a property of the syscall rather
    // than of the check above it, which is what closes the gap between them.
    copyFileSync(seed, target, constants.COPYFILE_EXCL);
    return "copied";
  } catch {
    return existsSync(target) ? "present" : "unplaced";
  }
}
