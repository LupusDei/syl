import { describe, expect, it } from "vitest";

import {
  MAX_SCENES,
  MAX_WORDS_PER_SCENE,
  PROMPT_LIMIT,
  buildPrompt,
  containsPhrase,
  finalProblems,
  lineMatch,
  namesIn,
  namesMissing,
  sceneVerdict,
  validate,
  words,
  type EpisodeCast,
  type EpisodeName,
  type EpisodeScene,
} from "../../src/episodes/rules.js";

/**
 * The explainer formula as rules (`syl-8tts`), ported from the kit's own tests
 * (runwayml `explainers/test_explainer.py`).
 *
 * Every child here is fictional. The repository is public, and the names her
 * episodes really greet live in her home and nowhere in this tree.
 */

const CAST: EpisodeCast = { look: "Syl, a glowing starlight woman. ", pronoun: "She" };
const MIRA: EpisodeName = { spoken: "Mee-ra", heard: ["mira", "meera", "myra"] };
const THEO: EpisodeName = { spoken: "Thee-oh", heard: ["theo", "teo", "tio"] };
const NAMES = [MIRA, THEO];

function scene(line: string, extra: Partial<EpisodeScene> = {}): EpisodeScene {
  return { line, action: "She waves.", sfx: "a whoosh", factCheck: "NASA planet fact sheet", ...extra };
}

const GOOD: EpisodeScene[] = [
  scene("Mee-ra! Thee-oh! Hop in, we are flying past all eight planets!"),
  scene("Venus is the hottest planet of all."),
  scene("Earth is our home."),
  scene("Mars is red and dusty."),
  scene("See you soon, Mee-ra! See you soon, Thee-oh!"),
];

/** GOOD as whisper would write it back. */
const HEARD = GOOD.map((s) => s.line).join(" ").replace(/Mee-ra/gu, "Myra").replace(/Thee-oh/gu, "Theo");

describe("validate", () => {
  it("should accept a script that follows the formula", () => {
    expect(validate(GOOD, CAST, NAMES)).toEqual([]);
  });

  it("should accept a three-minute episode of twelve scenes", () => {
    const long = [GOOD[0]!, ...Array.from({ length: 10 }, () => GOOD[1]!), GOOD[4]!];
    expect(validate(long, CAST, NAMES)).toEqual([]);
  });

  it("should refuse more scenes than a small child will sit through", () => {
    const long = Array.from({ length: MAX_SCENES + 1 }, () => GOOD[1]!);
    expect(validate(long, CAST, NAMES).join(" ")).toContain("scenes");
  });

  it("should refuse too few scenes to be an episode", () => {
    expect(validate(GOOD.slice(0, 2), CAST, NAMES).length).toBeGreaterThan(0);
  });

  it("should refuse a line too long to say in fifteen seconds", () => {
    const bad = [...GOOD];
    bad[1] = scene("word ".repeat(MAX_WORDS_PER_SCENE + 1));
    expect(validate(bad, CAST, NAMES).join(" ")).toContain("Scene 2 is");
  });

  it("should refuse digits, because they get read rather than spoken", () => {
    const bad = [...GOOD];
    bad[2] = scene("There are 8 planets.");
    expect(validate(bad, CAST, NAMES).join(" ")).toContain("digits");
  });

  it("should require every scene to say how its facts were checked", () => {
    const bad = [...GOOD];
    bad[2] = scene("Earth is our home.", { factCheck: "  " });
    expect(validate(bad, CAST, NAMES)).toEqual(["Scene 3 has no factCheck."]);
  });

  it("should require the last scene to say goodbye to everyone the first greeted", () => {
    const bad = [...GOOD];
    bad[4] = scene("See you soon, Mee-ra!");
    expect(validate(bad, CAST, NAMES).join(" ")).toContain("never says Thee-oh");
  });

  it("should not count a name hidden inside another word as a goodbye", () => {
    const al: EpisodeName = { spoken: "Al", heard: ["al"] };
    const script = [scene("Hi Al! Let's go!"), GOOD[1]!, GOOD[2]!, scene("We all say goodbye, also!")];
    expect(validate(script, CAST, [al]).join(" ")).toContain("never says Al");
  });

  it("should refuse a scene whose prompt would breach Runway's limit", () => {
    const bad = [...GOOD];
    bad[1] = scene("Venus is hot.", { action: "x".repeat(PROMPT_LIMIT) });
    expect(validate(bad, CAST, NAMES).join(" ")).toContain("shorten the action");
  });
});

describe("buildPrompt", () => {
  it("should quote the line, so the model speaks it", () => {
    expect(buildPrompt(GOOD[1]!, CAST)).toContain('She speaks to the viewer: "Venus is the hottest planet of all."');
  });

  it("should start with the cast's look and end forbidding music and lettering", () => {
    const prompt = buildPrompt(GOOD[1]!, CAST);
    expect(prompt.startsWith("Syl, a glowing starlight woman.")).toBe(true);
    expect(prompt.endsWith("No background music. No text, letters or numbers anywhere.")).toBe(true);
  });
});

describe("words and phrases", () => {
  it("should treat a digit and its word as the same word", () => {
    expect(words("Number 6, and number 8")).toEqual(words("number six and number eight"));
  });

  it("should treat okay and OK as the same word", () => {
    expect(words("Okay!")).toEqual(words("OK"));
  });

  it("should match a name only as whole words", () => {
    expect(containsPhrase("We all built a metal robot", "Al")).toBe(false);
    expect(containsPhrase("And hello, Al!", "Al")).toBe(true);
    expect(containsPhrase("See you soon, Mee-ra!", "Mee-ra")).toBe(true);
  });

  it("should find which known names a line says", () => {
    expect(namesIn("Hello, Thee-oh!", NAMES)).toEqual([THEO]);
  });
});

describe("lineMatch", () => {
  it("should score an exact take as a full match", () => {
    expect(lineMatch("Mars is red.", "mars is red")).toBe(1);
  });

  it("should score the wrong words low", () => {
    expect(lineMatch("Mars is red and dusty.", "Jupiter has a giant storm.")).toBeLessThan(0.3);
  });

  it("should score an empty transcript as zero", () => {
    expect(lineMatch("Mars is red.", "")).toBe(0);
  });

  it("should agree with Python's difflib, which the thresholds were calibrated on", () => {
    // Values computed with difflib.SequenceMatcher(None, a, b).ratio() on the
    // same word lists, 2026-09-26.
    expect(lineMatch("the cat sat on the mat", "the cat sat on a mat")).toBeCloseTo(0.8333, 3);
    expect(lineMatch("a b c d e f", "a x c d y f")).toBeCloseTo(0.6667, 3);
  });
});

describe("sceneVerdict", () => {
  it("should pass a good take that says the names", () => {
    const verdict = sceneVerdict(GOOD[0]!, "Myra! Theo! Hop in, we are flying past all 8 planets!", NAMES);
    expect(verdict.ok).toBe(true);
  });

  it("should fail a bookend that mangles a name, and say which", () => {
    const verdict = sceneVerdict(GOOD[0]!, "Myra! Leo! Hop in, we are flying past all eight planets!", NAMES);
    expect(verdict).toEqual({ ok: false, why: "did not clearly say Thee-oh" });
  });

  it("should accept every heard spelling, not only the first", () => {
    expect(namesMissing("See you soon, Meera. See you soon, Tio.", NAMES)).toEqual([]);
  });

  it("should fail a take that says something else", () => {
    const verdict = sceneVerdict(GOOD[1]!, "Hello there, let us sing a song.", []);
    expect(verdict.ok).toBe(false);
    expect(verdict.why).toContain("wrong words");
  });
});

describe("finalProblems", () => {
  it("should pass a finished episode that says its script", () => {
    expect(finalProblems(GOOD, HEARD, 75, -16.1, NAMES)).toEqual([]);
  });

  it("should fail an episode that is the wrong length", () => {
    expect(finalProblems(GOOD, HEARD, 40, -16, NAMES).join(" ")).toContain("seconds");
  });

  it("should fail an episode that is too quiet", () => {
    expect(finalProblems(GOOD, HEARD, 75, -24, NAMES).join(" ")).toContain("LUFS");
  });

  it("should fail an episode whose mix lost the dialogue", () => {
    expect(finalProblems(GOOD, "", 75, -16, NAMES).join(" ")).toContain("script");
  });
});
