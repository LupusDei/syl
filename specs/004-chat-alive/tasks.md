# Tasks — Chat, Alive

**Feature**: 004-chat-alive · **Epic**: `syl-008`

`[P]` = parallelisable (different files, no dependency). `[USn]` = serves that user story.
Every task names exact paths. Tests come first — the constitution requires it, and the
ported parser arrives with zero coverage, so tests are how we learn what we inherited.

---

## Phase 1 — Foundation: the markdown engine (`syl-008.1`)

No UI change. Everything after this depends on it.

- **T001** [P] Port `MarkdownBlock` / `MarkdownInline` / `TableAlignment` from Adjutant's
  `ios/Adjutant/Sources/UI/Components/MarkdownParser.swift` into
  `ios/Syl/Features/Chat/Markdown/MarkdownBlock.swift`. Model only, no parsing. Add
  `Sendable` conformance — it must cross an actor boundary from the snapshot loader.

- **T002** Write the parser test suite *first*, in `ios/SylTests/MarkdownParserTests.swift`:
  every construct in the support matrix, plus the three known defects as characterisation
  tests — nested lists flatten (R1), blockquote content vanishes (R2), ordered lists
  renumber (R3). These start as assertions of *current* behaviour with a comment naming the
  bead, so the port is honest about what it is.

- **T003** Port the block scanner into `ios/Syl/Features/Chat/Markdown/MarkdownParser.swift`,
  keeping `parse(_:) -> [MarkdownBlock]` and **dropping `parseInline`** — inline is T005's
  job. Make it green against T002.

- **T004** Fix R2 and R3 in the port (blockquote content, ordered-list numbering) and
  promote their characterisation tests to correctness tests. R1 (nested lists) is a
  decision, not a fix — see T012.

- **T005** [P] `ios/Syl/Features/Chat/Markdown/MarkdownInline.swift`: render an inline run
  via `AttributedString(_:options:)` with `.inlineOnlyPreservingWhitespace`. Tests for
  bold, italic, code, strikethrough, links, and that a soft newline survives.

- **T006** [P] **Security.** `ios/Syl/Features/Chat/Markdown/LinkPolicy.swift` — an
  allowlist admitting only `https` and `mailto`. Everything else renders as inert text.
  Tests must include `javascript:`, `data:`, `file:`, `//evil.com`, a scheme with mixed
  case and leading whitespace, and a percent-encoded `javascript%3A`. **This is the one new
  security control in the epic**: the backend guards outbound fetches, nothing strips a
  hostile scheme out of `Message.text`, and it becomes live the moment links are tappable.

- **T007** Robustness tests: an unclosed fence, a 40,000-character message, a table with
  ragged columns, RTL text and emoji in a code span. Nothing may crash, hang, or lose the
  rest of the transcript.

---

## Phase 2 — US1: her words arrive as she wrote them (`syl-008.2`)

- **T008** `ios/Syl/Features/Chat/Markdown/MarkdownView.swift` — port the *structure* of
  Adjutant's `blockView` switch and `tableView`; write every style line against `SylTheme`.
  Headings, paragraphs, lists, blockquote, rule, table, task list.

- **T009** Fenced code blocks: monospaced, `SylTheme` surface, **horizontally scrollable**
  rather than wrapped, and the captured language shown as a label — Adjutant captures it
  and throws it away. Must not force the bubble wider than the screen.

- **T010** Move parsing into `ChatSnapshotLoader.load()` in
  `ios/Syl/Features/Chat/ChatSnapshot.swift`, per message and never per group. Add
  `blocks: [MarkdownBlock]` to the rendered message. Test that the main actor only ever
  receives finished blocks.

- **T011** Replace `Text(message.text)` in `MessageGroupView` with `MarkdownView`. This is
  the one line that makes US1 true.

- **T012** **Decision point (R1).** Measure how often nested lists appear in real replies,
  then either add indentation tracking to the parser or record flattening as accepted for
  v1. Either way the answer is written into the bead, not left implicit.

- **T013** Accessibility: a message is one VoiceOver element reading in visual order; code
  blocks stay legible at the largest accessibility size; links are individually reachable.

---

## Phase 3 — US2: chat belongs to the same world (`syl-008.3`)

- **T014** [P] Put `SylTheme.Veil()` and `MoteField` behind the transcript in
  `ios/Syl/Features/Chat/ChatView.swift`, honouring Reduce Motion exactly as the home
  screen does.

- **T015** [P] Restyle bubbles: `sylGlass()` for hers, a quieter treatment for his, and
  **the timestamp moved outside the bubble** — Adjutant's one clearly better layout idea,
  because it stops the time competing with the words.

- **T016** [P] Restyle the composer against `SylTheme` — glass field, no
  `Color(.secondarySystemBackground)`, no `.accentColor` anywhere in the file.

- **T017** [P] Restyle `ConnectionBanner` and `EmptyConversation`. Keep both: an assistant
  that silently fails to sync is worse than one that says so.

- **T018** Add a copy affordance (`.contextMenu` → copy raw markdown, not rendered text)
  and a retry on a failed send. Both are missing today.

- **T019** Screenshot chat beside home and confirm they read as one product. Attach the
  images to the bead — the render harness at
  `ios/SylTests/HomeSnapshotRendering.swift` is the precedent.

---

## Phase 4 — US3: she is present in the conversation (`syl-008.4`)

**Blocked on `syl-8l7`** — presence is derived and announceable and nothing joins the two.

- **T020** Fix `ChatViewModel.presence`: it stores the raw frame state and never decays, so
  a dropped socket leaves her asserting `thinking` forever — the exact failure
  `PresenceTimeline` exists to prevent. Use the decayed timeline, as `HomeViewModel`
  already does.

- **T021** Render `SylRibbon` in the transcript while a turn is in flight, and nowhere else.
  Motion must be earned here as much as on the home screen.

- **T022** Reduce Motion path: convey thinking without a moving ribbon.

---

## Phase 5 — US4a: the contract and the backend (`syl-008.5`)

Invisible, and not skippable.

- **T023** `shared/openapi.yaml`: `Message` gains `attachments: Attachment[]`, with
  `Attachment { id, kind: image|video, mimeType, bytes, width, height, durationMs?, sha256 }`.
  Regenerate `shared/src/types.ts`. Add fixtures — captured shapes, never hand-written from
  our own types.

- **T024** `backend/migrations/00NN_attachments.sql` — the table, plus the join to messages.

- **T025** `backend/src/services/attachment-store.ts`, mined from Adjutant's
  `upload-storage.ts`: filesystem blob store, size ceiling, MIME allowlist, **magic-byte
  sniffing cross-checked against the declared type**, extension restricted through a MIME
  map, and path-traversal guards. Ports its four error codes.

- **T026** `backend/src/routes/attachments.ts` — `POST /api/v1/attachments` and
  `GET /api/v1/attachments/:id`, both authenticated. Minimum two tests per route: success,
  and a structured error with the right status.

- **T027** Thumbnails (R4). Adjutant has none and pays 4 MB for a 160×160 view. Either
  generate a thumbnail on upload and serve it as a variant, or record the decision to defer
  with the cellular cost stated out loud.

- **T028** Anti-divergence: every new contract operation must be routed in both directions —
  the same guard `syl-c1m.3` exists for.

---

## Phase 6 — US4b: images and video in the conversation (`syl-008.6`)

- **T029** Regenerate `SylKit`'s `Message` with attachments; update
  `ios/SylKit/Tests/ContractTests` fixtures.

- **T030** `ios/Syl/Features/Chat/AttachmentLoader.swift`, mined from Adjutant's
  `AttachmentImageLoader`: authenticated fetch (`AsyncImage` cannot carry a `Bearer`
  header), four-state machine, process-wide `NSCache` with a cost limit, and
  `prime(attachmentId:data:)` so an optimistic send renders with no round trip.

- **T031** **Security.** Refuse any attachment URL whose origin is not the paired server —
  the rule the admin WebView already follows. Tests must include a lookalike host
  (`reason-2.tail714e0e.ts.net.evil.com`), because a naive prefix match passes that and it
  is what someone writes first.

- **T032** `ios/Syl/Features/Chat/AttachmentView.swift`: inline thumbnail at the correct
  aspect ratio with **no layout jump on load** — the dimensions come from the contract for
  exactly this reason.

- **T033** Full-screen viewer: pinch-zoom, swipe to dismiss, share sheet.

- **T034** Video: poster frame, **play only on explicit tap**, never autoplay, and never
  taking the audio session. The home screen's rule, unchanged.

- **T035** Offline: cached attachments render with the tailnet down; un-cached ones show an
  honest placeholder rather than a spinner forever. Stale is a state, not a lie.

- **T036** Disk-first send path for staged attachments in `ChatViewModel.send()`, per D7.
  A crash mid-upload must lose neither the bubble nor the intent.

---

## Phase 7 — Polish: the transcript at scale (`syl-008.7`)

- **T037** Add `.defaultScrollAnchor(.bottom)`. Syl relies solely on
  `onChange → proxy.scrollTo`, which is exactly the pattern Adjutant's `adj-150` records as
  intermittently failing on first render with long transcripts.

- **T038** An `isAtBottom` gate so a new message does not yank the view out from under
  someone reading history. Syl auto-scrolls unconditionally today.

- **T039** Pagination. `ChatSnapshotLoader` is hard-capped at `limit: 200` with no way to
  reach anything older. Load-earlier on scroll-into-view, with a manual fallback.

- **T040** Performance: 500-message transcript, parsed blocks cached per message id, no
  dropped frames. Assert parsing does not re-run on every body evaluation.

---

## Deferred, and why

- **Sending images from the phone** (US5) — every image sent is untrusted content entering
  the system, so proposal D's Reader quarantine applies. A sub-project; must not gate the
  above.
- **Streaming replies** — a transport change, and streaming *into* a markdown renderer is
  materially harder than into a text view (R5). Own epic, after the rendered shape settles.
- **Arbitrary remote images** — read-receipt and IP leak plus an SSRF surface. Syl's origin
  only.
- **Syntax highlighting** in code blocks — the language is captured; colouring it is a
  library or a hand-rolled lexer, and neither earns its place yet.
