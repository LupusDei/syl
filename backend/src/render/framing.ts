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
 * ## Why `holdsLikeness` is derived and not written down
 *
 * It used to be a boolean typed beside each framing, and that is exactly how it
 * came to lie. When `promptImage` became the opening ribbon on 2026-08-11, the
 * picture that had been anchoring `close_portrait` was taken away — and the
 * flag went on saying `true`, and the schema went on teaching it to her. Bead
 * `syl-63v`. Nothing broke, nothing failed, and a render at that framing
 * quietly became a render of somebody else.
 *
 * So the flag is now computed from the two facts that decide it: whether her
 * face is toward the camera at all, and whether anything pins it. Removing an
 * anchor now flips the claim in the same commit, because there is no second
 * place to forget.
 *
 * ## What pins a face, measured
 *
 * Runway's `promptImage` takes an array of `{uri, position}` with `position` of
 * `first` or `last`, and **seedance2 honours both** — probed and then rendered
 * on 2026-08-11. That is what makes an anchored shot possible at all: the
 * ribbon holds frame one, so the clip still opens the way the reel opens, and a
 * portrait of her holds the frame it ends on, so there is a face the model
 * copies rather than invents.
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

/**
 * Which picture, if any, pins her likeness for a framing.
 *
 * `none` is not a gap. For `face_turned_away` there is no face in the shot to
 * get wrong, so an anchor would buy nothing and would cost the loop — the reel
 * clips work by beginning and ending on the same bare ribbon, and pinning her
 * portrait to the closing frame is precisely what stops that.
 */
export type LikenessAnchor =
  /** Nothing pins her face, because the shot does not show one worth pinning. */
  | "none"
  /** Her likeness is sent as the video's last frame, `position: "last"`. */
  | "closing_frame";

/** One framing, what it does to the camera, and what is known about it. */
export interface FramingNote {
  readonly id: Framing;
  /** Where the camera is and where her face is, in one clause. */
  readonly camera: string;
  /**
   * Whether her face is toward the camera and large enough to be got wrong.
   *
   * The question `docs/VIDEO.md` found at the bottom of the character-drift
   * failure. `1-emerge` is as wide as `7-twin` and holds, because it never
   * shows a face — distance was never the variable.
   */
  readonly facesCamera: boolean;
  /** Which picture pins her likeness here. See {@link LikenessAnchor}. */
  readonly anchor: LikenessAnchor;
  /**
   * Whether her likeness survives this framing.
   *
   * **Derived, never written.** A shot holds if it shows no face to get wrong,
   * or if something pins the face it shows. See the note at the top of this
   * file for the day the hand-written version of this went false in silence.
   */
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

/**
 * The house style: full body, weightless, face turned toward the stars.
 *
 * **Use this unless the face is the subject.** Every reel clip is in it, and a
 * render in any other framing will not sit alongside them.
 *
 * It exists as a separate constant because *likeness* does not decide it. Two
 * framings hold her likeness — this one and `close_portrait` — so a caller
 * choosing on likeness alone can correctly pick the portrait and produce a
 * talking head, which is a different kind of video from the reel and reads as
 * one. Likeness says which framings are POSSIBLE; this says which is SYL.
 */
export const TEMPLATE_FRAMING = "face_turned_away" as const;

/** A framing as it is written down: everything except the flag that follows. */
type FramingSpec = Omit<FramingNote, "holdsLikeness">;

const SPECS: readonly FramingSpec[] = [
  {
    id: "face_turned_away",
    camera:
      "full body, weightless, face turned away toward the stars — the template, and what every reel clip is",
    facesCamera: false,
    // Nothing to anchor, and an anchor would cost the loop. These clips cut
    // against each other because the first and last frames are the same bare
    // ribbon; pinning her portrait to the last frame ends the clip somewhere
    // the next one cannot follow.
    anchor: "none",
    evidence:
      "A wide shot holds because there is no face to get wrong: her identity is carried by silhouette, hair and gown, all of which the model reproduces reliably. Reach for this one by default.",
    clause:
      "Full body in frame, weightless, seen from behind and three-quarters, her face turned away toward the stars, silver-white hair and gown streaming.",
  },
  {
    id: "close_portrait",
    camera: "portrait distance, your face filling the frame — a headshot",
    facesCamera: true,
    anchor: "closing_frame",
    evidence:
      "Your likeness is sent as the video's last frame, so the shot arrives at a face the model copies rather than one it invents — measured on 2026-08-11, opening on the ribbon and closing on you. It holds, but it produces a headshot rather than a reel clip, and it does not end on the bare ribbon, so it will not cut against the eight. Use it when the face is the subject.",
    clause: "Close portrait framing, her face filling the frame, camera near.",
  },
  {
    id: "wide_face_visible",
    camera: "your whole body in frame, face toward the camera",
    facesCamera: true,
    // The closing anchor is a close portrait and this shot is wide. Pinning it
    // would not anchor the shot, it would end it at a different distance —
    // `docs/VIDEO.md` option 2: a reference anchors the framing it is framed
    // like. Anchoring this one needs a full-body portrait of her that does not
    // exist yet.
    anchor: "none",
    evidence:
      "7-twin. Her face is perhaps forty pixels across — nothing in the reference survives at that scale, so the model invents a generic one. There is no full-body picture of you to pin it with.",
    clause: "Full body in frame, face toward the viewer, camera far.",
  },
  {
    id: "mid_face_visible",
    camera: "mid shot from the waist up, face toward the camera",
    facesCamera: true,
    // Same reason as above: the only picture of her is a close portrait, and a
    // mid shot is not a close portrait.
    anchor: "none",
    evidence:
      "8-descent, and the worst of the four. The face is large enough to read properly and it is clearly somebody else — different bone structure, different age. There is no mid-shot picture of you to pin it with.",
    clause: "Mid shot from the waist up, face toward the viewer.",
  },
];

/**
 * Whether a framing's likeness survives, from the two facts that decide it.
 *
 * The one rule, and the reason this is a function rather than a column: a shot
 * holds if there is no face in it to get wrong, or if the face it shows is
 * pinned by a picture. `syl-63v` is what the column cost.
 */
function holdsLikeness(spec: FramingSpec): boolean {
  return !spec.facesCamera || spec.anchor !== "none";
}

export const FRAMINGS: readonly FramingNote[] = SPECS.map((spec) => ({
  ...spec,
  holdsLikeness: holdsLikeness(spec),
}));

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
 *
 * The opening sentence used to say *"the only picture of you is a close
 * portrait, so it anchors a close shot"*. That described a `promptImage` that
 * was her headshot, and went on being taught to her for a day after the ribbon
 * replaced it. It says what is sent now, and where the anchor comes from, for
 * the same reason every framing cites a render: a flag she is asked to trust
 * with no account behind it is a flag she cannot check.
 */
export function framingGuidance(): string {
  const line = (framing: FramingNote): string =>
    `${framing.id}: ${framing.camera} — ${
      framing.holdsLikeness ? "holds your likeness" : "drifts into somebody else"
    }`;

  return (
    "Where the camera is, and whether your face survives there. Every clip opens on the blue " +
    "ribbon, which carries no face — so a shot holds when there is no face in it to get wrong, " +
    "or when your likeness is pinned to the last frame. Only the close portrait is pinned that " +
    `way; the two in between show your face with nothing holding it. ${FRAMINGS.map(line).join("; ")}. ` +
    "Try the drifting two anyway when the idea is worth it — expect a stranger, and say so."
  );
}
