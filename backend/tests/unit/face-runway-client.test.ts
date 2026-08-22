import { describe, expect, it } from "vitest";

import {
  RunwayApiError,
  RunwayClient,
  RUNWAY_AVATAR_MODEL,
} from "../../src/face/runway-client.js";

const SECRET = "key_thisisthesecretandmustneverleave";
const AVATAR = "48cbc73d-f47f-41de-bed8-58a532b3b84b";

/** A fetch that records what it was asked and answers with a canned response. */
function recordingFetch(
  responder: (url: string, init: RequestInit | undefined) => Response,
): { fetch: typeof fetch; calls: { url: string; init: RequestInit | undefined }[] } {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const impl = ((input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, init });
    return Promise.resolve(responder(url, init));
  }) as typeof fetch;
  return { fetch: impl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function client(fetchImpl: typeof fetch): RunwayClient {
  return new RunwayClient({ apiKey: SECRET, fetchImpl });
}

describe("RunwayClient", () => {
  it("should refuse to exist without a secret rather than sending unauthenticated requests", () => {
    expect(() => new RunwayClient({ apiKey: "" })).toThrow(/RUNWAYML_API_SECRET/);
  });

  describe("creating a realtime session", () => {
    it("should post the avatar model and a custom avatar selector", async () => {
      const recorder = recordingFetch(() => json({ id: "rts_1", status: "PENDING" }));

      await client(recorder.fetch).createRealtimeSession({
        avatar: { type: "custom", avatarId: AVATAR },
      });

      const call = recorder.calls[0];
      expect(call?.url).toBe("https://api.dev.runwayml.com/v1/realtime_sessions");
      expect(call?.init?.method).toBe("POST");
      const body = JSON.parse(String(call?.init?.body)) as Record<string, unknown>;
      expect(body["model"]).toBe(RUNWAY_AVATAR_MODEL);
      expect(body["avatar"]).toEqual({ type: "custom", avatarId: AVATAR });
    });

    it("should sign the request with the secret and pin the API version", async () => {
      const recorder = recordingFetch(() => json({ id: "rts_1" }));

      await client(recorder.fetch).createRealtimeSession({
        avatar: { type: "custom", avatarId: AVATAR },
      });

      const headers = recorder.calls[0]?.init?.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe(`Bearer ${SECRET}`);
      expect(headers["X-Runway-Version"]).toBe("2024-11-06");
    });

    it("should omit optional fields entirely rather than sending them as null", async () => {
      const recorder = recordingFetch(() => json({ id: "rts_1" }));

      await client(recorder.fetch).createRealtimeSession({
        avatar: { type: "custom", avatarId: AVATAR },
      });

      const body = JSON.parse(String(recorder.calls[0]?.init?.body)) as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(["avatar", "model"]);
    });

    it("should carry the declared backend_rpc tools when there are any", async () => {
      const recorder = recordingFetch(() => json({ id: "rts_1" }));

      await client(recorder.fetch).createRealtimeSession({
        avatar: { type: "custom", avatarId: AVATAR },
        tools: [
          {
            type: "backend_rpc",
            name: "ask_syl",
            description: "Ask Syl.",
            parameters: [{ name: "question", type: "string", description: "What he said." }],
            timeoutSeconds: 8,
          },
        ],
      });

      const body = JSON.parse(String(recorder.calls[0]?.init?.body)) as Record<string, unknown>;
      expect(body["tools"]).toHaveLength(1);
    });

    it("should turn a non-2xx into a typed error carrying the status", async () => {
      const recorder = recordingFetch(() => json({ error: "nope" }, 402));

      await expect(
        client(recorder.fetch).createRealtimeSession({
          avatar: { type: "custom", avatarId: AVATAR },
        }),
      ).rejects.toBeInstanceOf(RunwayApiError);
    });

    it("should never put the secret in the text of an error", async () => {
      const recorder = recordingFetch(() => new Response(`bad key ${SECRET}`, { status: 401 }));

      await expect(
        client(recorder.fetch).createRealtimeSession({
          avatar: { type: "custom", avatarId: AVATAR },
        }),
      ).rejects.toSatisfy((error: unknown) => !String(error).includes(SECRET));
    });
  });

  describe("polling a session", () => {
    it("should read the session back by id", async () => {
      const recorder = recordingFetch(() =>
        json({ id: "rts_1", status: "READY", sessionKey: "stk_abc", expiresAt: "2026-08-21T12:05:00.000Z" }),
      );

      const row = await client(recorder.fetch).getRealtimeSession("rts_1");

      expect(recorder.calls[0]?.url).toBe("https://api.dev.runwayml.com/v1/realtime_sessions/rts_1");
      expect(row.status).toBe("READY");
      expect(row.sessionKey).toBe("stk_abc");
    });
  });

  describe("joining the room as the backend RPC participant", () => {
    it("should ask Runway for LiveKit join credentials for an existing session", async () => {
      const recorder = recordingFetch(() =>
        json({ url: "wss://livekit.example", token: "lk_tok", roomName: "room-1" }),
      );

      const creds = await client(recorder.fetch).connectBackend("rts_1");

      expect(recorder.calls[0]?.url).toBe(
        "https://api.dev.runwayml.com/v1/realtime_sessions/rts_1/connect_backend",
      );
      expect(creds.roomName).toBe("room-1");
      expect(creds.token).toBe("lk_tok");
    });
  });
});
