import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { dataUriOf, episodeHome, loadEpisodeAssets } from "../../src/episodes/assets.js";

/**
 * What an episode is made with, from her home (`syl-8tts`). Nothing has a
 * default: a missing or malformed file makes episodes unavailable, with a
 * sentence naming it.
 */

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "syl-episode-assets-"));
  const dir = episodeHome(home);
  mkdirSync(dir, { recursive: true });
  for (const file of ["reference.png", "voice.mp3", "bed.mp3", "ggml-base.en.bin"]) writeFileSync(join(dir, file), "x");
  writeFileSync(join(dir, "cast.json"), JSON.stringify({ look: "Syl. ", pronoun: "She" }));
  writeFileSync(join(dir, "names.json"), JSON.stringify([{ spoken: "Mee-ra", heard: ["mira"] }]));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("loadEpisodeAssets", () => {
  it("should find every file in her episode home", () => {
    const loaded = loadEpisodeAssets(home);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.assets.voice).toBe(join(episodeHome(home), "voice.mp3"));
      expect(loaded.assets.names).toEqual([{ spoken: "Mee-ra", heard: ["mira"] }]);
    }
  });

  it("should name every missing file rather than substitute a stand-in", () => {
    rmSync(join(episodeHome(home), "reference.png"));
    rmSync(join(episodeHome(home), "names.json"));
    const loaded = loadEpisodeAssets(home);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.reason).toContain("reference.png, names.json missing");
  });

  it("should refuse a cast with no look, which would open every prompt with nothing", () => {
    writeFileSync(join(episodeHome(home), "cast.json"), JSON.stringify({ look: " ", pronoun: "She" }));
    const loaded = loadEpisodeAssets(home);
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.reason).toContain("look");
  });

  it("should refuse names that are not spoken-and-heard pairs", () => {
    writeFileSync(join(episodeHome(home), "names.json"), JSON.stringify(["Mira"]));
    expect(loadEpisodeAssets(home).ok).toBe(false);
  });
});

describe("dataUriOf", () => {
  it("should type a picture and a voice by their extension", () => {
    const read = (): Buffer => Buffer.from("hi");
    expect(dataUriOf("/x/reference.png", read)).toBe("data:image/png;base64,aGk=");
    expect(dataUriOf("/x/voice.MP3", read)).toBe("data:audio/mpeg;base64,aGk=");
  });
});
