import { constants, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where her renders live: **her own home**, and nowhere else.
 *
 * Two rules, both of which a previous version of this file broke.
 *
 * **Nothing of hers lives in another project's checkout.** Everything else of
 * hers is under `~/.syl` — her database, her sessions, her memory, her
 * `tools/hands.json`. A render is her record of her own face, and she must not
 * stop being able to make one because a directory beside the repo was moved.
 *
 * **Nothing of hers lives where the operating system may empty it.** macOS
 * purges `/tmp`, and `SOUL.md` requires that no render is ever deleted — so any
 * part of the record written somewhere temporary makes that instruction quietly
 * false. The stills count as part of the record: they are the only way a
 * language model can look at fifteen seconds of video.
 *
 * Media still stays out of git — a fifteen-second render is 12–15MB. Her home is
 * not a repository, which is why it satisfies both rules at once.
 *
 * ## The layout
 *
 *     ~/.syl/renders/<name>.mp4          the render
 *     ~/.syl/renders/<name>.mp4.json     what made it
 *     ~/.syl/renders/reference.png       her likeness, what they all anchor on
 *     ~/.syl/renders/frames/<name>/      the stills she looked at
 *     ~/.syl/renders/parts/              the halves of a render made in two
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
 * Her likeness, in her home, relative to it — **and the frame an anchored render
 * is CUT ON.**
 *
 * Sent as `promptImage` with `position: "last"` on the first half of a render
 * whose subject is her face, which is what stops the model inventing a stranger
 * now that frame one is the ribbon. The second half then starts from the frame
 * that half actually ended on, and unravels back to the ribbon, so the finished
 * clip opens and closes on the ribbon with her face held at the join. See
 * `join.ts` for why that is the only shape available.
 *
 * **Never as `first`.** Sending it there is what made every service render open
 * on her smiling headshot — and it is also what makes a video landscape:
 * measured 2026-08-11, a 4-second probe handed this picture as `first` came
 * back **1112x834**, transposed, because the opening frame decides the aspect
 * and overrules `ratio`. That measurement is why the second half of an anchored
 * render starts from an extracted 834x1112 frame rather than from this file.
 *
 * **It stays 1120x832 and it does not need re-cutting.** The obvious worry with
 * two pictures is that they disagree about shape. Measured on 2026-08-11 with
 * one render each way: a portrait re-cut and this landscape original both
 * produced 834x1112 video with her likeness intact when the RIBBON was `first`.
 * The opening frame decides the shape and the closing picture is fitted into it.
 *
 * **Do not switch this to `syl_source_upscaled.png`.** It cannot be sent:
 *
 *     syl_source.png            1120x832    1.7MB  ->  2.3MB as a data URI
 *     syl_source_upscaled.png   2240x1664   6.8MB  ->  9.1MB as a data URI
 *
 * Runway caps a base64 image at **5MB** (`RUNWAY_API_INDEX.md` §5.2) and base64
 * adds a third on top of the file, so the upscaled still is rejected as a
 * malformed request before any credit is spent. The failure arrives as a union
 * error listing every accepted form, which reads as a URL problem rather than a
 * size one — the giveaway is that it is identical on every retry.
 *
 * The upscale would buy nothing even if it fitted: §5.4 resizes any reference
 * outside 640x640-4K on arrival, so the extra pixels are paid for in payload and
 * discarded.
 *
 * For a genuinely larger reference, use the ephemeral upload
 * (`POST /v1/uploads` -> a `runway://` URI, 200MB, reusable for 24h) rather than
 * a bigger data URI.
 *
 * The name says what the file is FOR rather than where it came from, because in
 * her home there is exactly one reference and a person opening the directory
 * should be able to tell what it does. Its provenance — the 1120x832
 * `syl_source.png` the eight loops were made against — is {@link referenceSeed}
 * and `docs/VIDEO.md`.
 */
export const DEFAULT_REFERENCE = "renders/reference.png";

/**
 * The bare blue ribbon every clip opens on — **and the video's first frame.**
 *
 * `promptImage` is not a style hint. Runway *starts the video from the picture
 * it is handed*, so whatever is here is literally frame one of every render.
 * That is the whole of the Commander's report of 2026-08-11: his renders were
 * arriving with "the template smiling still frame as the first frame", against
 * the eight loops he named as the template, which all open on the ribbon.
 *
 * Two things were being asked of one file and they are not the same job:
 *
 *     reference.png        WHO she is    — a close portrait, her likeness
 *     opening-ribbon.png   WHERE it STARTS — the bare ribbon, frame one
 *
 * `reference.png` is a smiling headshot, so handing it over pinned frame one to
 * her face and left `LOOP_CLAUSE` — which says the clip opens on a ribbon with
 * no figure in it — describing something the model had already been told
 * otherwise. **No wording can move a frame that an image input pins**, which is
 * why rewriting that clause did not fix this and could not have.
 *
 * It also decides the SHAPE. Measured on the artifacts, 2026-08-11: the eight
 * loops are 834x1112 and a service render was 1112x834 — the same pixels,
 * transposed. Both requested `720:1280`. seedance2 takes the video's aspect
 * from `promptImage` and quietly overrules the ratio, and `reference.png` is
 * 1120x832 landscape. So a portrait opening still is what makes a portrait
 * video, and `DEFAULTS.ratio` agreeing with it is belt and braces rather than
 * the mechanism.
 *
 * Named for what it is rather than for the clip it was cut out of: in her home
 * there is one of these, and a person opening the directory should be able to
 * tell what it does.
 */
export const DEFAULT_OPENING = "renders/opening-ribbon.png";

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
  /** Where the halves of a joined render are kept. See {@link Studio.part}. */
  readonly partDir: string;
  /** Her likeness, absolute. What a shot of her face would anchor on. */
  reference(relative?: string): string;
  /** The ribbon still handed to the model as `promptImage`, absolute. Frame one. */
  opening(relative?: string): string;
  /** The mp4 for a render. */
  video(name: string): string;
  /** The sidecar beside it — `<video>.json`, exactly as `generate.mjs` writes. */
  sidecar(name: string): string;
  /** Where this render's stills are kept. */
  frames(name: string): string;
  /**
   * One half of a render that was made in two, numbered from one.
   *
   * **Kept, not cleaned up.** `SOUL.md`: *"Never delete a render, and never let
   * one be deleted."* A half is a render — it cost credits, it is fifteen
   * seconds of her, and the joined file is a derivative of it. It also happens
   * to be the only way to re-cut a join without paying for both halves again.
   *
   * Under `renders/parts/` rather than beside the finished clips so that a
   * person opening `renders/` sees the renders, and so that the ledger — which
   * reads sidecars — is never tempted to count a half as a render of its own.
   */
  part(name: string, index: number): string;
  /** The still a half ends on, and the picture the next half starts from. */
  partFrame(name: string, index: number): string;
  /** The concat list a join was made from. Kept for the same reason as the halves. */
  partList(name: string): string;
}

/** A studio rooted at a given directory, which is normally her home. */
export function studioAt(root: string): Studio {
  const videoDir = resolve(root, "renders");
  // Inside `renders/` rather than beside it: the stills belong to the render
  // they came out of, and one directory called `renders` is what a person
  // opening her home is looking for.
  const frameDir = resolve(videoDir, "frames");
  const partDir = resolve(videoDir, "parts");

  return {
    root,
    videoDir,
    frameDir,
    partDir,
    reference: (relative = DEFAULT_REFERENCE) => resolve(root, relative),
    opening: (relative = DEFAULT_OPENING) => resolve(root, relative),
    video: (name) => resolve(videoDir, `${name}.mp4`),
    // `<video>.json` rather than `<name>.json`: `generate.mjs` writes it that
    // way, and a sidecar that does not sit beside its video under its video's
    // own name is a sidecar somebody moves the video away from.
    sidecar: (name) => resolve(videoDir, `${name}.mp4.json`),
    frames: (name) => resolve(frameDir, name),
    part: (name, index) => resolve(partDir, `${name}-${String(index)}.mp4`),
    // `.png` rather than `.jpg`: this still is handed straight back to Runway as
    // the next half's opening frame, so the join is exact rather than exact plus
    // one round of JPEG.
    partFrame: (name, index) => resolve(partDir, `${name}-${String(index)}-last.png`),
    partList: (name) => resolve(partDir, `${name}.txt`),
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

/**
 * The opening ribbon that ships with the source, used to seed her home.
 *
 * `assets/syl_opening_ribbon.png` is the **first frame of `syl-loop-1-emerge`
 * at native resolution**, 834x1112. It is in the repository for the same reason
 * the reference is: it is what every render starts from, and losing it does not
 * fail loudly — it renders the wrong opening, expensively.
 *
 * The eight loops all open on this exact picture. That is measured rather than
 * assumed: PSNR between the first frames of any two of them is ~35dB, which is
 * one image through two h264 encodes, not two independent generations. So it
 * was a `promptImage` they shared, and this is it, recovered from the only
 * place it survives.
 *
 * Re-cut it with, from the repository root:
 *
 *     ffmpeg -y -ss 0 -i <a syl-loop-*.mp4> -frames:v 1 -pix_fmt rgb24 \
 *       assets/syl_opening_ribbon.png
 *
 * 1.3MB, so ~1.8MB as a data URI, comfortably inside Runway's 5MB cap
 * (`RUNWAY_API_INDEX.md` §5.2). Keep it under that or the request is rejected
 * as malformed with an error that reads like a URL problem — see
 * {@link DEFAULT_REFERENCE} for how that one presents.
 */
export function openingSeed(
  here: string = dirname(dirname(fileURLToPath(import.meta.url))),
): string {
  return resolve(here, "..", "..", "assets", "syl_opening_ribbon.png");
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
  return place(studio.reference(), seed);
}

/**
 * Put the ribbon her clips open on in her home if it is not there already.
 *
 * The same two rules as {@link ensureReference}, and the same reasons. What is
 * in her home is hers; a boot must not die because a picture is missing.
 *
 * Separate from the reference because the two pictures answer different
 * questions — *who she is* and *where the clip starts* — and the boot that
 * places one must be able to report on the other independently. Both are sent
 * now, but not on the same renders: this one is frame one of everything, so its
 * absence stops every render, while a missing reference stops only the framings
 * that show her face.
 */
export function ensureOpening(studio: Studio, seed: string = openingSeed()): ReferencePlacement {
  return place(studio.opening(), seed);
}

/** Copy a seed picture into her home, once, without ever replacing one. */
function place(target: string, seed: string): ReferencePlacement {
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
