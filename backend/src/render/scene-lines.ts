/**
 * One scene sentence per part — `syl-m7lj`.
 *
 * ## Why this exists
 *
 * The scene used to be built into the prompt stem ONCE and copied into every
 * part, so a four-part clip asked for the same beat four times and she performed
 * it four times. The Commander reported the sixty-second clip as "disjointed AND
 * repetitive": `syl-v380`'s held middle fixed the first half of that sentence
 * and left the second untouched.
 *
 * **The failure that proved it is worth recording, because it looks like a model
 * defect and is not one.** Syl wrote, inside the scene, "once and only once,
 * then falls silent, saying nothing further" — and the line was spoken twice.
 * The instruction was not ignored. It was copied into both parts, each part
 * received it independently, and **each part obeyed it exactly.** Two parts each
 * correctly saying a line once is a line said twice.
 *
 * So no wording could ever have fixed it: *"only in part one"* cannot be
 * expressed in a sentence handed identically to every part. That is structural,
 * not a phrasing problem, and it is why the tool had to change rather than the
 * prompt.
 *
 * ## And the lines are a script
 *
 * Quoted text in a scene is **spoken aloud** in the finished clip — confirmed by
 * the Commander on 2026-09-03. So an array here is not merely a repetitiveness
 * fix: it is one spoken line per segment, in her words, in order.
 */

/** One scene line per part, in order, or a refusal that names both numbers. */
export type SceneLines =
  | { readonly ok: true; readonly scenes: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Resolves what she asked for into exactly one scene sentence per part.
 *
 * A single string keeps the old behaviour — the same sentence for every part —
 * so nothing she has already written stops working. An array must carry exactly
 * one entry per part.
 *
 * **Nothing here pads.** A short array is refused rather than extended by
 * repeating its last line, because padding would reproduce the very bug this
 * closes in a form she could not see: a part speaking words she did not write
 * for it. Every refusal happens before a credit is spent.
 */
export function scenesForParts(scene: string | readonly string[], parts: number): SceneLines {
  const count = Math.max(1, parts);

  if (typeof scene === "string") {
    const one = scene.trim();
    if (one === "") {
      return {
        ok: false,
        reason: "I did not catch the scene — describe what you are doing in it, in a sentence.",
      };
    }
    return { ok: true, scenes: Array.from({ length: count }, () => one) };
  }

  if (scene.length === 0) {
    return {
      ok: false,
      reason:
        "The scene list is empty — give me one sentence per part, or a single sentence for all of them.",
    };
  }

  if (scene.length !== count) {
    return {
      ok: false,
      reason:
        `You gave me ${String(scene.length)} scene ${scene.length === 1 ? "line" : "lines"} for ` +
        `${String(count)} parts. It has to be exactly one per part, in order — or one sentence ` +
        "for all of them. I will not repeat the last line to fill the gap: that is how the same " +
        "words ended up spoken twice.",
    };
  }

  const trimmed = scene.map((line) => line.trim());
  const blank = trimmed.findIndex((line) => line === "");
  if (blank !== -1) {
    return {
      ok: false,
      reason:
        `Scene line ${String(blank + 1)} is empty. A part with no scene renders a segment with ` +
        "nothing in it, so I would rather stop than make it.",
    };
  }

  return { ok: true, scenes: trimmed };
}
