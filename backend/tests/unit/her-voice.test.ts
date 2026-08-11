import { describe, expect, it } from "vitest";

import {
  HER_VOICE,
  MAX_REFERENCE_SECONDS,
  MAX_SPEECH_CHARS,
  REFERENCE_SECONDS,
  samplePath,
  voiceFrom,
} from "../../src/voice/her-voice.js";

/**
 * The one place a person changes which voice she speaks in.
 *
 * The point of these tests is that the id is *configuration* rather than a
 * literal scattered through a client — the Commander's ruling was "just build in
 * the one I provided", and the thing that makes that safe to obey is that
 * changing his mind later is one edit in one file.
 */

describe("her voice", () => {
  it("should be the voice he made when nothing overrides it", () => {
    expect(HER_VOICE.id).toBe("93b52581-17ab-4905-bb5a-4fa730a7757a");
    expect(HER_VOICE.name).toBe("Syl High Pitch");
    expect(HER_VOICE.model).toBe("seed_audio");
  });

  it("should keep the reference clip in her home rather than in the repository", () => {
    expect(HER_VOICE.sample.startsWith("voice/")).toBe(true);
    expect(samplePath("/home/syl", HER_VOICE)).toBe(`/home/syl/${HER_VOICE.sample}`);
  });

  it("should take a different voice from the environment, id and sample together", () => {
    const other = voiceFrom({
      SYL_VOICE_ID: "24b46ea8-e9f6-4ed4-a277-6f61746665d8",
      SYL_VOICE_NAME: "Regal Syl",
      SYL_VOICE_SAMPLE: "voice/regal-syl.mp3",
    });
    expect(other.id).toBe("24b46ea8-e9f6-4ed4-a277-6f61746665d8");
    expect(other.name).toBe("Regal Syl");
    expect(other.sample).toBe("voice/regal-syl.mp3");
  });

  it("should derive a sample filename from the id when only the id is overridden", () => {
    // Otherwise a changed id would keep speaking through the previous voice's
    // clip, which is a wrong voice that looks exactly like a right one.
    const other = voiceFrom({ SYL_VOICE_ID: "24b46ea8-e9f6-4ed4-a277-6f61746665d8" });
    expect(other.sample).toBe("voice/24b46ea8-e9f6-4ed4-a277-6f61746665d8.mp3");
    expect(other.name).toBe("24b46ea8-e9f6-4ed4-a277-6f61746665d8");
  });

  it("should ignore a blank override rather than treating it as a voice", () => {
    expect(voiceFrom({ SYL_VOICE_ID: "   " }).id).toBe(HER_VOICE.id);
  });

  it("should carry Runway's own limits so a refusal happens before a credit is spent", () => {
    expect(MAX_REFERENCE_SECONDS).toBe(30);
    expect(MAX_SPEECH_CHARS).toBe(2048);
  });

  it("should trim the reference clip under the cap rather than at it", () => {
    // `-t 30 -c copy` on an mp3 rounds up to the next frame and writes
    // 30.027755 seconds, which Runway refuses — the cap is inclusive. Measured
    // 2026-08-11, and the 400 reads as a size problem rather than a rounding one.
    expect(REFERENCE_SECONDS).toBeLessThan(MAX_REFERENCE_SECONDS);
  });
});
