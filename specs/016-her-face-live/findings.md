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
