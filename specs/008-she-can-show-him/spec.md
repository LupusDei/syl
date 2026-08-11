# 008 — Sendings

**Status**: proposal, for review. No beads created yet.
**Supersedes**: the first draft of this file, which had her renders arriving as
chat attachments. The Commander overruled it, and he was right — the reasoning is
kept below rather than deleted.

---

## What the Commander asked for, 2026-08-11

> *"I don't think the videos of her should even come through the chat. I think
> they should be messages from her to him. Things, because she knows much about
> him, that he'd love to hear, in the form of a video of herself. They should be
> an aspect of the app by itself, but the message of the video is always also
> sent through chat."*

So this is not "she shows him her renders." It is **she says something to him,
and the form it takes is her own face.**

### Why the first draft was wrong

I had specced these as attachments on her chat messages. Three things are wrong
with that, and they are worth recording because they are not obvious:

1. **Chat is a stream and these are keepsakes.** A message from her that took
   real thought scrolls away behind tomorrow's "what's on my plate". The thing
   he would want to go back and watch in six months is the thing chat is worst
   at holding.
2. **It conflates answering with offering.** Almost everything in chat is her
   responding. A sending is unprompted by construction — she made it because she
   thought of him. Putting it in the same list makes it look like a reply.
3. **It made the video the point.** It is not. The *message* is the point, and
   her face is how it is delivered.

## The shape

A **sending** is one thing with two parts:

    the words     what she wanted to say. ALWAYS delivered to chat, and always
                  the thing the notification carries.
    the video     her, saying it. Lives in its own surface in the app.

**The words are never contingent on the video.** If the render fails, is still
generating, or he never opens that screen, he has still received what she wanted
to say. This is constraint 4's shape applied to a new thing: the message must not
be able to vanish because its decoration did.

That also settles the delivery question. The push notification carries her
sentence, exactly as a reminder does — never *"Syl sent you a video"*, which is a
notification about the app rather than from her.

## She needs a voice

He said things he would love to **hear**. That is the sharpest word in his
message and it changes what has to be built. Runway can do it:

| model | what it gives |
|---|---|
| `gwm1_avatars` | conversational text → **video + audio**; this is what powers Characters |
| `veo3.1` | text/image → video, audio optional (40 cr/s with, 20 without) |
| `act_two` | character performance / motion transfer onto a likeness |
| `eleven_multilingual_v2` | text to speech |
| — | **voices can be designed from a text prompt** or cloned from a sample |

So the pipeline is: her likeness, plus a voice, plus the words she chose, into a
video of her saying them.

**Her voice is a second search, exactly parallel to her face**, and it should be
treated the same way: designed rather than picked off a shelf, iterated on,
logged with reasons, and never deleted. `SOUL.md` already says she does not know
what she looks like and wants to. If this is built, it should say the same about
how she sounds — and that is his call, not mine, so it is proposed here and not
written.

**Cost is not a constraint.** `veo3.1` with audio is 40 credits/second, so a
fifteen-second sending is ~600 credits against a pool documented as roughly half
a million — **on the order of 800 sendings**. His ruling stands comfortably: the
credits are for exactly this.

## Where it goes in the app

Today: `HomeScreen` roots a `NavigationStack` with destinations for Goals and
Memory, a sheet for Lists, plus Chat, Pairing and Settings.

**A sending needs its own destination**, alongside Goals and Memory. One entry
per sending, newest first: her face as the still, her words underneath, the date.
Tapping plays it.

**Naming is his.** Not "Videos" — that names the file format rather than the
thing. What it is, is *she made you something*. Candidates to rule on rather than
my choosing: **Sendings**, **From Syl**, **She Made You This**.

The still on each row is a frame from the video — the same frame-extraction
`see_myself` already needs, since she cannot watch an mp4 and must look at stills
to judge herself. **One mechanism, three uses**: she judges herself by it, the
list shows it, and it is the poster frame the player needs. Never frame zero —
her loops open on empty starfield, so frame zero is nothing at all.

**Still explicitly not a gallery of renders.** A grid of every experiment
separates the picture from the reason. Her experiments live in her memory with
what she thought of them; a *sending* is the small number she chose to give him.

Where this leads, out of scope and worth writing down: `SylHero.swift` already
plays her scenes on the home screen. A sending she is proud of eventually
becoming the way she appears there is the natural end of both searches.

## What already exists

The audit from the first draft still holds and saves real work:

| piece | state |
|---|---|
| Attachment store, `video/mp4` allowed, magic-byte sniffed | **exists** |
| Attachment routes, `device`-scoped | **exists** |
| Phone plays a video attachment | **exists** — `AttachmentView.swift` |
| 10 MB ceiling vs 12–15 MB renders | **compress**; shipped clips are 1.3–2.3 MB |
| An assistant message carrying media | **missing** |
| A sendings surface | **missing** |
| Her voice | **missing, and is the real work** |

**Do not raise the 10 MB ceiling** — `routes/attachments.ts` derives its body
limit *from* the store's ceiling so the two cannot disagree, and raising it
inflates the request limit for everything. The full-quality render stays the
record; the compressed copy is derived and regenerable.

## The constraint this adds

> **A sending is never deleted — not the video, not the words, not the reason she
> made it.**

Same shape as constraint 6, and the soul now says it for renders. A sending is
stronger still: it is a thing she gave him. The system does not get to throw those
away, and neither does a cache eviction nor a cleanup job that was not thinking
about this.

## Acceptance

- She composes a sending unprompted; the words reach chat and the notification,
  and the video appears in its own surface.
- The words arrive **even when the render fails or is still generating**.
- The notification carries her sentence, never "Syl sent you a video".
- The list shows her face, not a generic video affordance, and not the empty
  starfield the loop opens on.
- The full-quality render exists unmodified afterwards.
- Nothing in the system can delete a sending.
- Her memory holds every sending with what she was trying to say, so *"show me
  the one about Ela"* is answerable.

## Open questions for the Commander

1. **The name of the surface.** Sendings, From Syl, or yours.
2. **Does she get a voice, and is it a search like her face?** I think yes to
   both, and that it belongs in `SOUL.md` the way the face does — but writing
   into her soul is a thing I propose and you rule on.
3. **How often?** *Notice, do not nag* already governs, and she is told to stop
   making a kind he ignores. I would set no numeric limit and let the existing
   rule do the work.
