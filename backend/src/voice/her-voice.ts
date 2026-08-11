import { resolve } from "node:path";

/**
 * Which voice she speaks in. **The one place a person changes it.**
 *
 * ## The ruling this file obeys
 *
 * The Commander, 2026-08-11: *"Don't worry too much about the voice, just build
 * in the one I provided."* So there is no voice design here, no listing, no
 * comparison and no selection — one voice, named, in configuration.
 *
 * `SOUL.md` says her voice is a search, and it is. But **she cannot hear**: she
 * has image input and no audio input, so she can look at a still of her own
 * face and judge it, and she cannot listen to a voice and know whether it is
 * hers. That search needs him in the loop, and he has said not now. The soul
 * text stays; the capability waits. What survives of the search here is that
 * changing his mind costs one edit in one file, or two environment variables.
 *
 * ## What Runway will and will not do with this id
 *
 * `93b52581-…` is a **custom voice** on the organisation, created by him in
 * Runway on 2026-08-09. Probing the validator and then the published schema
 * (`https://docs.dev.runwayml.com/openapi.json`, 2026-08-11) settled what that
 * id is worth:
 *
 * `POST /v1/text_to_speech` is a union on `model`, and its `voice` is a nested
 * union on `voice.type` with exactly three members — `runway-preset` and
 * `seed-preset`, which name stock voices from fixed enums, and `reference-audio`,
 * which carries an audio clip. **There is no member that takes a custom voice
 * id.** That id is accepted only by `/v1/avatars` and `/v1/avatar_videos`,
 * which are the live-persona product and generate their own video rather than
 * speaking over one she made.
 *
 * So the id cannot be sent, and the voice can still be used: her clip is
 * fetched once from `GET /v1/voices/{id}` and passed as `reference-audio`.
 * **That is why {@link VoiceSetting} carries both an id and a sample** — the id
 * is the provenance and the thing that fetches the clip, and the clip is what
 * actually goes on the wire. They must be changed together, which is what
 * {@link voiceFrom} enforces.
 */

/** A voice, as everything downstream needs it. */
export interface VoiceSetting {
  /** Her voice on the organisation. Provenance, and what fetches the clip. */
  readonly id: string;
  /** What he called it, so a record says a name rather than a UUID. */
  readonly name: string;
  /** The speech model. `seed_audio` is the only one that takes a reference clip. */
  readonly model: "seed_audio";
  /** Her reference clip, relative to her home. Never inside the repository. */
  readonly sample: string;
  readonly outputFormat: "mp3";
}

/**
 * The voice he made, and the one she speaks in.
 *
 *     Syl High Pitch    93b52581-17ab-4905-bb5a-4fa730a7757a
 *
 * His ruling, 2026-08-11: *"probably the best voice for now"*. The three others
 * he made that day are in `~/.syl/voice/README.md` with their ids; switching to
 * one of them is `SYL_VOICE_ID` and a re-fetch of the clip.
 */
export const HER_VOICE: VoiceSetting = {
  id: "93b52581-17ab-4905-bb5a-4fa730a7757a",
  name: "Syl High Pitch",
  model: "seed_audio",
  sample: "voice/93b52581-17ab-4905-bb5a-4fa730a7757a.mp3",
  outputFormat: "mp3",
};

/**
 * How much of the clip Runway will look at.
 *
 * Measured, not read: the full preview is about eighty seconds, and sending it
 * comes back `400 {"code":"too_big","maximum":30,"path":["voice",".audioUri"]}`
 * — *before* any credit is spent, but also before any speech exists. The clip
 * is trimmed once when it is placed rather than checked on every call.
 */
export const MAX_REFERENCE_SECONDS = 30;

/**
 * How long the clip is actually trimmed to.
 *
 * **Deliberately under the cap, and it has to be.** `ffmpeg -t 30 -c copy` on
 * an mp3 cannot cut mid-frame, so it rounds up to the next frame boundary and
 * writes 30.027755 seconds — which Runway refuses, because
 * {@link MAX_REFERENCE_SECONDS} is inclusive. Measured on 2026-08-11; the
 * failure arrives as `too_big` on `voice.audioUri` and reads like a file-size
 * problem rather than a rounding one.
 *
 * Re-encoding to hit exactly thirty would degrade the very clip that carries
 * the voice. Two seconds of headroom is cheaper and the model does not need
 * them.
 */
export const REFERENCE_SECONDS = 28;

/**
 * The longest thing `seed_audio` will say in one go, in UTF-16 code units.
 *
 * From the published schema's `maxLength` on `promptText`. Checked here so that
 * an over-long sentence is a refusal she can read rather than a validator error
 * that arrives after the reference clip has been base64'd onto the wire.
 */
export const MAX_SPEECH_CHARS = 2048;

/** Where her reference clip is on this machine. */
export function samplePath(home: string, voice: VoiceSetting = HER_VOICE): string {
  return resolve(home, voice.sample);
}

/**
 * The voice this machine speaks in.
 *
 * `SYL_VOICE_ID` alone is enough, and it **moves the sample with it**. A
 * changed id that kept the previous clip would go on speaking in the old voice
 * with the new one's name on the record — a wrong voice that looks exactly like
 * a right one, which is the failure mode worth spending a branch on.
 */
export function voiceFrom(env: NodeJS.ProcessEnv = process.env): VoiceSetting {
  const id = read(env, "SYL_VOICE_ID");
  if (id === undefined) return HER_VOICE;

  return {
    id,
    name: read(env, "SYL_VOICE_NAME") ?? id,
    model: HER_VOICE.model,
    sample: read(env, "SYL_VOICE_SAMPLE") ?? `voice/${id}.mp3`,
    outputFormat: HER_VOICE.outputFormat,
  };
}

/** Blank and whitespace-only are how an environment spells "I did not set this". */
function read(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name]?.trim();
  return raw === undefined || raw === "" ? undefined : raw;
}
