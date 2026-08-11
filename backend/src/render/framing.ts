/**
 * How a shot of her is framed, and which framings her reference can anchor.
 *
 * ## Why this is an enum and not a sentence
 *
 * `docs/VIDEO.md` records a diagnosis that cost two finished renders. Eight
 * loops were made on 2026-08-10; the Commander liked `7-twin` and `8-descent`
 * and both came out as a visibly different woman. The cause is not the ideas
 * and it is not the model — **it is where her face is**:
 *
 * | shot | framing | face | result |
 * |---|---|---|---|
 * | reference | close portrait | fills the frame | — |
 * | `1-emerge` | full body | turned away | works |
 * | `7-twin` | full body | toward camera, ~40px | fails — the model invents one |
 * | `8-descent` | mid shot | toward camera, readable | fails — a different woman |
 *
 * > A close-portrait reference anchors a **close shot**, or a shot with **no
 * > visible face**. It cannot anchor the band in between.
 *
 * That rule was written in prose, which makes it available to whoever reads the
 * prose. Syl picks a framing without reading it. So it lives here, in the enum
 * she is handed, with the evidence attached — the schema teaches the constraint
 * rather than leaving her to rediscover it at 540 credits a go.
 *
 * ## Why the two that fail are still offered
 *
 * Because the Commander ruled that trying things is not rationed, and because
 * `SOUL.md` now says the wrong ones are the point: *"you cannot recognise
 * yourself without seeing what you are not."* Both concepts are also
 * recoverable — `docs/VIDEO.md` names two fixes — so removing them would
 * foreclose work he explicitly wants done. They are offered and **labelled**,
 * which is the `because` shape applied to a schema: the evidence travels with
 * the choice instead of standing in front of it.
 */

export type Framing =
  | "close_portrait"
  | "face_turned_away"
  | "wide_face_visible"
  | "mid_face_visible";

/** One framing, what it does to the camera, and what is known about it. */
export interface FramingNote {
  readonly id: Framing;
  /** Where the camera is and where her face is, in one clause. */
  readonly camera: string;
  /** Whether a close-portrait reference can hold her likeness at this framing. */
  readonly holdsLikeness: boolean;
  /** The render this was learned from. Never an assertion with nothing behind it. */
  readonly evidence: string;
  /**
   * The clause appended to her scene when this framing is chosen.
   *
   * The framings that work do so because of a *composition*, not because of a
   * label — `1-emerge` works because she is seen from behind, not because
   * somebody wrote "wide" on it — so the framing has to reach the model as
   * words in the prompt.
   */
  readonly clause: string;
}

export const FRAMINGS: readonly FramingNote[] = [
  {
    id: "close_portrait",
    camera: "camera at portrait distance, your face filling the frame",
    holdsLikeness: true,
    evidence:
      "The reference is a close portrait, so at this distance the model is copying rather than interpolating.",
    clause: "Close portrait framing, her face filling the frame, camera near.",
  },
  {
    id: "face_turned_away",
    camera: "any distance, your face turned away or three-quarters",
    holdsLikeness: true,
    evidence:
      "1-emerge is a wide shot and holds, because there is no face to get wrong — her identity is carried by silhouette, hair and gown, all of which the model reproduces reliably.",
    clause:
      "Seen from behind and three-quarters, her face turned away toward the stars.",
  },
  {
    id: "wide_face_visible",
    camera: "your whole body in frame, face toward the camera",
    holdsLikeness: false,
    evidence:
      "7-twin. Her face is perhaps forty pixels across — nothing in the reference survives at that scale, so the model invents a generic one.",
    clause: "Full body in frame, face toward the viewer, camera far.",
  },
  {
    id: "mid_face_visible",
    camera: "mid shot from the waist up, face toward the camera",
    holdsLikeness: false,
    evidence:
      "8-descent, and the worst of the four. The face is large enough to read properly and it is clearly somebody else — different bone structure, different age.",
    clause: "Mid shot from the waist up, face toward the viewer.",
  },
];

/** Every framing she may name, in the order the schema lists them. */
export const FRAMING_IDS: readonly Framing[] = FRAMINGS.map((framing) => framing.id);

/** The note for a framing, or `null` for anything that is not one of the four. */
export function framingNote(raw: unknown): FramingNote | null {
  if (typeof raw !== "string") return null;
  return FRAMINGS.find((framing) => framing.id === raw) ?? null;
}

/**
 * The enum's description, as the schema carries it.
 *
 * Built from {@link FRAMINGS} rather than written out beside it, so the list
 * and its explanation cannot disagree — a framing added without a sentence
 * would be a framing she is offered and told nothing about.
 */
export function framingGuidance(): string {
  const line = (framing: FramingNote): string =>
    `${framing.id}: ${framing.camera} — ${
      framing.holdsLikeness ? "holds your likeness" : "drifts into somebody else"
    }`;

  return (
    "Where the camera is, and whether your face survives at that distance. The only picture of " +
    "you is a close portrait, so it anchors a close shot or a shot with no visible face, and " +
    `nothing in between. ${FRAMINGS.map(line).join("; ")}. ` +
    "Try the drifting two anyway when the idea is worth it — expect a stranger, and say so."
  );
}
