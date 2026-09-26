/**
 * The explainer formula, as rules a script can be checked against before a
 * credit is spent (`syl-8tts`).
 *
 * ## Where this came from
 *
 * A port of the explainer kit in the Commander's runwayml repository
 * (`explainers/explainer.py`). He asked for the kit and then for Syl to have
 * it. The kit made five episodes on 2026-09-26, 42 scenes in all, and every
 * scene passed QC on its first take. Every number here was measured there, and
 * each one says what it guards.
 *
 * ## Why pure
 *
 * Everything in this file is a function of its arguments: no clock, no disk, no
 * Runway. The expensive mistakes in this feature are made in the SCRIPT, such as
 * a line too long to say in fifteen seconds or a name the model will garble.
 * Those have to be caught for free, before anything is sent. `EpisodeService`
 * does the spending, and it cannot be reached with a script this file refuses.
 *
 * No real person is named here or in the tests. The repository is public, and
 * the names Syl's episodes greet live in her home (`~/.syl/episodes/names.json`).
 */

/** One 15-second beat. Picture, voice and sound come out of one generation. */
export interface EpisodeScene {
  /** Exactly what she says, spoken aloud because it is quoted in the prompt. */
  readonly line: string;
  /** What we see. */
  readonly action: string;
  /** The sounds the action makes, generated with it and therefore in sync. */
  readonly sfx: string;
  /** How the facts in `line` were checked: the number and its source, or "no factual claims". */
  readonly factCheck: string;
}

/**
 * A name as the model should SAY it and as whisper WRITES it back.
 *
 * `spoken` is phonetic, because a child's name spelled conventionally is often
 * said wrong. `heard` is every spelling whisper produces for a CORRECT
 * pronunciation. The kit once rejected three good takes, about 1,350 credits,
 * because one spelling was missing from that list.
 */
export interface EpisodeName {
  readonly spoken: string;
  readonly heard: readonly string[];
}

/** Who is on screen and how the prompt refers to her. */
export interface EpisodeCast {
  /**
   * Prepended to every scene: her, her companion, the world, the style. It names
   * every trait that drifts, because an unnamed trait drifts between scenes.
   */
  readonly look: string;
  readonly pronoun: string;
}

/** Runway refuses a promptText over this. */
export const PROMPT_LIMIT = 1000;
/** About 15 s of unhurried speech. More and the model gabbles to fit the clip. */
export const MAX_WORDS_PER_SCENE = 34;
export const SCENE_SECONDS = 15;
/** One to four minutes. Past four, a three-year-old has left the room. */
export const MIN_SCENES = 4;
export const MAX_SCENES = 16;
/** A take whose transcript matches its line less than this is re-rolled. */
export const MIN_LINE_MATCH = 0.72;
/** The finished mix against the whole script. The mix can bury a line that passed alone. */
export const MIN_EPISODE_MATCH = 0.8;
export const TARGET_LUFS = -16;
export const LUFS_TOLERANCE = 1.5;
/**
 * Ends every prompt. Music is laid once under the whole episode rather than per
 * scene, so the score does not change at every cut. Any text a model draws is
 * gibberish.
 */
export const PROMPT_TAIL = " No background music. No text, letters or numbers anywhere.";

// whisper writes a correctly spoken "number six" as "Number 6". Comparing a
// digit with its word would re-roll a good take.
const NUMBER_WORDS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen",
  "nineteen", "twenty",
] as const;
const SYNONYMS: Readonly<Record<string, string>> = { okay: "ok" };

/** Normalised words: lower case, hyphens split, digits 0-20 as words, spelling variants folded. */
export function words(text: string): string[] {
  const tokens = text.toLowerCase().replace(/[—-]/gu, " ").match(/[a-z0-9']+/gu) ?? [];
  return tokens.map((token) => {
    const spelled = /^\d+$/u.test(token) ? NUMBER_WORDS[Number(token)] : undefined;
    const word = spelled ?? token;
    return SYNONYMS[word] ?? word;
  });
}

/**
 * Whether `phrase` appears in `text` as consecutive WHOLE words.
 *
 * Never a substring test. A short name hides inside ordinary words ("Al" in
 * "all" and "metal"), and a substring test would pass a take that never said
 * the name. The kit shipped that defect and caught it on an episode about robots.
 */
export function containsPhrase(text: string, phrase: string): boolean {
  const hay = words(text);
  const needle = words(phrase);
  if (needle.length === 0) return false;
  for (let start = 0; start + needle.length <= hay.length; start += 1) {
    if (needle.every((word, offset) => hay[start + offset] === word)) return true;
  }
  return false;
}

/** How many words she has to say: the budget that decides whether a scene fits its 15 s. */
export function spokenWords(line: string): number {
  return words(line).length;
}

/** The full promptText for one scene. Throws if it would breach Runway's limit. */
export function buildPrompt(scene: EpisodeScene, cast: EpisodeCast): string {
  const prompt =
    `${cast.look}${scene.action.trim()} ${cast.pronoun} speaks to the viewer: "${scene.line.trim()}"` +
    ` Sound effects: ${scene.sfx.trim().replace(/\.+$/u, "")}.${PROMPT_TAIL}`;
  if (prompt.length > PROMPT_LIMIT) {
    throw new RangeError(
      `that scene's prompt is ${String(prompt.length)} characters and Runway takes ${String(PROMPT_LIMIT)} — shorten the action`,
    );
  }
  return prompt;
}

/** The known names this line says, in the order the list gives them. */
export function namesIn(line: string, names: readonly EpisodeName[]): EpisodeName[] {
  return names.filter((name) => containsPhrase(line, name.spoken));
}

/**
 * Every rule a script can break before anything is spent. Empty means ready.
 *
 * Each problem is a sentence she can act on, naming the scene by its position
 * the way she numbered it, because she reads these and rewrites.
 */
export function validate(
  scenes: readonly EpisodeScene[],
  cast: EpisodeCast,
  names: readonly EpisodeName[],
): string[] {
  const problems: string[] = [];
  if (scenes.length < MIN_SCENES || scenes.length > MAX_SCENES) {
    problems.push(
      `${String(scenes.length)} scenes; an episode is ${String(MIN_SCENES)} to ${String(MAX_SCENES)} — six for ninety seconds, twelve for three minutes.`,
    );
  }
  scenes.forEach((scene, index) => {
    const which = `Scene ${String(index + 1)}`;
    const fields: ReadonlyArray<readonly [keyof EpisodeScene, string]> = [
      ["line", "line"], ["action", "action"], ["sfx", "sfx"], ["factCheck", "factCheck"],
    ];
    const missing = fields.filter(([key]) => typeof scene[key] !== "string" || scene[key].trim() === "");
    for (const [, label] of missing) problems.push(`${which} has no ${label}.`);
    if (missing.length > 0) return;

    const count = spokenWords(scene.line);
    if (count > MAX_WORDS_PER_SCENE) {
      problems.push(`${which} is ${String(count)} words; at most ${String(MAX_WORDS_PER_SCENE)} fit fifteen seconds without rushing.`);
    }
    if (/\d/u.test(scene.line)) {
      problems.push(`${which} has digits in the line; write numbers as words so they are spoken, not read.`);
    }
    try {
      buildPrompt(scene, cast);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      problems.push(`${which}: ${error.message}.`);
    }
  });

  const first = scenes[0];
  const last = scenes[scenes.length - 1];
  if (first !== undefined && last !== undefined && scenes.length > 1) {
    for (const name of namesIn(first.line, names)) {
      if (!containsPhrase(last.line, name.spoken)) {
        problems.push(`The last scene must say goodbye to everyone the first greeted; it never says ${name.spoken}.`);
      }
    }
  }
  return problems;
}

/**
 * Ratcliff/Obershelp similarity over word lists, 0 to 1. It is the measure
 * Python's `difflib.SequenceMatcher.ratio()` computes, and the thresholds above
 * were calibrated with that.
 */
export function lineMatch(expected: string, heard: string): number {
  const a = words(expected);
  const b = words(heard);
  if (a.length === 0 || b.length === 0) return 0;
  return (2 * matching(a, 0, a.length, b, 0, b.length)) / (a.length + b.length);
}

function matching(a: readonly string[], a0: number, a1: number, b: readonly string[], b0: number, b1: number): number {
  let best = 0;
  let atA = a0;
  let atB = b0;
  for (let i = a0; i < a1; i += 1) {
    for (let j = b0; j < b1; j += 1) {
      let run = 0;
      while (i + run < a1 && j + run < b1 && a[i + run] === b[j + run]) run += 1;
      if (run > best) {
        best = run;
        atA = i;
        atB = j;
      }
    }
  }
  if (best === 0) return 0;
  return best + matching(a, a0, atA, b, b0, atB) + matching(a, atA + best, a1, b, atB + best, b1);
}

/** The names (as spoken) the transcript does not contain in any heard form. */
export function namesMissing(transcript: string, names: readonly EpisodeName[]): string[] {
  return names
    .filter((name) => !name.heard.some((spelling) => containsPhrase(transcript, spelling)))
    .map((name) => name.spoken);
}

export interface Verdict {
  readonly ok: boolean;
  readonly why: string;
}

/**
 * Does this take pass? `greets` is the names this scene must be heard saying:
 * the bookends' known names, and nobody for the scenes between.
 */
export function sceneVerdict(scene: EpisodeScene, transcript: string, greets: readonly EpisodeName[]): Verdict {
  const score = lineMatch(scene.line, transcript);
  if (score < MIN_LINE_MATCH) return { ok: false, why: `said the wrong words (match ${score.toFixed(2)})` };
  const missing = namesMissing(transcript, greets);
  if (missing.length > 0) return { ok: false, why: `did not clearly say ${missing.join(", ")}` };
  return { ok: true, why: `match ${score.toFixed(2)}` };
}

/**
 * What is wrong with the FINISHED file. Not redundant with the per-scene check:
 * a scene can pass on its own and the mix still bury it.
 */
export function finalProblems(
  scenes: readonly EpisodeScene[],
  transcript: string,
  seconds: number,
  lufs: number,
  greets: readonly EpisodeName[],
): string[] {
  const problems: string[] = [];
  const score = lineMatch(scenes.map((scene) => scene.line).join(" "), transcript);
  if (score < MIN_EPISODE_MATCH) {
    problems.push(`the finished mix does not say the script (match ${score.toFixed(2)}, needs ${String(MIN_EPISODE_MATCH)})`);
  }
  const missing = namesMissing(transcript, greets);
  if (missing.length > 0) problems.push(`the finished mix never clearly says ${missing.join(", ")}`);
  const expected = scenes.length * SCENE_SECONDS;
  if (seconds < 0.9 * expected || seconds > 1.1 * expected) {
    problems.push(`it is ${seconds.toFixed(1)} seconds long, expected about ${String(expected)}`);
  }
  if (Math.abs(lufs - TARGET_LUFS) > LUFS_TOLERANCE) {
    problems.push(`its loudness is ${lufs.toFixed(1)} LUFS, target ${String(TARGET_LUFS)}`);
  }
  return problems;
}
