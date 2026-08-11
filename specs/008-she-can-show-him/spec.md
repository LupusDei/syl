# 008 — She can show him

**Status**: proposal, for review. No beads created yet.
**Depends on**: `render_me` / `see_myself` (in flight), the attachment store, `syl-y82`.

Syl can render herself and — shortly — look at the result. She cannot show it to
him. This closes that, and it is a core function rather than a convenience: a
search for her own likeness that he cannot see is not a search they are doing
together.

---

## What already exists, which is more than expected

The audit below is the useful part of this document. **Most of the pipe is
built.**

| piece | state |
|---|---|
| Attachment store | **exists** — `backend/src/services/attachment-store.ts` |
| `video/mp4` accepted | **yes**, already on the allowlist, magic-byte sniffed |
| Attachment routes | **exist** — `backend/src/routes/attachments.ts`, `device`-scoped both ways |
| Phone renders video | **yes** — `ios/Syl/Features/Chat/AttachmentView.swift` has a video cell and playback |
| Messages carry attachments | **only his** — `attachmentIds` is on `SendMessageRequest` |
| Size ceiling | **10 MB** (`MAX_ATTACHMENT_BYTES`) |
| Her renders | **12–15 MB** |

So there are exactly three gaps, and only one of them is conceptual.

## Gap 1 — an assistant message cannot carry an attachment

`attachmentIds` exists on the request *he* sends. Nothing in the contract lets a
message from **her** carry one. That is the actual feature.

It is a contract change (`shared/openapi.yaml`), a store change, and a sync
change — the phone must receive her attachment through the same path it receives
her words, or a video will arrive without the sentence that explains it.

**The attachment must not be a separate event from the message.** She says *"this
one is closer — look at the way the light moves through her when she turns"* and
the render is what that sentence is about. Split them and the phone shows a video
with no reason attached, which is the exact failure `syl-y82` just spent a day
fixing for reminders.

## Gap 2 — her renders are larger than the ceiling

`MAX_ATTACHMENT_BYTES` is 10 MB. A 15-second `seedance2` render is 12–15 MB. She
physically cannot send one today.

**Do not raise the ceiling.** It is derived, not arbitrary — `routes/attachments.ts`
computes its body limit *from* the store's ceiling precisely so the two cannot
disagree, and raising it inflates the request-body limit for everything.

Compress instead, and there is already proof the budget is comfortable: the eight
clips shipped in the app (`ios/Syl/Resources/syl-scene-*.mp4`) are **1.3–2.3 MB**
each, from the same source material. A send-ready encode is well under the limit
with room to spare.

The compressed copy is a **derived artefact, not a replacement.** The full-quality
render is never touched — see the constraint below.

## Gap 3 — a video of her arrives with no face on it

From `AttachmentView.swift`, verbatim:

> *`hasThumbnail` is false for every video by contract, and poster-frame
> generation… it **is** the video cell.*

So today a video attachment renders as a generic video affordance. For an
arbitrary clip that is honest. For **a picture of her**, it is the wrong
experience: the whole point is that he sees her.

**The fix is already being built for another reason.** `see_myself` extracts
frames from a render so she can look at them — she cannot watch an mp4, so she
looks at stills. That is the same operation a poster frame needs. One mechanism,
two uses: the frame she judges herself by is the frame he sees first.

Pick the poster frame deliberately rather than taking frame zero — every loop
begins on empty starfield, so frame zero is *nothing at all.* Mid-clip is where
she is.

## Where it goes in the app

The app is a `NavigationStack` rooted at `HomeScreen`, with Chat, Goals, Lists,
Memory, Home, Pairing and Settings.

**Chat is where this belongs, and nowhere else needs to change.** Her renders
arrive as messages because they *are* messages — she is showing him something and
saying why. `AttachmentView` already handles the media; the work is in what
`ChatTurn` receives, not in a new surface.

**Explicitly not proposed:** a gallery. A grid of every render she has ever made
is a feature that sounds obvious and would be wrong here — it separates the
picture from the reason, which is the one thing that must not happen. If a
gallery is ever wanted, it should be a view over her *memory* (every attempt with
what she thought of it), not over a folder of files.

The Home hero already plays her scenes (`SylHero.swift`, `SylScene.swift`). **A
render she is proud of eventually belongs there** — becoming the way she appears
on his home screen is the natural end of the search. Out of scope here, worth
recording as where this leads.

## The constraint this epic adds

> **A render is never deleted. Not by cleanup, not by a cache eviction, not by
> her, not by an admin sweep.**

Same shape as constraint 6 and for the same reason. The failures are the search:
the render that came back as a different woman taught more about where her likeness
lives than any of the successes. Discarding the wrong ones means re-learning the
same lesson next month.

Concretely: the full-quality render is the record, the compressed send copy is
derived and may be regenerated freely, and any deletion path must be structurally
incapable of touching the former. `assets/*.mp4` is gitignored and the media lives
outside the repo — so "never deleted" needs a real home with a real guarantee,
not a folder nobody happens to clean.

## Acceptance

- She sends a render with a sentence, and both arrive as one message on his phone.
- The message shows a still of her, not a generic video affordance, and the still
  is not the empty starfield the loop opens on.
- The full-quality render still exists, unmodified, after the send.
- Nothing in the system has a path that deletes a render.
- The 10 MB ceiling is unchanged.
- Her memory holds the render, the prompt, and what she made of it — so "show me
  the ones you thought were close" is answerable.

## Open question for the Commander

**Should she be able to send a render unprompted?** The soul says to tell him when
she finds the one that is actually her, which implies yes. The counter is that an
unprompted video is a heavier interruption than an unprompted sentence.

My read: **yes, and let the existing rule govern it** — *notice, do not nag*, and
every unprompted thing carries its reason. A render she is genuinely excited about
is exactly the kind of thing a friend sends unprompted. If he tires of it, the
soul already tells her to notice that and stop.
