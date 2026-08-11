/**
 * Whether a reminder may pierce quiet hours.
 *
 * `syl-p8k`. This is the half of the urgency fix that does the **checking**,
 * and it is the half that decides whether the other half meant anything.
 *
 * ## What this is for
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
 * string at all, so she can wake him by writing the field. That line does not
 * appear in this codebase and must not; the handler in `tools/server.ts` calls
 * this function instead, and `tests/acceptance/urgency-is-evidence.test.ts` is
 * the guard that says so.
 *
 * Absent, empty, or unmatched all mean **not urgent**. The safe answer is the
 * default here, deliberately: the failure mode of being too strict is a
 * reminder that waits until morning, and the failure mode of being too lax is
 * his house woken at three for a friend's birthday. Those are not comparable
 * costs, and his sleep is the constraint most likely to cost trust.
 *
 * ## How it matches
 *
 * **Forgiving of case and punctuation, unforgiving of everything else.** She is
 * quoting him, not paraphrasing him, and a fuzzy match here is a boolean
 * wearing a costume — anything that scores similarity has a threshold, and a
 * threshold is a knob somebody turns down the first time a legitimate urgent
 * reminder waits until morning.
 *
 * So both strings are reduced to a sequence of bare words, and the quote has to
 * appear in his message as a **contiguous run of whole words, in his order**.
 * That accepts every way the same sentence can be written down — capitals, a
 * comma, an em dash, a stray double space — and accepts nothing else. In
 * particular it refuses:
 *
 * - a re-ordering (`"tonight me wake"`), which is a bag of his words rather
 *   than a phrase he said;
 * - an insertion (`"wake me up tonight"` against "wake me tonight"), which is
 *   her sentence built out of his vocabulary;
 * - a partial word (`"wake"` inside "awaken"), which is a spelling coincidence
 *   and not a quotation.
 *
 * ## What it deliberately does NOT do
 *
 * It does not judge whether the quoted words *express* urgency. That would be a
 * word list — "tonight", "wake", "whatever the hour" — and a word list is
 * exactly the parser `tools/time.ts` argues at length against becoming: it
 * would refuse "ping me even if I'm asleep" and accept "I was up all night
 * Tuesday". The question this function answers is narrower and is the one that
 * can actually be answered from evidence: **did he say this?** Whether what he
 * said was a request to be woken is his sentence to write and hers to read, and
 * the model reading it is the part of the system that is good at that.
 *
 * The residue is that a quote of any run of his words passes — including an
 * innocuous one. That is a real limit and it is stated rather than papered
 * over: it bounds her to his vocabulary and to phrases he actually used, which
 * is the whole distance between this and `!== undefined`, and it is where the
 * evidence runs out.
 */

/**
 * Everything that is not a letter, a digit, or whitespace.
 *
 * Unicode-aware, because his phone autocorrects a hyphen into an en dash and a
 * quote into a curly one, and a quotation that failed because of a character he
 * never typed would be indistinguishable from a fabricated one.
 */
const NOT_A_WORD = /[^\p{L}\p{N}\s]+/gu;

/**
 * A string reduced to the words in it, lowercased.
 *
 * Empty in exactly the case that matters: a "quote" made only of punctuation
 * normalises to no words at all, and no words must never match. An empty
 * sequence is a subsequence of everything, which would be `!== undefined`
 * arriving by the back door.
 */
function words(text: string): readonly string[] {
  return text
    .toLowerCase()
    .replace(NOT_A_WORD, " ")
    .split(/\s+/u)
    .filter((word) => word !== "");
}

/** Whether `needle` occurs in `haystack` as a contiguous run, in order. */
function containsRun(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;

  for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    let matched = true;
    for (const [offset, word] of needle.entries()) {
      if (haystack[start + offset] !== word) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

/**
 * Does his own message support the urgency she is claiming?
 *
 * @param quoted the words she put in `urgentBecauseHeSaid`, if any
 * @param hisMessage what he actually wrote this turn. An empty string is the
 *   *unverifiable* case — no message to compare against — and grants nothing,
 *   which is why the handler passes `""` rather than skipping the check when it
 *   cannot find his message.
 * @returns `true` only when the quote is genuinely his
 */
export function verifyUrgency(quoted: string | undefined, hisMessage: string): boolean {
  if (quoted === undefined) return false;
  return containsRun(words(hisMessage), words(quoted));
}
