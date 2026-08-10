# Implementation Plan — Chat, Alive

**Feature**: 004-chat-alive
**Epic**: `syl-008`
**Spec**: [spec.md](./spec.md)

## What the survey changed

Four findings moved this plan off where it started. Each is load-bearing.

**1. Adjutant's markdown parser is copyable; its renderer is not.**
`MarkdownParser.swift` is 543 lines of pure `Foundation` with no Adjutant type in it —
copy it verbatim. `MarkdownTextView.swift` is bound to Adjutant's CRT theme at twelve
points; the *shape* transfers, the skin is rewritten. Budget it as "port the structure,
rewrite the styling", not as a copy.

**2. That parser has zero tests.** 910 lines of hand-rolled parsing, no coverage, only
`#Preview` blocks. Under the constitution it cannot be adopted as-is. The tests are not
optional overhead here — they are how we find out what we inherited.

**3. `AttributedString(markdown:)` buys inline and nothing else.** It parses `**bold**`,
`` `code` ``, links — and it makes links *tappable*, which is Adjutant's renderer's worst
defect. But at block level it only records `presentationIntent` attributes, and SwiftUI
`Text` ignores them entirely. There is no path where it renders headings, lists or code
blocks for you.

So: **hybrid.** Adjutant's block scanner for blocks, `AttributedString` for inline. That
deletes the ~110 lines of hand-rolled delimiter scanning — the fiddliest, least-tested
code in the file — and fixes tappable links for free.

**4. The backend's SSRF guard already exists and is thorough.** `safeFetch` and
`classifyAddress` cover scheme, DNS rebinding, per-hop redirect re-checks, literal-IP
hosts, and `100.64.0.0/10` because the tailnet lives in CGNAT space. Nothing to build.

But it guards *outbound fetches*, and **the control this epic actually introduces is
client-side**: `Message.text` is an unfiltered `String`, and the moment links become
tappable, a `[click](javascript:…)` is a live hole. Nothing in the backend strips it. That
allowlist is new, unbuilt, and belongs in Swift at render time.

## Architecture decisions

### D1 — The renderer lives in the app target, not SylKit

`SylKit/Package.swift` states the zero-dependency rule as structural. Markdown rendering
is presentation, needs SwiftUI, and would force exactly the dependency conversation that
manifest exists to prevent. It goes in `ios/Syl/Features/Chat/Markdown/`, alongside the
design system it styles against.

### D2 — Parse off the main actor, in the snapshot loader

**The single most important call in the epic.** Adjutant parses in `MarkdownTextView.init`
— on the main thread, on every body re-evaluation. Doing that here would undo the exact
jank fix `ChatSnapshotLoader` exists for.

Parsing happens inside `ChatSnapshotLoader.load()`, on the detached task that already
reads from disk, and the view receives finished `[MarkdownBlock]`.

**Parse per message, never per group.** `MessageGroup.text` joins with `"\n\n"`; parsing
the join would merge blocks across message boundaries and let an unclosed fence in one
message swallow the next.

### D3 — No new dependency

`apple/swift-markdown` is mechanically allowed (the rule binds SylKit, and the app target
already links GRDB) and still declined: it drags `swift-cmark`, a C target, into the iOS
build, and it is a *parser* — every line of the SwiftUI renderer still has to be written.
It replaces the 543-line file we can have for free, not the 367-line one we must write.

Revisit only for nested lists, which is the one construct Adjutant's parser genuinely
cannot do — and which Claude emits routinely. See R1.

### D4 — Attachments start in the contract, not in Swift

`shared/` is THE CONTRACT. `Message` has no media field, and nothing in `backend/src`
serves user content — `index.ts` says so outright: *"Syl exchanges text, not uploads."*
So the order is OpenAPI → generated types → fixtures → backend store and route → SylKit →
UI. Starting in Swift would produce a client for an endpoint that does not exist.

Adjutant's `upload-storage.ts` is the model and is worth mining closely: it sniffs magic
bytes server-side rather than trusting `Content-Type`, cross-checks the two, restricts
extensions through a MIME map, and has path-traversal guards.

### D5 — Attachments are served from Syl's own origin, only

No arbitrary remote images. A remote image in a transcript leaks a read receipt and the
Commander's IP to whoever hosts it, and fetching arbitrary URLs from the phone is the SSRF
surface `address-guard.ts` exists to close. The client refuses any attachment URL whose
origin is not the paired server — the same rule the admin WebView already follows.

### D6 — Authenticated image loading needs its own loader

`AsyncImage(url:)` cannot attach a `Bearer` header, so an authenticated image 401s.
Adjutant solved this with `AttachmentImageLoader`: a four-state machine behind a
process-wide `NSCache` with a 48 MB cost limit, plus `prime(attachmentId:data:)` to seed
just-sent bytes so an optimistic send renders with no round trip. Mine it nearly verbatim.

### D7 — Disk first, for attachments too

`ChatViewModel.send()` states the rule: *"The order matters and is not negotiable: disk
first."* An attachment send writes the local row with local bytes **before** it uploads, or
a crash mid-upload loses both the bubble and the intent.

## Phases

Each phase leaves the app shippable.

| Phase | Sub-epic | What becomes true | Ships alone |
|---|---|---|---|
| 1 | `syl-008.1` | A tested markdown engine exists, with a scheme allowlist | no UI change |
| 2 | `syl-008.2` | Her replies render as written | **yes** |
| 3 | `syl-008.3` | Chat belongs to the same world as home | **yes** |
| 4 | `syl-008.4` | She is visibly present while thinking | yes (gated on `syl-8l7`) |
| 5 | `syl-008.5` | The contract and backend carry attachments | no UI change, but **not alone** — see below |
| 6 | `syl-008.6` | Images and video appear in the conversation | **yes** |
| 7 | `syl-008.7` | The transcript survives scale | yes |

Phases 2 and 3 are the Commander's ask and land together in one build. Phase 5 is
invisible and must not be skipped to reach 6 sooner.

### Parallel opportunities

- **1 ∥ 3** — the engine and the restyle touch different files.
- **5 ∥ 2,3,4** — contract and backend work is TypeScript; the rest is Swift.
- Within 1, the parser port and the scheme allowlist are independent.
- **6 depends on 5**, hard. Do not start the picker before the route exists.

## Key files

**New**
```
ios/Syl/Features/Chat/Markdown/MarkdownBlock.swift      the model (ported)
ios/Syl/Features/Chat/Markdown/MarkdownParser.swift     block scanner (ported, tested)
ios/Syl/Features/Chat/Markdown/MarkdownInline.swift     AttributedString bridge (new)
ios/Syl/Features/Chat/Markdown/LinkPolicy.swift         scheme allowlist (new, security)
ios/Syl/Features/Chat/Markdown/MarkdownView.swift       SwiftUI renderer (shape ported)
ios/Syl/Features/Chat/AttachmentLoader.swift            authenticated + cached (mined)
ios/Syl/Features/Chat/AttachmentView.swift              thumbnail, viewer, video poster
backend/src/services/attachment-store.ts                blob store (mined from Adjutant)
backend/src/routes/attachments.ts                       POST + GET
backend/migrations/00NN_attachments.sql                 the table
```

**Changed**
```
shared/openapi.yaml + shared/src/types.ts               Message gains attachments
ios/SylKit/Sources/SylKit/Model/Conversation.swift      regenerated Message
ios/Syl/Features/Chat/ChatSnapshot.swift                parse during load
ios/Syl/Features/Chat/ChatView.swift                    restyle; scroll anchor; attach button
ios/Syl/Features/Chat/ChatViewModel.swift               staged attachments in send()
```

**Deliberately unchanged**
```
ios/Syl/Features/Chat/MessageGrouping.swift             already better than Adjutant's, fully tested
backend/src/connections/{fetch,address-guard}.ts        the SSRF guard is done
```

## Risks

**R1 — Nested lists.** Adjutant's parser trims leading whitespace before matching, so a
nested item becomes a sibling. Claude emits nested lists constantly. Mitigation: a test
asserting current behaviour, and a decision point in Phase 2 — either fix indentation
tracking in the ported parser (~a day) or accept flattening for v1. **Do not discover this
after shipping.**

**R2 — Blockquote content silently vanishes.** Adjutant's `blockquoteContent` returns
`EmptyView()` for lists, code and tables inside a quote. That is data loss, not a
limitation. Fix during the port or render the raw text.

**R3 — Ordered lists renumber.** It renders the loop index, so a list starting at `3.`
becomes `1.`. Trivial fix; caught only by a test.

**R4 — Thumbnails.** Adjutant has none — it downloads the full image and renders it at
160×160, so a 4 MB screenshot costs 4 MB for a thumbnail. Over a tailnet on cellular that
is the difference between instant and not. Server-side thumbnail generation is new work in
Phase 5, and skipping it is a decision to be made out loud.

**R5 — Streaming into a markdown renderer** is materially harder than streaming into a
text view: a partial fence is a malformed document on every keystroke. Explicitly out of
scope; the parser must at least not crash on unclosed constructs (Phase 1 test).

## Bead Map

48 beads: 1 root, 7 sub-epics, 40 tasks. Full table and dependency wiring in
[beads-import.md](./beads-import.md).

- `syl-008` — Chat, alive
  - `syl-008.1` — Foundation: the markdown engine and the link allowlist (7 tasks)
  - `syl-008.2` — US1: her words as she wrote them (6) · *depends on .1*
  - `syl-008.3` — US2: chat belongs to the same world (6) · *parallel from day one*
  - `syl-008.4` — US3: she is present (3) · *.2 gated on `syl-8l7`*
  - `syl-008.5` — US4a: contract and backend (6)
  - `syl-008.6` — US4b: images and video (8) · *depends on .5*
  - `syl-008.7` — Polish: the transcript at scale (4)

**Start here.** Two P0s are unblocked now and are the highest-value first moves:
`syl-008.1.6` (the link scheme allowlist — the one new security control) and
`syl-008.4.1` (chat presence never decays, a real defect today). Phase 3 needs no engine,
so the restyle can run in parallel with the parser work immediately.
