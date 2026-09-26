/**
 * The formula, in the words she reads before writing an episode (`syl-8tts`).
 *
 * **Why this reaches her as a tool ANSWER and not in the tool's description.**
 * The description is paid for on every turn, and the surface budget
 * (`tests/unit/tool-surface-budget.test.ts`) has almost nothing left. This is
 * paid for only on the turn she is writing an episode, which is the only turn
 * it is any use on. `make_episode` with no scenes returns it.
 *
 * It is the runwayml kit's FORMULA.md, cut to what she writes. The picture
 * settings, the voice and the checking are done for her, so they are
 * mentioned only where they change what she writes.
 */

import { MAX_SCENES, MAX_WORDS_PER_SCENE, MIN_SCENES } from "./rules.js";

export const FORMULA = `An episode is a cartoon lesson for small children, told by you, in your own voice. Its job is to ENTERTAIN first and teach second; a beat that is true and not fun has failed.

SHAPE. One scene per 15-second beat: 6 scenes for ninety seconds, 12 for three minutes (${String(MIN_SCENES)}-${String(MAX_SCENES)} allowed).
- 90 s: 1 hook (greet every child by name, set up a trip or a question, first fact) · 2-5 one or two facts each · 6 payoff (recap the list out loud, a callback, goodbye by name).
- 3 min adds a spine (a race, a trip, a hunt), a midpoint the children answer ("Who's the fastest? Say it with me!"), a quiet wonder beat near the end, and a recap chant.
- Teach ONE idea from many angles, and measure every number in something a child already has: a snap, brushing teeth, a movie, an afternoon, a birthday.

EVERY BEAT: one true, checkable fact (the weird one beats the important one) · a comparison a small child can picture · a physical gag with your unicorn that escalates across the episode and pays off at the end.

EACH SCENE has four parts:
- line: exactly what you say. At most ${String(MAX_WORDS_PER_SCENE)} words, numbers as words, short sentences, sound words ("Ooh, toasty!", "Achoo!"). The first and last lines say every child's name, spelled the way it is SAID (below). Never "Bye, <name>" when the name starts with a vowel: the words merge. Say "See you soon, <name>!"
- action: what we see, in one or two sentences. Never ask the picture to count past three, never ask for writing, and describe props that usually carry words as plain.
- sfx: the sounds that action makes. They are made with the picture, so they land on it.
- factCheck: how the line's facts were checked, with the arithmetic and the source ("1 AU at c = 499 s, so 8.3 min"), or "no factual claims". Myths are not facts: if historians dispute it, pick another.

WHAT HAPPENS NEXT. Nothing is spent on a script that breaks these rules, and you are told which rule. Once it starts, every take is heard and re-made if it said the wrong words or garbled a name. About 450 credits a scene. It takes 8-15 minutes, and you are woken to look at it with see_myself before you decide to show him.`;

/** What she reads: the formula, whose names to say, and whether it can run here. */
export function guide(names: readonly string[], unavailable: string | null): string {
  const spelled =
    names.length === 0
      ? "No children's names are set up; greet them by name anyway, and the names will not be checked."
      : `The children's names, spelled the way they are said: ${names.join(", ")}.`;
  const state = unavailable === null ? "" : `\n\nRight now it cannot run: ${unavailable}`;
  return `${FORMULA}\n\n${spelled}${state}`;
}
