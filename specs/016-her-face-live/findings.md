# Phase 1 findings — measured, not estimated

Numbers from the three cheap spikes against the three unproven risks. Each entry
says what was run, on what, and what it means for the epic.

## T001 — TTS synthesis latency, her actual voice

**Question.** `time-to-first-sound = time-to-her-first-text + TTS synthesis.`
The first half was measured (`scripts/experiments/first-token-latency.mjs` at
`28746b5`): **~1635ms warm, ~7450ms cold**. The second half had never been
measured for the voice she actually uses.

**Method.** `scripts/experiments/tts-synthesis-latency.mjs`, driving the
production path — `RunwaySpeechClient` out of `backend/dist`, `HER_VOICE`
(`Syl High Pitch`, `seed_audio`), her 28-second reference clip base64'd onto the
wire as `reference-audio`, exactly as `voice-service.ts` sends it. Polled at
250ms rather than production's 3000ms so the number is synthesis and not our own
poll quantisation. Three utterances, run once each, 2026-08-21.

**Results.** Time from `POST /v1/text_to_speech` to a playable mp3 on disk.

| utterance | chars | submit | task ready | on disk | audio produced | credits |
|---|---|---|---|---|---|---|
| one sentence | 44 | 1837ms | 28408ms | **28897ms** | ~3s | 5 |
| two sentences | 132 | 1029ms | 31938ms | **32263ms** | ~8s | 5 |
| short paragraph | 384 | 1077ms | 55362ms | **55917ms** | ~27s | 7 |

**Mean: 39026ms.** Download off the signed URL is negligible (325-555ms); the
whole cost is the task sitting in Runway's queue.

**Does it scale with character count? YES.** Least-squares over the three
points: **~82.6ms per character** on a fixed floor of **~23.6 seconds**. Put
another way, the marginal cost is roughly **real-time** — 3s of speech costs
~3s, 27s of speech costs ~27s — sat on top of a ~24s queue that every request
pays regardless of length. So a long answer is genuinely a different product
from a short one, and any covering behaviour would have to carry a gap that
grows without bound with the length of what she says.

**Time to first sound, one-sentence answer:**

- warm turn: 1635 + 28897 = **30532ms**
- cold turn: 7450 + 28897 = **36347ms**

**VERDICT: REFUSED at this attach point.** The kill threshold was ~4 seconds.
This is **30.5 seconds warm — seven and a half times over**, and it is not a
tuning problem: even a hypothetical zero-queue streaming version of this vendor
would still be bounded below by real-time synthesis, and the ~24s floor is
architectural to a submit/poll/download task API rather than to prompt length.
A conversational face cannot be built on `seed_audio` as it is called today.

This does not automatically kill the epic; it kills **this attach point**. What
survives is anything that does not need the mouth to open on time — a rendered
clip she makes deliberately, which is what `VoiceService` already does and why
its own doc comment says "measured at fifty seconds for a sentence" without
apologising. A *live* face needs either a streaming TTS endpoint (Runway does
not expose one on this model) or a different vendor in the audio path, and the
second is a decision the Commander has to make, not an implementation detail.

**Cost.** 17 credits across the three utterances, as reported by Runway on the
finished tasks (5 / 5 / 7).

**Nothing refused to work.** `RUNWAYML_API_SECRET` sourced cleanly from
`~/Library/LaunchAgents/com.jmm.syl.core.plist` for the run only; it was never
printed, written, or committed.

## T002 — can the claude binary sit behind a LiveKit AgentSession?

**Answer: yes. The seam exists, and it is in the Node SDK.**

This was named the biggest risk in the epic: LiveKit expects a streaming
LLM node, and ours does not stream. Measured at `28746b5`, the gap between
her first assistant text and `result` is 2–15ms, and a 131-character answer
arrives as one event. `--output-format stream-json` streams **events, not
tokens**.

Read from source rather than documentation prose —
`livekit/agents-js`, `agents/src/llm/llm.ts`:

```
export abstract class LLM
  abstract chat({...}): LLMStream

export abstract class LLMStream implements AsyncIterableIterator<ChatChunk>
  protected output = new AsyncIterableQueue<ChatChunk>()
  protected abstract run(): Promise<void>
```

A custom model extends `LLM` and returns its own `LLMStream`, whose
`run(): Promise<void>` pushes `ChatChunk`s into a queue and closes.
**Nothing requires more than one chunk.** Awaiting the whole answer,
pushing a single chunk and closing satisfies the interface exactly. The
same file documents `await myLlm.chat({...}).collect()` — collecting a
complete response is a supported pattern, not a workaround.

The Python docs agree from the other side: the node "may yield plain text
(as `str`)" and returns `AsyncIterable[ChatChunk]`. An `AsyncIterable` of
length one is legal by construction.

**The adapter is small and it is TypeScript**, which matters: the first
documentation found was Python, and a Python agent process beside a Node
backend would have been a permanent cost.

`livekit/agents-js` — 905 stars, pushed 2026-08-20, not archived.

**Not proven, and must not be reported as if it were.** This establishes
that the *interface* accepts a single-chunk answer. It does not prove an
end-to-end session; that needs a LiveKit server and credentials. Still
open: whether downstream TTS behaves well when the whole text arrives at
once rather than in sentence-sized pieces, and whether a second turn on
the same subprocess keeps its session id through the adapter. Both are
ordinary Phase 4 questions.

## T003 — held, not run

Deliberately **not executed**. It exists to prove an avatar worker will
lip-sync to *her* audio rather than insisting on provider-owned TTS. After
T001, the audio it would publish is audio no conversational face can use.
Running it would prove something true and useless.

What it becomes depends on the fork below: essential if a streaming vendor
is chosen (re-targeted at that vendor's audio), void if the provider owns
TTS, closed if the face is dropped.

## The Phase 1 verdict (T004)

| risk | result |
|---|---|
| claude binary behind a LiveKit model node | **passes** — single-chunk seam, in TypeScript |
| her voice, time to synthesise | **fails** — 28,897ms for one sentence |
| avatar accepts her audio | **held** — moot until the audio question resolves |

**Time to first sound, one sentence: ~30.5s warm, ~36.3s cold. Budget was 4s.**

**The architecture survives. The audio leg does not.**

The transport question — the one that could have ended the epic — came
back clean. What failed is the part nobody thought to doubt, and it failed
by 7.5×, which is not a tuning gap: ~24s of that is a fixed queue inherent
to a submit/poll/download task API, and the remainder is bounded below by
roughly real-time synthesis.

**The sharp consequence.** The entire argument for attaching at the LiveKit
layer was that the avatar worker consumes audio, so *her* voice could drive
the face instead of a vendor's. T001 destroys that premise's foundation:
the reason to attach low was to keep her voice, and her voice is precisely
what cannot go fast.

**The fork, which is the Commander's and is filed to him:**

1. **A streaming TTS vendor in the audio leg only.** Fast enough for
   conversation, but a new metered dependency and a new credential — and
   her voice survives only if it can be cloned there. *Viability under
   research; this option lives or dies on whether her voice can move.*
2. **Let the avatar provider own TTS.** Fastest path, and it hands away
   both her voice and the reason to attach low at all.
3. **Drop the conversational face.** Keep the deliberate rendered clip,
   which lives happily at these latencies because nobody is waiting on it.

**No phase past 1 should begin until that is answered**, because each
branch changes what Phases 3–7 are.

**What this phase cost: one afternoon and seventeen credits.** The epic was
ordered risk-first so it would die cheaply if it was going to die. It
half-died, in the cheapest possible place, before anything was built on top
of it.
