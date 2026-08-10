# Syl — Chat, Alive

**Feature**: 004-chat-alive
**Epic**: `syl-008`
**Status**: Draft
**Priority**: P1
**Depends on**: `syl-470` (the design system and home screen), `syl-8l7` (presence wiring, for US3)

## Summary

The home screen became a place. Chat did not.

Today a message from Syl renders as `Text(message.text)` in a rounded rectangle — no
markdown, no images, stock system blue, stock system grey. She can write a numbered plan
and it arrives as a wall of asterisks. She can produce a research brief and it arrives as
one paragraph. She cannot show the Commander anything at all.

This epic makes the conversation worth having: her words rendered as she wrote them, in
a surface that belongs to the same world as the rest of the app, carrying pictures and
video when a picture is the answer.

## Why this is worth an epic rather than a styling pass

Three of the four parts are not styling.

**Markdown is a parsing problem with a security edge.** Rendering arbitrary text as rich
content is exactly where injection lives. The subset is a decision, not a default.

**Attachments are a contract change.** `Message` in `shared/src/types.ts` carries
`id, conversationId, clientId, role, text, createdAt, seq` and nothing else. Images and
video mean new fields, new fixtures, a store, a route, and a caching story on the device —
across four layers, not one.

**Streaming is a transport change.** A turn currently arrives as a finished message. A
chat that shows her thinking as she thinks is a different protocol and a different feel.

Only the visual work is a styling pass, and it is the smallest part.

## The acceptance criterion

> **The Commander asks Syl for something structured — a plan, a brief, a comparison —
> and what arrives is legible at a glance, beautiful enough to read on purpose, and
> unmistakably part of the same app as the home screen.**

If her answer still reads as a wall of text with asterisks in it, this epic is not done
regardless of how many beads are closed.

## User Scenarios & Testing

### User Story 1 — Her words arrive as she wrote them (Priority: P1)

**As** the Commander, **I want** Syl's replies rendered properly, **so that** a plan reads
as a plan and code reads as code.

**Why this priority**: It is the largest gap between what she produces and what he sees,
it is pure iOS with no contract change, and it ships in one build.

**Independent Test**: Send a message containing every supported construct; every one
renders correctly, and unsupported syntax degrades to readable plain text rather than
showing raw markers.

**Acceptance Scenarios**:

1. **Given** a reply with a numbered list, **When** it renders, **Then** the numbers are
   real list formatting, not literal `1.` at the start of a paragraph.
2. **Given** a reply with a fenced code block, **When** it renders, **Then** it is
   monospaced, horizontally scrollable, and does not force the bubble wider than the
   screen.
3. **Given** a reply containing `<script>` or raw HTML, **When** it renders, **Then** the
   HTML is shown as text or dropped — never interpreted.
4. **Given** a link with a `javascript:` or `data:` scheme, **When** it renders, **Then**
   it is not tappable.
5. **Given** the largest accessibility text size, **When** a code block renders, **Then**
   it remains readable and nothing is clipped.

---

### User Story 2 — Chat belongs to the same world (Priority: P1)

**As** the Commander, **I want** the conversation to feel like the rest of the app,
**so that** opening chat is not like leaving it.

**Why this priority**: Same build as US1, no contract change, and it is the half the
Commander asked for first — "more beauty and magic like the home page".

**Independent Test**: Screenshot chat beside the home screen; they read as one product.
No stock system blue anywhere.

**Acceptance Scenarios**:

1. **Given** the chat screen, **When** it opens, **Then** the veil and motes are present
   and the palette is `SylTheme`, with no `.accentColor` or `Color(.secondarySystemBackground)`.
2. **Given** a message from Syl, **When** it renders, **Then** it uses the glass treatment
   rather than a flat filled rectangle.
3. **Given** Reduce Motion, **When** chat opens, **Then** the motes are absent and nothing
   drifts.
4. **Given** a transcript of 500 messages, **When** the Commander scrolls, **Then** it does
   not drop frames.

---

### User Story 3 — She is present in the conversation (Priority: P2)

**As** the Commander, **I want** to see that Syl is thinking rather than that the app has
frozen, **so that** waiting feels like waiting for someone.

**Why this priority**: High value, low cost — but it is gated on `syl-8l7`, because
presence is derived and announceable and nothing currently joins the two.

**Independent Test**: With presence wired, send a message; the ribbon appears in the
`thinking` state and settles when the reply lands.

**Acceptance Scenarios**:

1. **Given** a turn in flight, **When** the Commander is on chat, **Then** `SylRibbon`
   renders `thinking` and the composer shows the turn is running.
2. **Given** the socket drops mid-turn, **When** the TTL lapses, **Then** presence decays
   to `idle` then `absent` rather than freezing mid-thought.
3. **Given** Reduce Motion, **When** she is thinking, **Then** the state is conveyed
   without a moving ribbon.

---

### User Story 4 — A picture when a picture is the answer (Priority: P2)

**As** the Commander, **I want** Syl to show me images and video in the conversation,
**so that** a chart, a diagram or a clip does not have to become a paragraph.

**Why this priority**: The largest capability gain and the largest cost — a contract
change across four layers plus a store. Deliberately after the two phases that ship on
their own.

**Independent Test**: A message carrying an attachment renders a thumbnail, opens
full-screen on tap, and still renders from disk with the tailnet down.

**Acceptance Scenarios**:

1. **Given** a message with an image attachment, **When** it renders, **Then** a thumbnail
   appears inline at the correct aspect ratio with no layout jump when it loads.
2. **Given** a thumbnail, **When** tapped, **Then** it opens full-screen with pinch-zoom
   and can be dismissed by swipe.
3. **Given** the tailnet is down, **When** chat opens, **Then** previously seen attachments
   still render from the local cache and un-cached ones show an honest placeholder rather
   than a spinner forever.
4. **Given** an attachment URL that is not Syl's own origin, **When** the app is asked to
   load it, **Then** it is refused.
5. **Given** a video attachment, **When** it renders, **Then** it shows a poster frame and
   plays only on explicit tap — never autoplay, never with sound that interrupts.

---

### User Story 5 — Sending him to her (Priority: P3, deferred pending a decision)

**As** the Commander, **I want** to send Syl a photo or a screenshot, **so that** I can
show her something instead of describing it.

**Why this priority**: Every image sent is untrusted content entering the system, so
proposal D's Reader quarantine applies to it. That is a sub-project, and it should not
gate the four phases above.

**Independent Test**: Deferred. Not built until the quarantine question is answered.

---

### Edge Cases

- A message that is 40,000 characters of markdown — does parsing block the main actor?
- A code block 400 characters wide — does it scroll, wrap, or push the bubble off-screen?
- A malformed fence that is never closed — does the rest of the transcript survive?
- An attachment whose declared type disagrees with its bytes.
- An attachment that is 80 MB — is there a ceiling, and is it enforced before download?
- A message with an attachment that has been deleted server-side.
- Right-to-left text and emoji inside a code span.
- The same attachment referenced by twenty messages — is it cached once or twenty times?

## Requirements

### Functional

- **FR1** Render a defined markdown subset; unsupported syntax degrades to plain text.
- **FR2** Never interpret HTML; never make non-`https`/`mailto` schemes tappable.
- **FR3** Parse off the main actor and cache the parsed result per message id.
- **FR4** Apply `SylTheme` throughout chat; no stock system colours remain.
- **FR5** Show Syl's presence in the conversation when it is known.
- **FR6** Carry image and video attachments on a message, end to end.
- **FR7** Serve attachments from Syl's own origin only; refuse every other host.
- **FR8** Cache attachments on the device and render them offline.
- **FR9** Video never autoplays and never takes the audio session.

### Non-functional

- **NFR1** A 500-message transcript scrolls without dropped frames.
- **NFR2** Chat opens from disk with no spinner, as it does today.
- **NFR3** Dynamic Type through the largest accessibility size; VoiceOver reads a message
  as one coherent element; 44 pt minimum targets.
- **NFR4** Reduce Motion removes ambient motion in chat exactly as on the home screen.
- **NFR5** No new third-party dependency in `SylKit`, which is dependency-free by rule.

## Success Criteria

- The Commander stops asking Syl to "just give it to me plainly".
- A structured answer is readable at a glance without pinching or scrolling sideways.
- Chat and home screenshot as one product.
- An attachment seen once is still there on a plane.

## Out of Scope, and why

- **Sending images from the phone** — US5, gated on the quarantine decision.
- **Streaming replies token by token** — a transport change; own epic once the shape of
  the rendered message is settled, because streaming *into* a markdown renderer is a
  harder problem than streaming into a text view.
- **Arbitrary remote images** — a read-receipt and IP leak, and an SSRF surface. Only
  Syl's own origin.
- **Message editing, reactions, threads** — a single-user assistant, not a chat product.
- **Rich text composition** — he types plain text; she writes markdown.
