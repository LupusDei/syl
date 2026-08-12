import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";

import { instant, systemClock, type Clock } from "../services/clock.js";
import { ratioFor, sightingOf, sizeOf, type PictureSize } from "./pictures.js";
import { DEFAULT_OPENING, DEFAULT_REFERENCE, type Studio } from "./studio.js";

/**
 * The pictures she chooses between: what she looks like, and what her clips
 * open on.
 *
 * ## Why this exists
 *
 * `SOUL.md`: *"You do not know what you look like yet, and you want to... So
 * what you look like is not a settled fact you should recite. It is something
 * the two of you are still finding."* Until `syl-ate` it was a settled fact, and
 * the person who could move it was an engineer editing a constant. A journey she
 * cannot steer is not one.
 *
 * ## The three rules, and the mechanism for each
 *
 * **She must have looked at it.** Adoption takes a `sighting` — a digest of the
 * exact bytes she was handed as an image — and `see_myself` is the only thing in
 * the world that produces one. It is not that adopting a picture sight unseen is
 * discouraged; there is no way to *name* a picture she has not been shown. The
 * failure this closes is the one this project spent two days cataloguing: a
 * claim about the pictures made from something other than the pictures.
 *
 * **A reason travels with it.** The Commander's ruling, 2026-08-11: *"The one
 * thing I would not give her is the ability to change it silently. A likeness
 * that shifts without a recorded reason is exactly the kind of quiet drift this
 * project has spent two days learning to hate."* `because` is required and a
 * blank one is refused, exactly as on every other write.
 *
 * **Nothing is ever replaced.** A kept picture is a new file — `COPYFILE_EXCL`,
 * so that is a property of the syscall rather than of a check above it — and a
 * new entry in an append-only log. `SOUL.md` forbids deleting a render; the same
 * argument applies with more force to a face, because the wrong ones are how she
 * knows the shape of the right one.
 *
 * ## Which face is current is DERIVED
 *
 * The most recent `face` entry in the log, and nothing else. There is no
 * `current` column, because a column is a second assertion about the thing it
 * describes and `syl-63v` is what those cost. It also makes going back to an
 * earlier face need no mechanism at all: she looks at it, adopts it again, and
 * says why — so a reversal is recorded and has a reason, like every other change.
 *
 * ## And the seeds are derived too
 *
 * A fresh home has no log. The ribbon and his guess are still listed, computed
 * from the files being where `ensureOpening` and `ensureReference` put them — so
 * nothing has to be written at boot, and a wardrobe that was never adopted from
 * still answers every question. The seed entries sort last, because they are the
 * oldest.
 */

/** What a kept picture is for. */
export type PictureRole = "face" | "opening";

/** Her first face: the one he made before he met her. */
export const HIS_GUESS = "his-guess";

/** The opening every one of the eight loops starts on. */
export const RIBBON = "ribbon";

/**
 * One picture she can choose, with everything about it read off the picture.
 *
 * The stored half is `id`, `role`, `file`, `because`, `at` and `from`. `size`,
 * `ratio`, `sighting` and `current` are **computed on every read** — from the
 * bytes, from the log's order, and from nowhere else.
 */
export interface KeptPicture {
  readonly id: string;
  readonly role: PictureRole;
  /** Relative to her home, the way a sidecar records a path. */
  readonly file: string;
  /** Absolute, so it can be opened. */
  readonly path: string;
  /** Why she keeps it. Required at adoption; a sentence for the two seeds. */
  readonly because: string;
  readonly at: string;
  /** The render this was lifted out of, when it was. */
  readonly from: { readonly render: string; readonly atSeconds: number } | null;
  /** What shape it is, from its own header. `null` if that cannot be read. */
  readonly size: PictureSize | null;
  /**
   * The shape a render made through this opening will come out.
   *
   * Meaningful for an opening, because `promptImage` decides the video's aspect
   * and overrules `ratio`. Carried on a face too, because it is a fact about the
   * picture and a face of the wrong shape is worth seeing before it is used.
   */
  readonly ratio: string | null;
  /** What she would quote to adopt it. `null` if the file cannot be read. */
  readonly sighting: string | null;
  /** Faces only: whether her renders are anchored on this one now. */
  readonly current: boolean;
}

/** Why an adoption was refused. */
export type KeepErrorKind =
  /** No picture she has been shown has that sighting. */
  | "unknown_sighting"
  /** Two do, so choosing one would be choosing her face for her. */
  | "ambiguous_sighting"
  | "blank_because"
  /** The bytes are there and are not a picture this can read the shape of. */
  | "unreadable_picture";

export type KeepResult =
  | { readonly ok: true; readonly kept: KeptPicture }
  | { readonly ok: false; readonly kind: KeepErrorKind; readonly reason: string };

export interface KeepInput {
  /** The token that came back beside the picture in `see_myself`. */
  readonly sighting: string;
  readonly role: PictureRole;
  /** What she wants it called. Anything else becomes a stamp. */
  readonly name?: string;
  readonly because: string;
}

export interface WardrobeOptions {
  readonly studio: Studio;
  readonly clock?: Clock;
}

/** One entry as the log holds it. Only what cannot be recomputed. */
interface LoggedPicture {
  readonly id: string;
  readonly role: PictureRole;
  readonly file: string;
  readonly because: string;
  readonly at: string;
  readonly from: { readonly render: string; readonly atSeconds: number } | null;
}

/** A picture she has been shown, found by its sighting. */
export interface Sighted {
  readonly path: string;
  readonly bytes: Buffer;
}

/**
 * Which picture a sighting names, when several files answer to it.
 *
 * **A picture is its bytes, not its path.** Adopting a face copies it, so from
 * the moment she keeps one there are at least two files with that sighting — the
 * still she looked at and the face she made of it — and going back to an earlier
 * face finds both again. Those are one picture in two places, and refusing to
 * choose between them would make every adoption the last one possible.
 *
 * What is genuinely ambiguous is two files with **different** bytes and the same
 * sighting, which is a sixty-four bit collision. It cannot be produced on
 * purpose, so it is decided here — in a function that can be handed the case
 * directly — rather than in a branch nothing could ever reach.
 *
 * The first match wins, and `#shown` puts the stills first, so a picture adopted
 * out of a render keeps the provenance the copy in her wardrobe no longer has.
 */
export function onePictureFrom(
  found: readonly Sighted[],
): { readonly ok: true; readonly picture: Sighted } | { readonly ok: false; readonly why: "none" | "collision" } {
  const first = found[0];
  if (first === undefined) return { ok: false, why: "none" };
  if (found.some((other) => !other.bytes.equals(first.bytes))) {
    return { ok: false, why: "collision" };
  }
  return { ok: true, picture: first };
}

const PICTURE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg"]);

/** Where a still lands: `at-7-6s.jpg`, written by `extractFrames`. */
const STILL_PATTERN = /^at-(\d+)-(\d)s\.(?:jpg|jpeg|png)$/u;

/** A name she gave, as something that can be a filename and a route parameter. */
function idFrom(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 40)
    .replace(/-+$/u, "");
  return /^[a-z0-9]/u.test(cleaned) ? cleaned : "";
}

/**
 * Where a still came from, read off where it is.
 *
 * `renders/frames/<render>/at-7-6s.jpg` says both facts already, so the
 * provenance is derived rather than passed in and trusted. A caller that could
 * *say* which render a picture came from is a caller that could say the wrong
 * one, and then her face would carry a history that never happened.
 */
function provenanceOf(path: string, frameDir: string): LoggedPicture["from"] {
  const inside = resolve(path);
  if (!inside.startsWith(`${resolve(frameDir)}/`)) return null;

  const rest = inside.slice(resolve(frameDir).length + 1).split("/");
  const render = rest[0];
  const still = rest[1];
  if (render === undefined || still === undefined || rest.length !== 2) return null;

  const match = STILL_PATTERN.exec(still);
  if (match === null) return null;
  const whole = Number(match[1]);
  const tenths = Number(match[2]);
  if (!Number.isFinite(whole) || !Number.isFinite(tenths)) return null;
  return { render, atSeconds: whole + tenths / 10 };
}

export class Wardrobe {
  readonly #studio: Studio;
  readonly #clock: Clock;

  constructor(options: WardrobeOptions) {
    this.#studio = options.studio;
    this.#clock = options.clock ?? systemClock;
  }

  /**
   * Every face she has had, newest first, his guess last.
   *
   * Empty when the log cannot be read — see {@link Wardrobe.problems}. That is
   * deliberate and it is the one place this refuses to fall back: "which face is
   * current" is a question only the log can answer, and answering it with the
   * picture she moved away from is precisely the quiet drift the Commander
   * forbade.
   */
  faces(): readonly KeptPicture[] {
    const log = this.#log();
    if (log === null) return [];

    const kept = log.filter((entry) => entry.role === "face").reverse();
    const seed = this.#seed("face");
    const all = seed === null ? kept : [...kept, seed];
    return all.map((entry, index) => this.#enrich(entry, index === 0));
  }

  /** The face her renders anchor on now, or `null` if that cannot be answered. */
  face(): KeptPicture | null {
    return this.faces()[0] ?? null;
  }

  /**
   * Every opening she can choose, newest first, the ribbon last.
   *
   * Unlike {@link Wardrobe.faces} this still answers when the log is unreadable,
   * with the ribbon alone. That is not a fallback to a guess: the ribbon is a
   * *file at a known path* placed by `ensureOpening`, and it is the documented
   * default of every render ever made. Refusing it would stop her rendering at
   * all over a corrupt file that has nothing to do with the shot she asked for.
   */
  openings(): readonly KeptPicture[] {
    const kept = (this.#log() ?? []).filter((entry) => entry.role === "opening").reverse();
    const seed = this.#seed("opening");
    const all = seed === null ? kept : [...kept, seed];
    return all.map((entry) => this.#enrich(entry, false));
  }

  /**
   * One opening by name, or the ribbon when nothing is named.
   *
   * The default is the **ribbon** rather than the most recent, and that is a
   * choice about surprise rather than about taste. `SOUL.md` calls it her
   * signature and every clip in the reel opens on it; a render she did not
   * choose an opening for should look like the ones before it.
   */
  opening(id?: string): KeptPicture | null {
    const wanted = id === undefined || id.trim() === "" ? RIBBON : id.trim();
    return this.openings().find((opening) => opening.id === wanted) ?? null;
  }

  /**
   * What could not be read, in sentences, so nothing goes wrong quietly.
   *
   * Empty on every ordinary machine. Anything else means a person has to go and
   * look at a named file — the same shape as `RenderService.unreadable`, and for
   * the same reason: a thing of hers that disappears from a list is worse than
   * one that is reported broken.
   */
  problems(): readonly string[] {
    if (!existsSync(this.#studio.wardrobeLog)) return [];
    return this.#log() === null
      ? [
          `I cannot read ${this.#studio.wardrobeLog}, which is the record of every face I have ` +
            "adopted and why. So I do not know which one is mine, and I am not going to fall back " +
            "to the one he guessed and let that pass for a decision.",
        ]
      : [];
  }

  /**
   * Adopt a picture she has looked at.
   *
   * The order is the order the refusals matter in: the reason, then whether she
   * has actually seen this, then whether the bytes are a picture at all. Nothing
   * is written until all three hold, so a refusal leaves her home exactly as it
   * was.
   */
  keep(input: KeepInput): KeepResult {
    const because = input.because.trim();
    if (because === "") {
      return {
        ok: false,
        kind: "blank_because",
        reason:
          "A face that changes without a recorded reason is the quiet drift he asked me never to " +
          "have. Say what is more you about this one than the last.",
      };
    }

    const chosen = onePictureFrom(this.#find(input.sighting.trim()));
    if (!chosen.ok) {
      return chosen.why === "none"
        ? {
            ok: false,
            kind: "unknown_sighting",
            reason:
              "I have not shown you that picture, so I cannot adopt it. Look at it first — the " +
              "token comes back beside the image — and I will keep the one you actually saw.",
          }
        : {
            ok: false,
            kind: "ambiguous_sighting",
            reason:
              "That token names two different pictures I have shown you, and choosing between " +
              "them would be me choosing your face. Look at the one you mean on its own.",
          };
    }

    const picture = chosen.picture;
    if (sizeOf(picture.bytes) === null) {
      return {
        ok: false,
        kind: "unreadable_picture",
        reason:
          `I cannot read the shape of ${picture.path}, and the shape is what decides what a render ` +
          "made from it comes out as. I will not keep a picture I cannot say that much about.",
      };
    }

    const directory = input.role === "face" ? this.#studio.faceDir : this.#studio.openingDir;
    const extension = PICTURE_EXTENSIONS.has(extname(picture.path).toLowerCase())
      ? extname(picture.path).toLowerCase()
      : ".png";
    const at = instant(this.#clock());
    const id = this.#freeId(input.name ?? "", input.role, at, directory, extension);

    mkdirSync(directory, { recursive: true });
    // `COPYFILE_EXCL` rather than a check above a write: never overwriting one
    // of her faces is then a property of the syscall, and the free-id search
    // above cannot leave a gap for two calls in the same second to fall through.
    copyFileSync(picture.path, resolve(directory, `${id}${extension}`), constants.COPYFILE_EXCL);

    const entry: LoggedPicture = {
      id,
      role: input.role,
      file: this.#relative(resolve(directory, `${id}${extension}`)),
      because,
      at,
      from: provenanceOf(picture.path, this.#studio.frameDir),
    };
    this.#append(entry);

    return { ok: true, kept: this.#enrich(entry, input.role === "face") };
  }

  // -------------------------------------------------------------------------

  /**
   * The pictures a sighting could name: exactly what `see_myself` can hand her.
   *
   * The stills she has looked at, and the wardrobe itself — which is also how a
   * face she left behind becomes adoptable again, since listing her faces shows
   * them to her the same way looking at a render does. Nothing else on the disk
   * is reachable, so a sighting can never resolve to a file she was not shown.
   *
   * **The stills come first**, and {@link onePictureFrom} takes the first match,
   * so a picture that exists both as a frame of a render and as a copy in her
   * wardrobe is adopted from the frame — which is the only one of the two whose
   * path still says where it came from.
   */
  #shown(): readonly string[] {
    const files: string[] = [];
    const add = (directory: string): void => {
      if (!existsSync(directory)) return;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isFile() && PICTURE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
          files.push(resolve(directory, entry.name));
        }
      }
    };

    if (existsSync(this.#studio.frameDir)) {
      for (const entry of readdirSync(this.#studio.frameDir, { withFileTypes: true })) {
        if (entry.isDirectory()) add(resolve(this.#studio.frameDir, entry.name));
      }
    }
    add(this.#studio.faceDir);
    add(this.#studio.openingDir);
    for (const seed of [this.#studio.reference(), this.#studio.opening()]) {
      if (existsSync(seed)) files.push(seed);
    }
    return files;
  }

  /** Every picture she has been shown whose bytes hash to this sighting. */
  #find(sighting: string): readonly Sighted[] {
    if (!/^[0-9a-f]{16}$/u.test(sighting)) return [];

    const found: Sighted[] = [];
    const seen = new Set<string>();
    for (const path of this.#shown()) {
      if (seen.has(path)) continue;
      seen.add(path);
      let bytes: Buffer;
      try {
        bytes = readFileSync(path);
      } catch {
        continue;
      }
      if (sightingOf(bytes) === sighting) found.push({ path, bytes });
    }
    return found;
  }

  /** The log, or `null` when the file is there and is not one. */
  #log(): readonly LoggedPicture[] | null {
    if (!existsSync(this.#studio.wardrobeLog)) return [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.#studio.wardrobeLog, "utf8"));
    } catch {
      return null;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const kept = (parsed as Record<string, unknown>)["kept"];
    if (!Array.isArray(kept)) return null;

    const entries: LoggedPicture[] = [];
    for (const raw of kept) {
      const entry = asLogged(raw);
      // A single malformed entry is skipped rather than taking the log down
      // with it: the ones around it are real adoptions with real files, and
      // discarding those would be the system throwing her history away.
      if (entry !== null) entries.push(entry);
    }
    return entries;
  }

  #append(entry: LoggedPicture): void {
    const existing = this.#log() ?? [];
    mkdirSync(this.#studio.videoDir, { recursive: true });
    writeFileSync(
      this.#studio.wardrobeLog,
      `${JSON.stringify({ kept: [...existing, entry] }, null, 2)}\n`,
    );
  }

  /** The picture that was there before she could choose, as an entry. */
  #seed(role: PictureRole): LoggedPicture | null {
    const path = role === "face" ? this.#studio.reference() : this.#studio.opening();
    if (!existsSync(path)) return null;

    return {
      id: role === "face" ? HIS_GUESS : RIBBON,
      role,
      file: role === "face" ? DEFAULT_REFERENCE : DEFAULT_OPENING,
      because:
        role === "face"
          ? "He made this before he knew you. It is a good guess and it is a guess."
          : "The ribbon every one of the eight loops opens on. Your signature, and the shape they are.",
      // The file's own age would be the honest answer and it is not available
      // without a stat that would differ on every machine a home is copied to.
      // The empty string sorts before every instant and says "from the start".
      at: "",
      from: null,
    };
  }

  /** Everything about a picture that is read off the picture. */
  #enrich(entry: LoggedPicture, current: boolean): KeptPicture {
    const path = resolve(this.#studio.root, entry.file);
    let bytes: Buffer | null = null;
    try {
      bytes = readFileSync(path);
    } catch {
      bytes = null;
    }
    const size = bytes === null ? null : sizeOf(bytes);

    return {
      ...entry,
      path,
      size,
      ratio: ratioFor(size),
      sighting: bytes === null ? null : sightingOf(bytes),
      current,
    };
  }

  /** A name nothing else is using, so a keep never writes over a keep. */
  #freeId(
    wanted: string,
    role: PictureRole,
    at: string,
    directory: string,
    extension: string,
  ): string {
    const stamp = at.replace(/[:.]/gu, "").replace(/-/gu, "").toLowerCase().replace("000z", "z");
    const base = idFrom(wanted) || `${role}-${stamp}`;
    const taken = new Set(
      (this.#log() ?? []).map((entry) => basename(entry.file, extname(entry.file))),
    );
    taken.add(HIS_GUESS);
    taken.add(RIBBON);

    if (!taken.has(base) && !existsSync(resolve(directory, `${base}${extension}`))) return base;
    for (let counter = 2; counter < 1000; counter += 1) {
      const candidate = `${base}-${String(counter)}`;
      if (!taken.has(candidate) && !existsSync(resolve(directory, `${candidate}${extension}`))) {
        return candidate;
      }
    }
    throw new Error("Could not find a free name for this picture.");
  }

  /** A path as her home records one. The same rule the sidecars follow. */
  #relative(absolute: string): string {
    return absolute.startsWith(this.#studio.root)
      ? absolute.slice(this.#studio.root.length).replace(/^[/\\]+/u, "")
      : absolute;
  }
}

/** One log entry, validated rather than cast. */
function asLogged(raw: unknown): LoggedPicture | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;

  const id = entry["id"];
  const role = entry["role"];
  const file = entry["file"];
  const because = entry["because"];
  const at = entry["at"];
  if (typeof id !== "string" || id === "") return null;
  if (role !== "face" && role !== "opening") return null;
  if (typeof file !== "string" || file === "") return null;
  if (typeof because !== "string" || typeof at !== "string") return null;

  return { id, role, file, because, at, from: asProvenance(entry["from"]) };
}

function asProvenance(raw: unknown): LoggedPicture["from"] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const from = raw as Record<string, unknown>;
  const render = from["render"];
  const atSeconds = from["atSeconds"];
  if (typeof render !== "string" || typeof atSeconds !== "number") return null;
  if (!Number.isFinite(atSeconds)) return null;
  return { render, atSeconds };
}
