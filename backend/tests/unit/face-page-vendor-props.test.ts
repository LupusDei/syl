import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { FACE_PAGE_HTML, RUNWAY_AVATARS_VERSION } from "../../src/routes/face-page.js";

/**
 * **A prop the vendor does not accept is a feature wired to nothing.**
 *
 * ## The defect this class of test exists for
 *
 * `syl-chzl.10`: the face page passed `onConnected` and `onDisconnected` to
 * `AvatarCall`. The component accepts neither — it destructures a fixed list and
 * spreads the rest onto a `div`, so React warned to a console nobody on a phone
 * can read and dropped them. `tell('connected')` never fired, the media watch
 * hung off a callback that did not exist and therefore never ran, and `playing`,
 * `autoplay_blocked`, `no_media` and `ended` were **unreachable code in a shipped
 * build**. Every session the Commander opened fell through to the phone's
 * forty-five second deadline while she talked to him from behind a black screen.
 *
 * Nothing in this repository could have caught it. The SDK is imported from a
 * CDN at runtime, so there is no install, no lockfile and no compiler between
 * the vendor's prop names and his phone. `onConnected` type-checked, rendered,
 * and did nothing.
 *
 * ## Why this is the general fix and not a second patch
 *
 * It is the sixth time in this epic that something was wired to nothing, and the
 * first time the *class* is catchable. The test reads the SDK's **own published
 * declaration** — captured verbatim from the npm tarball by
 * `backend/scripts/capture-avatar-sdk-declaration.mjs` — and asserts that every
 * prop the page hands `AvatarCall` appears in the parameter list that component
 * actually destructures.
 *
 * ## The two ways this could be worthless, both closed
 *
 * 1. **A fixture for a version nobody runs.** The page used to import the SDK
 *    *unpinned*, so it loaded whatever esm.sh called latest — and a declaration
 *    can only answer "does it accept this prop" for a version you can name.
 *    The page is pinned to {@link RUNWAY_AVATARS_VERSION} now, the fixture
 *    records the version it was captured from, and the first test below compares
 *    them. Bumping the pin without re-capturing fails here.
 * 2. **A regex that matches nothing.** Every extraction is asserted non-empty
 *    against a name known to be in it, so a parse that silently returns zero
 *    props cannot make the guard pass by having nothing to check.
 */

/**
 * The capture. `.txt` rather than `.d.ts` on purpose — see the header of
 * `backend/scripts/capture-avatar-sdk-declaration.mjs`: this workspace compiles
 * `tests/**\/*.ts`, and a real declaration file here would drag three uninstalled
 * vendor packages into the typecheck, surviving only on `skipLibCheck`.
 */
const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "runway-avatars-react-declaration.txt",
);

const declaration = readFileSync(FIXTURE, "utf8");

/**
 * The names `AvatarCall` **destructures**, from the captured declaration.
 *
 * # DESTRUCTURED, NOT DECLARED — and the obvious simplification is wrong
 *
 * The tempting version of this function reads `AvatarCallProps`. It is shorter,
 * it is what a types-first instinct reaches for, and **it would not have caught
 * the bug this whole file exists for.** `AvatarCallProps` extends
 * `ComponentPropsWithoutRef<'div'>`, so it admits every DOM attribute and every
 * DOM event handler — `onClick`, `onLoad`, hundreds of names. It is a set
 * defined by what React will *tolerate*, not by what this component *reads*.
 *
 * What the component reads is the destructuring list in its own signature.
 * Everything else falls into the `...props` rest and is spread onto a `div`:
 *
 * - for `className` or `style`, that is intended and harmless;
 * - for a **handler**, it is a callback that type-checks, renders, and is never
 *   invoked. `onConnected` was accepted by `AvatarCallProps` and dropped by the
 *   component, and that combination is exactly why nothing caught it for a day.
 *
 * So membership of the destructured list is the bar. A page that one day
 * genuinely wants a DOM attribute has to come here and say so, which is the
 * correct amount of friction: it is the difference between "React allows this"
 * and "this component does something with it".
 *
 * **If you are here to simplify this, that is the thing you would be deleting.**
 */
function propsTheComponentTakes(): readonly string[] {
  const signature = /declare function AvatarCall<[^>]*>\(\{([^}]*)\}/.exec(declaration);
  expect(signature, "the fixture no longer declares AvatarCall the way it did").not.toBeNull();

  return (signature?.[1] ?? "")
    .split(",")
    .map((part) => (part.split(":")[0] ?? "").trim())
    .filter((name) => name.length > 0 && !name.startsWith("..."));
}

/**
 * The prop names the page hands `AvatarCall`, with comments stripped.
 *
 * The comments at that call site name the two dead handlers on purpose, so a
 * reader is warned off putting them back — and a scan that read them would be
 * answered by the warning instead of by the code.
 *
 * **Top-level keys only**, taken by indentation: a prop sits at exactly eight
 * spaces and everything inside a handler body is deeper, so `say(` and
 * `tell(` in `onError` are not mistaken for props. That does couple this to the
 * page's formatting, and the coupling is made safe rather than hidden — the
 * caller asserts the result is non-empty and contains a name known to be there,
 * so a re-indent fails loudly here instead of quietly checking nothing.
 */
function propsThePagePasses(): readonly string[] {
  const start = FACE_PAGE_HTML.indexOf("root.render(h(AvatarCall, {");
  expect(start, "the page no longer renders AvatarCall the way it did").toBeGreaterThan(-1);

  const call = FACE_PAGE_HTML.slice(start, FACE_PAGE_HTML.indexOf("\n      }));", start)).replaceAll(
    /^\s*\/\/.*$/gm,
    "",
  );

  return [...call.matchAll(/^ {8}([A-Za-z_$][\w$]*)\s*:/gm)].map((match) => match[1] ?? "");
}

describe("the props the page hands the avatar SDK", () => {
  it("should be captured from the version the page actually loads", () => {
    // The whole guard rests on this. A declaration for 0.17.0 says nothing
    // about a page that imports whatever the CDN calls latest, and it says
    // nothing about a page pinned to 0.18.0 either.
    expect(declaration).toContain(`CAPTURED, NOT WRITTEN. @runwayml/avatars-react@${RUNWAY_AVATARS_VERSION}`);
  });

  // **That the page is PINNED is asserted next door**, in `face-page.test.ts`'s
  // preload/import correspondence test — one fact, one place, and that is the
  // test that owns what these three URLs say. It is the precondition for
  // everything below: a declaration can only answer "does it accept this prop"
  // for a version the page can be shown to load.

  it("should every one of them be a prop that component actually destructures", () => {
    // THE ASSERTION. `onConnected` would have failed here on the day it was
    // written, and nothing else in this repository could have said a word.
    const taken = propsTheComponentTakes();
    const passed = propsThePagePasses();

    // ================================================================
    // THESE FOUR LINES ALREADY EARNED THEIR PLACE, ON THIS TEST'S FIRST RUN.
    //
    // Neither extraction may be vacuous: a regex that matched nothing would
    // make the loop below iterate zero times and the test pass by having no
    // work to do. That is the meaningless green this project has shipped once
    // before and rewrote a whole rule about.
    //
    // It was not hypothetical here. **`propsThePagePasses()` returned `[]` the
    // first time this ran** — the parser I wrote counted brace depth from the
    // wrong place and matched nothing at all. Without the line below, this test
    // would have gone green, been committed, and stood as *the* guard against
    // props wired to nothing while itself being wired to nothing.
    //
    // A test for the wrong-wiring class, wrongly wired, caught only by the one
    // assertion whose entire job is to prove the test is doing something. Do
    // not remove these as noise; they are the only part of this file that can
    // fail for the right reason when everything else is subtly broken.
    // ================================================================
    expect(taken).toContain("sessionId");
    expect(taken.length).toBeGreaterThan(8);
    expect(passed).toContain("sessionKey");
    expect(passed.length).toBeGreaterThan(4);

    for (const prop of passed) {
      expect(
        taken,
        `the page passes \`${prop}\` and AvatarCall@${RUNWAY_AVATARS_VERSION} does not ` +
          `destructure it — it will be spread onto a div and silently do nothing`,
      ).toContain(prop);
    }
  });

  it("should be checked against a declaration that still swallows the unknown", () => {
    // WHY a missing prop is silent rather than loud, pinned so the reasoning
    // stays visible. If the vendor ever drops the rest spread, an unknown prop
    // would surface some other way and this guard's justification changes.
    expect(declaration).toMatch(/declare function AvatarCall<[^>]*>\(\{[^}]*\.\.\.props\s*\}/);
  });

  it("should name the two handlers that were wired to nothing, so they cannot come back", () => {
    // Belt for the general check above: these two specifically, by name,
    // because they cost the Commander every session he opened for a day.
    const taken = propsTheComponentTakes();

    expect(taken).not.toContain("onConnected");
    expect(taken).not.toContain("onDisconnected");
    expect(taken).toContain("onEnd");
    expect(propsThePagePasses()).not.toContain("onConnected");
  });
});
