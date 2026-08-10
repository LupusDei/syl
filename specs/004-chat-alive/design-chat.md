# Chat — the design direction

**Feature**: 004-chat-alive · **Epic**: `syl-008` · **Refines**: US2 "chat belongs to the same world"
**Author**: Fearless Fenix · **Date**: 2026-08-10

## Why this document exists

US2 as written is four acceptance scenarios about palette and glass. Every one of them
can be satisfied by find-and-replacing `Color(.secondarySystemBackground)` with
`sylGlass()` and putting a `Veil()` behind the list — and the result would still be
iMessage in a nicer colourway.

That is a **reskin**. The Commander asked for a facelift. The difference between the two
is whether any *structural* decision gets made, and US2 currently makes none: it does not
say what typographic scale markdown renders into, where the parse happens, what a turn
looks like when it is a document rather than a sentence, how time reads down the page,
how a message arrives, or what the composer *is*.

Those are the decisions. This document makes them.

---

## 1. The one structural decision: her turns are a page, his are objects

> **DECIDED — 2026-08-10, by the Commander's instruction to make the chat surface a
> *dramatic* facelift with "more beauty and magic like the home page", and to execute the
> epic to completion.** Recorded on bead `syl-008.3.7`. The direction below is settled and
> `T015` may proceed against it. The fallback in "The honest cost" remains available
> because it is one modifier; the *layout* decision does not reopen.

**Today**: two rounded rectangles, one blue, one grey. Both speakers boxed identically.

**Decided**: **she is unboxed; he is boxed.**

- **Syl's turn** is set as a *page* — full measure, no container, ink on the veil, with a
  hairline **light-rail** down the left margin carrying her `luminance` gradient. It is
  typeset, not bubbled.
- **The Commander's turn** is a compact glass object, inset from the right, `sylGlass()`
  at reduced `presence`, capped at ~78% of the measure.

### Why this is the right call and not merely a different one

1. **A bubble is the worst possible container for a document.** US1 is about to make her
   messages contain headings, ordered lists, blockquotes, tables and fenced code. Every
   one of those block elements fights a rounded rectangle: the code slab wants to scroll
   horizontally *inside* a box that is already inside a vertical scroll view; the heading
   wants space above it that the bubble's padding has already spent; a table wants the
   full width the bubble is specifically denying it. **Unboxing her is what makes US1 look
   good rather than merely render.** Ship US1 into bubbles and the markdown work is half
   wasted.

2. **The asymmetry is true to the content.** His messages are one line. Hers are twelve.
   Giving two wildly different content shapes the same container is the tell of a
   template. A bubble is exactly right for "remind me at six"; it is exactly wrong for a
   research brief.

3. **It makes the world consistent, structurally rather than cosmetically.** Home is a
   veil with a spine down it. Chat becomes the same: a veil, with her light running down
   the left margin. The light-rail *is* `DaySpine`'s vocabulary — the same hairline, the
   same luminance — carried into the transcript. That is what "belongs to the same world"
   should mean. Painting bubbles blue-grey is not it.

4. **The one boxed thing on screen is the thing he authored.** She is the weather; he is
   the object in it. That reads instantly and it is the app's whole thesis.

5. **Stock iOS dies immediately.** The acceptance test is "screenshot it beside home and
   they read as one product". Two tinted bubble columns will never pass that no matter
   what colours go in them.

### The honest cost

Unboxed text loses the at-a-glance "who said this". Three things pay for it, and all
three are already in the design system:

- **The light-rail** (hairline + `luminance`, left margin, hers only).
- **Alignment and measure** — hers full-bleed left, his inset right and narrow.
- **Weight** — hers in `ink`, his in `ink` on glass, which reads as a different plane.

If that still fails on the device, the fallback is her turn on a `sylGlass(presence: 0.35)`
slab with `Metric.cardRadius` — a page *on* glass rather than a bubble. That fallback is
one modifier, which is the point: the layout decision survives it.

**This is the one fork worth an explicit answer before the restyle beads start**, because
reversing it after T015–T018 have landed is a rewrite, not an edit.

---

## 2. The typographic scale markdown renders into

`SylTheme.Typeface` exists and does not cover block content. It gains one nested scale —
`Typeface.Prose` — so the renderer never invents a size at a call site. Every value is
relative to a text style, so Dynamic Type still scales the whole screen.

| Block | Face | Colour | Space before / after |
|---|---|---|---|
| H1 / H2 | `.system(.title3, design: .serif)` | `ink` | `loose` / `snug` |
| H3+ | `sylLabelStyle()` (letterspaced caps) | `inkFaint` | `step` / `tight` |
| Body | `.system(.body)`, `lineSpacing(5)` | `ink` | — / `step` |
| List item | body, hanging indent `gutter` | `ink`, marker in `luminance` | `tight` between |
| Ordered marker | `Typeface.numeral` (monospaced digits) | `luminance` | — |
| Blockquote | `.body` italic, left hairline rule | `inkSoft` | `step` / `step` |
| Code (fenced) | `.system(.footnote, design: .monospaced)` | `ink` | `step` / `step` |
| Code (inline) | `.system(.callout, design: .monospaced)` | `ink` on `hairline` chip | — |
| Table | `.footnote`, monospaced digits | `ink`, header `inkFaint` caps | `step` / `step` |
| Rule | `hairline`, 1pt | — | `gutter` / `gutter` |

Decisions inside that table worth stating out loud:

- **H3 becomes a label, not a shouty line.** Reusing `sylLabelStyle()` for third-level
  headings means deep structure reads as a *section marker* — the same treatment as
  `TODAY · 10 AUGUST` on home — rather than as another size of black text. It also stops
  the scale needing five heading sizes on a 390pt screen.
- **Ordered markers are monospaced digits.** `9.` → `10.` must not reflow the text column.
- **The code slab is `radius: 14`, not `cardRadius: 22`.** A code block is a document
  element, not a card. Card radius on an inline element reads as a widget.
- **Measure is capped at 640pt.** Irrelevant on iPhone, essential the day this runs on an
  iPad or a Mac window: a 1000pt line of body text is unreadable regardless of how pretty
  the palette is.
- **Nothing is ever truncated.** Overflow scrolls (code, tables) or wraps (everything
  else). A truncated answer from an assistant is a broken answer.

---

## 3. Where the parse happens — an architecture decision, not a styling one

**The markdown parse must not happen in `body`.**

US2 scenario 4 says "a transcript of 500 messages scrolls without dropping frames".
`LazyVStack` re-evaluates a row's `body` every time it comes back on screen. Parsing 900
lines of markdown per row on the main actor, per appearance, fails that scenario outright —
and it will fail it *silently*, as jank on the Commander's phone rather than as a red test.

`ChatSnapshotLoader` already does exactly the right thing for exactly this reason (see its
doc comment: "the reason it exists is scroll jank"). The parse goes there:

- `MessageGroup` gains `blocks: [MarkdownBlock]`, parsed once, off the main actor.
- The parse is keyed by message id and cached, so a `refresh()` triggered by one arriving
  message does not re-parse the other 499.
- The view renders a value type. It never calls the parser.

This connects US1 and US2 and belongs to neither task list today. It is a new bead.

---

## 4. Time, down the page

- **Day dividers.** A centred `sylLabelStyle()` rule — `TODAY · 10 AUGUST` — between
  hairlines, using the *identical* treatment as home's date label. This is the cheapest
  single thing that makes chat read as the same product.
- **Turn time**, once per group, in `Typeface.numeral` / `inkFaint`, **outside** the
  bubble (this is T015's existing instruction, and it is right).
- **No timestamp at all on a group less than five minutes after the previous one** —
  `MessageGrouping.maximumGap` already encodes that threshold; the view should honour the
  same number rather than inventing a second one.

---

## 5. Motion — what it means when a message arrives

The vocabulary exists (`Motion.responsive` / `settle` / `breathe`). The rules:

- **His own message uses `responsive` with zero delay.** His finger caused it; any
  choreography reads as lag.
- **Her message uses `settle`**, arriving as opacity + 8pt rise. No scale on her — she is
  light appearing, not a card landing.
- **The veil answers her.** While `presence == .thinking`, the veil's bloom lifts slightly
  and the light-rail travels downward. That is the home screen's own rule — *presence is
  expressed as light, not as existence* — applied to the transcript.
- **The typing indicator is not three grey dots.** It is the light-rail brightening and
  drifting. Three dots are a different app's furniture.
- **Reduce Motion**: motes absent, veil pinned, rail static, entrances become plain
  opacity. Everything still composes, because it was composed.

---

## 6. The composer as a designed object

Current state: a `Color(.secondarySystemBackground)` field and an `arrow.up.circle.fill`
in system blue on a `.bar`. Three separate problems.

- **The bar becomes glass.** `.ultraThinMaterial` with a top hairline, safe-area aware,
  so the veil shows through and the composer floats in the same weather as everything else.
- **The field is glass at low presence**, `radius: 18`, placeholder in `inkFaint`.
- **The send control is a mote that ignites**: a `luminanceCore` disc with a glow that
  exists *only* when there is something to send. Disabled is a hairline ring — present,
  obviously inert, no grey-blue mud.
- **It is 44pt.** The current button is a `.title2` glyph, roughly 28pt of tappable area,
  which is **below Apple's floor and below `Metric.minimumTouchTarget`, which this repo
  already defines.** That is a live accessibility defect, not a styling preference.

---

## 7. States the epic does not currently name

The interface is the product, and a state nobody designed is a state the Commander will
find on his own.

1. **Auto-scroll steals his position.** `ChatView` scrolls to the last group on *every*
   new group, unconditionally. Reading back through yesterday when a message lands yanks
   him to the bottom. Correct behaviour: auto-scroll only when already near the bottom;
   otherwise a **"Syl replied" pill** at the foot of the transcript that scrolls on tap.
   This is a defect today, independent of the restyle.
2. **Failed send.** T018 says "a retry". It needs a *look*: `warmth` hairline on his
   object, `Didn't send · Retry` in `sylLabelStyle`, retry as the tap target. `warmth` is
   the palette's one scarce warm note and this is exactly what it is for.
3. **Overflow.** Long unbroken URLs, wide code, wide tables — all scroll horizontally
   inside their own container; the page itself never scrolls sideways.
4. **VoiceOver.** A turn must be one element that announces its speaker
   (`"Syl said: …"` / `"You said: …"`), with the timestamp folded in rather than read as a
   stray number. Today the timestamp is its own element and nothing announces who spoke.
5. **AX5 Dynamic Type.** Verified against the code slab and the day divider specifically —
   the two places where a letterspaced or monospaced run clips first.

---

## 8. What this adds to the plan

Nothing here replaces T014–T019; it makes them decidable. New work, in dependency order:

| # | Work | Why it is new |
|---|---|---|
| D1 | **Decide §1** — unboxed page vs. glass bubbles | Blocks T015. Reversing it later is a rewrite |
| D2 | `Typeface.Prose` — the block scale in `SylTheme` | T005/T015 currently have no scale to render into |
| D3 | Parse in `ChatSnapshotLoader`, cache by message id | US2 scenario 4 cannot pass otherwise |
| D4 | Day dividers and turn-time rhythm | Named nowhere; cheapest same-product win |
| D5 | Entrance choreography + presence in the veil | "Beauty and magic" is mostly this |
| D6 | The composer: glass bar, igniting send, **44pt** | T016 says "restyle"; the touch target is a defect |
| D7 | Scroll-position defect + "Syl replied" pill | A real bug today |
| D8 | Failed-send state, and VoiceOver per turn | Missing states, one of them accessibility |

## 9. Rejected, with reasons

- **Starter-prompt chips in the empty state.** Useful for ten minutes on day one and dead
  weight for the following year. This is a daily tool for one person who knows what it is
  for. The empty state stays one serif line and one detail line.
- **An avatar beside every turn.** She is already the entire home screen and about to be
  the left margin of every message she sends. A 28pt repeated portrait is the fastest way
  to turn a character into wallpaper — the exact failure mode `HomeView` documents.
- **Bubble tails.** Nothing else in this app has a tail, a notch, or a pointer.
- **A separate light/dark chat palette.** `SylTheme` defines both appearances for every
  token. Chat uses the tokens.
