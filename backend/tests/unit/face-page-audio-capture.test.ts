import { describe, expect, it } from "vitest";

import { FACE_PAGE_HTML } from "../../src/routes/face-page.js";

/**
 * **She could hear herself, and answered.**
 *
 * ## The defect
 *
 * `syl-chzl.4.9`. The Commander reported that she replied "I am Syl, powered by
 * Runway" to every question. Runway keeps a verbatim transcript of every
 * realtime session at `GET /v1/avatar_conversations/{sessionId}` — free, keyed
 * on an id we already store — and session `b547219a` records this in the **user**
 * channel:
 *
 * > "Are you present? Um, what am I supposed to get done today?
 * >  **You are Silv. Powered by Syl and spreading powers.**
 * >  What do you know about me? What do you know about me?"
 *
 * He never said that. It is her own voice coming back in through the microphone,
 * mangled by speech recognition into an assertion about who she is — which she
 * then answered, four times, feeding each answer back in again. Every session
 * that day carries the same fingerprint: verbatim doubled sentences in her
 * replies ("I'm here. What is it? I'm here. What is it?") and fragments of her
 * own lines showing up as his.
 *
 * It was never a knowledge-base failure. The same transcripts show her listing
 * six of her seven attached documents unprompted, with no tool call, using his
 * name — which appears nowhere but those documents.
 *
 * ## THESE SETTINGS WERE NEVER SET. They were not set WRONGLY.
 *
 * This matters to whoever reads it next: there is no history here of someone
 * choosing these values badly, measuring something, and settling on what you
 * see. `echoCancellation`, `noiseSuppression` and `autoGainControl` had **zero
 * occurrences** in this repository — iOS, backend and frontend — until the
 * commit that added this file. The page opened a bare `{ audio: true }` and
 * handed the real capture to the SDK's defaults without passing the one prop
 * that can reach them. So nobody should be cautious about changing these; there
 * is no prior judgement to overturn, only an absence that was finally noticed.
 *
 * ## Why a test, and why this shape
 *
 * It is the seventh thing in this epic that was wired to nothing, and a setting
 * nobody asserts on is a setting somebody deletes. This is the same shape as
 * `face-page-vendor-props.test.ts`: the page is a string compiled into the
 * build, loaded from a CDN on a phone, with no lockfile and no compiler between
 * these values and his ears. Scanning the document is the only instrument that
 * reaches them.
 *
 * The **fence** assertions are the load-bearing ones. `__unstable_roomOptions`
 * is marked `@internal` by the vendor and could be renamed in any release;
 * `fenceTheCamera` is ours, it is installed before the SDK is imported, and
 * every capture on the page — including the SDK's own — goes through it. If the
 * declarative half stops working, the fence still holds.
 */

/** The three flags, as the page must ask for them. */
const PROCESSING = ["echoCancellation", "noiseSuppression", "autoGainControl"] as const;

/** The `AvatarCall` call site, comments stripped so a warning cannot satisfy a scan. */
function avatarCallSite(): string {
  const start = FACE_PAGE_HTML.indexOf("root.render(h(AvatarCall, {");
  expect(start, "the page no longer renders AvatarCall the way it did").toBeGreaterThan(-1);

  return FACE_PAGE_HTML.slice(start, FACE_PAGE_HTML.indexOf("\n      }));", start)).replaceAll(
    /^\s*\/\/.*$/gm,
    "",
  );
}

describe("the audio the face page captures", () => {
  it("should ask the SDK for a processed microphone, through the one prop that reaches it", () => {
    const call = avatarCallSite();

    // Non-vacuity first, in the house style: a slice that matched nothing would
    // make every assertion below pass by having no text to disagree with. This
    // is the line that already earned its place once, next door.
    expect(call).toContain("sessionKey");

    expect(
      call,
      "AvatarCall is rendered without `__unstable_roomOptions`, which is the only prop " +
        "the vendor declaration exposes that can reach livekit's capture defaults",
    ).toContain("__unstable_roomOptions");
    expect(call).toContain("audioCaptureDefaults");

    // **THE SHARED CONSTANT, not three literals repeated here.** One set of
    // values in one place is the same discipline `quiet-window.test.ts`
    // enforces for the quiet hours, and for the same reason: a second copy is a
    // second thing to disagree with the first. So the call site must reference
    // it by name, and the values are asserted once, below.
    expect(
      call,
      "the capture defaults are written out at the call site instead of referencing " +
        "AUDIO_PROCESSING, so the fence and the SDK can now be given different answers",
    ).toContain("audioCaptureDefaults: AUDIO_PROCESSING");
  });

  it("should ask for all three kinds of processing, and for echo cancellation above all", () => {
    const constant = FACE_PAGE_HTML.slice(
      FACE_PAGE_HTML.indexOf("const AUDIO_PROCESSING = {"),
      FACE_PAGE_HTML.indexOf("function withAudioProcessing"),
    );
    expect(constant.length, "AUDIO_PROCESSING is gone or has been renamed").toBeGreaterThan(50);

    for (const flag of PROCESSING) {
      expect(constant, `\`${flag}\` is no longer requested of the microphone`).toMatch(
        new RegExp(`${flag}\\s*:\\s*true`),
      );
    }
  });

  it("should apply the same processing to every capture the page itself opens", () => {
    // The permission probe in `askForTheMicrophone` predates the SDK and is our
    // own call. A bare `audio: true` there is the literal line that shipped.
    expect(
      FACE_PAGE_HTML,
      "a bare `{ audio: true, video: false }` getUserMedia is still in the page; it must " +
        "carry the processing constraints like every other capture",
    ).not.toContain("getUserMedia({ audio: true, video: false })");
  });

  it("should force the constraints through the fence, so the SDK's own capture cannot skip them", () => {
    // THE ASSERTION THAT SURVIVES A VENDOR RENAME. `__unstable_roomOptions` is
    // `@internal`; the fence is ours and sees every capture on the page.
    const fence = FACE_PAGE_HTML.slice(
      FACE_PAGE_HTML.indexOf("function fenceTheCamera()"),
      FACE_PAGE_HTML.indexOf("let root = null;"),
    );
    expect(fence.length, "the camera fence has moved or been renamed").toBeGreaterThan(200);

    // Both branches — the audio-only pass-through AND the video rewrite — must
    // go through the merge. The audio-only branch is the one livekit takes.
    expect(
      fence,
      "the fence lets a capture through without applying the processing constraints",
    ).toContain("withAudioProcessing");
    expect(fence.match(/withAudioProcessing\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("should let the page's constraints win over whatever the caller asked for", () => {
    // Deliberate: the SDK asking for `echoCancellation: false` must not get it.
    // Assign order is the whole mechanism, so it is asserted rather than trusted.
    const helper = FACE_PAGE_HTML.slice(
      FACE_PAGE_HTML.indexOf("function withAudioProcessing"),
      FACE_PAGE_HTML.indexOf("function fenceTheCamera()"),
    );
    expect(helper.length, "withAudioProcessing is not defined before the fence").toBeGreaterThan(
      100,
    );
    expect(
      helper,
      "the caller's audio constraints are merged after ours, so a caller could disable " +
        "echo cancellation and the page would let it",
    ).toMatch(/Object\.assign\([^)]*AUDIO_PROCESSING\s*\)/);
  });
});
