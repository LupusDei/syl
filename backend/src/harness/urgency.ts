/**
 * Whether a reminder may pierce quiet hours — **declared, not yet built**.
 *
 * `syl-p8k`. This file exists so the seam is a typed contract rather than a
 * name inside a test, and so the red test that guards it fails at runtime for
 * the reason it is named for instead of failing to compile.
 *
 * ## What has to be true when this is implemented
 *
 * `syl-j55` changed `remind_me` from `urgent: boolean` to
 * `urgentBecauseHeSaid: string` — his words, quoted — because a phrase can be
 * checked against what he actually wrote and a boolean cannot be checked
 * against anything. **That is only a safeguard if something does the checking.**
 *
 * The one-liner that suggests itself when the handler lands is
 *
 * ```ts
 * urgent: input.urgentBecauseHeSaid !== undefined
 * ```
 *
 * and it restores the defect in full: a presence check is satisfied by any
 * string at all, so she can wake him by writing the field. Compare the quoted
 * phrase to his actual message for that turn, or return `false`.
 *
 * Absent, empty, or unmatched all mean **not urgent**. The safe answer is the
 * default here, deliberately: the failure mode of being too strict is a
 * reminder that waits until morning, and the failure mode of being too lax is
 * his house woken at three for a friend's birthday. Those are not comparable
 * costs, and his sleep is the constraint most likely to cost trust.
 *
 * Matching should be forgiving of case and surrounding punctuation and
 * unforgiving of everything else — she is quoting him, not paraphrasing him,
 * and a fuzzy match here is a boolean wearing a costume.
 */
export class UrgencyNotImplementedError extends Error {
  constructor() {
    super(
      "verifyUrgency is declared but not implemented (syl-p8k). Until it is, no reminder may " +
        "bypass quiet hours: wire this before the remind_me handler, not after.",
    );
    this.name = "UrgencyNotImplementedError";
  }
}

/**
 * Does his own message support the urgency she is claiming?
 *
 * @param quoted the words she put in `urgentBecauseHeSaid`, if any
 * @param hisMessage what he actually wrote this turn
 * @returns `true` only when the quote is genuinely his
 */
export function verifyUrgency(_quoted: string | undefined, _hisMessage: string): boolean {
  throw new UrgencyNotImplementedError();
}
