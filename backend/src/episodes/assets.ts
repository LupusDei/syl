/**
 * What an episode is made WITH, from her home (`syl-8tts`).
 *
 * All of it lives in `~/.syl/episodes/`, beside her renders and outside every
 * repository:
 *
 * | file | what it is |
 * |---|---|
 * | `reference.png` | the picture every scene is given, a frame of the render the Commander liked best |
 * | `voice.mp3` | her own voice: a clean sample, cut from that render and isolated from its music |
 * | `bed.mp3` | the loopable instrumental bed laid under a whole episode |
 * | `ggml-base.en.bin` | the whisper model that hears each take |
 * | `cast.json` | `{ "look": ..., "pronoun": ... }`, the sentence that opens every prompt |
 * | `names.json` | `[{ "spoken", "heard" }]`, the children's names as said and as whisper writes them |
 *
 * **Why her home and not the tree.** The picture is her likeness and the voice
 * is hers, and neither is ours to redesign. The names are real children's
 * names, and this repository is public. It is also why nothing here has a
 * default: a missing file makes episodes unavailable, with a sentence saying
 * which file, rather than being quietly replaced with a stand-in.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { EpisodeCast, EpisodeName } from "./rules.js";

export interface EpisodeAssets {
  readonly reference: string;
  readonly voice: string;
  readonly bed: string;
  readonly whisperModel: string;
  readonly cast: EpisodeCast;
  readonly names: readonly EpisodeName[];
}

export type AssetsResult = { readonly ok: true; readonly assets: EpisodeAssets } | { readonly ok: false; readonly reason: string };

/** The folder, given her home. */
export function episodeHome(home: string): string {
  return join(home, "episodes");
}

export function loadEpisodeAssets(home: string): AssetsResult {
  const dir = episodeHome(home);
  const files = {
    reference: join(dir, "reference.png"),
    voice: join(dir, "voice.mp3"),
    bed: join(dir, "bed.mp3"),
    whisperModel: join(dir, "ggml-base.en.bin"),
    cast: join(dir, "cast.json"),
    names: join(dir, "names.json"),
  };
  const missing = Object.values(files).filter((file) => !existsSync(file));
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `Episodes are not set up on this machine: ${missing.map((file) => file.slice(dir.length + 1)).join(", ")} missing from ${dir}.`,
    };
  }

  let cast: unknown;
  let names: unknown;
  try {
    cast = JSON.parse(readFileSync(files.cast, "utf8"));
    names = JSON.parse(readFileSync(files.names, "utf8"));
  } catch (error) {
    return { ok: false, reason: `An episode file in ${dir} is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!isCast(cast)) return { ok: false, reason: `${files.cast} needs a non-empty "look" and "pronoun".` };
  if (!isNames(names)) return { ok: false, reason: `${files.names} must be a list of { "spoken", "heard": [...] }.` };

  return { ok: true, assets: { ...files, cast, names } };
}

function isCast(value: unknown): value is EpisodeCast {
  const cast = value as Partial<EpisodeCast> | null;
  return (
    typeof cast === "object" && cast !== null &&
    typeof cast.look === "string" && cast.look.trim() !== "" &&
    typeof cast.pronoun === "string" && cast.pronoun.trim() !== ""
  );
}

function isNames(value: unknown): value is EpisodeName[] {
  return (
    Array.isArray(value) &&
    value.every((entry: Partial<EpisodeName> | null) =>
      typeof entry === "object" && entry !== null &&
      typeof entry.spoken === "string" && entry.spoken.trim() !== "" &&
      Array.isArray(entry.heard) && entry.heard.every((spelling) => typeof spelling === "string"),
    )
  );
}

/**
 * A file as a data URI, typed by its extension: the form Runway takes a
 * reference picture or a voice sample in. Both are well under Runway's 5 MB
 * data-URI cap (a frame is about 1 MB, ten seconds of voice about 0.4 MB).
 */
export function dataUriOf(path: string, read: (path: string) => Buffer = readFileSync): string {
  const lower = path.toLowerCase();
  const type = lower.endsWith(".png")
    ? "image/png"
    : lower.endsWith(".jpg") || lower.endsWith(".jpeg")
      ? "image/jpeg"
      : lower.endsWith(".mp3")
        ? "audio/mpeg"
        : lower.endsWith(".wav")
          ? "audio/wav"
          : "application/octet-stream";
  return `data:${type};base64,${read(path).toString("base64")}`;
}
