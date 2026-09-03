import { describe, it, expect } from "vitest"
import { scenesForParts } from "../../src/render/scene-lines.js"

/**
 * `syl-m7lj`. The Commander reported the sixty-second clip as "disjointed AND
 * repetitive"; the held middle fixed the first and this fixes the second.
 *
 * The bug it closes is subtle and worth stating: Syl's in-prompt instruction
 * "once and only once, then falls silent" did NOT fail. The scene was copied
 * into every part, so each part received that instruction independently and
 * each obeyed it — two parts each correctly saying the line once is a line said
 * twice. No wording can fix that, which is why the tool had to change.
 */
describe("scenesForParts", () => {
  it("should give every part the same sentence when handed a single string", () => {
    expect(scenesForParts("she is here", 3)).toEqual({
      ok: true,
      scenes: ["she is here", "she is here", "she is here"],
    })
  })

  it("should give each part its own line when handed one per part", () => {
    const lines = ["first thing", "second thing", "third thing"]
    expect(scenesForParts(lines, 3)).toEqual({ ok: true, scenes: lines })
  })

  it("should preserve order, because the lines are a script", () => {
    const result = scenesForParts(["a", "b", "c", "d"], 4)
    expect(result.ok && result.scenes).toEqual(["a", "b", "c", "d"])
  })

  it("should refuse too few lines and name both numbers", () => {
    const result = scenesForParts(["one", "two"], 3)
    expect(result.ok).toBe(false)
    // The numbers must appear, or she cannot tell what to fix without guessing.
    expect(result.ok === false && result.reason).toMatch(/2/)
    expect(result.ok === false && result.reason).toMatch(/3/)
  })

  it("should refuse too many lines rather than dropping the extras", () => {
    const result = scenesForParts(["one", "two", "three", "four"], 3)
    expect(result.ok).toBe(false)
  })

  it("should NEVER pad by repeating the last line", () => {
    // Padding would reproduce the exact bug this fixes, in a form she could not
    // see — a part silently speaking a line she did not write for it.
    const result = scenesForParts(["only one"], 3)
    expect(result.ok).toBe(false)
  })

  it("should refuse an empty array", () => {
    expect(scenesForParts([], 2).ok).toBe(false)
  })

  it("should refuse a blank string, as the single-scene path already did", () => {
    expect(scenesForParts("   ", 2).ok).toBe(false)
  })

  it("should refuse an array containing a blank entry", () => {
    // A blank middle would render a part with no scene at all, which is a
    // silently empty segment rather than a refusal.
    expect(scenesForParts(["real", "  ", "real"], 3).ok).toBe(false)
  })

  it("should trim each line, so stray whitespace never reaches the prompt", () => {
    const result = scenesForParts(["  a  ", " b "], 2)
    expect(result.ok && result.scenes).toEqual(["a", "b"])
  })
})
