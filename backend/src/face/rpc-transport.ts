import type { AskSylIngress } from "./ask-syl.js";
import type { FaceTransport } from "./face-runtime.js";
import type { LiveKitConnectCreds } from "./runway-client.js";

/**
 * How the avatar actually reaches her — `syl-chzl.7.5`.
 *
 * `face-runtime.ts` declares {@link FaceTransport} as a seam and ships
 * `NO_TRANSPORT` in it, so a face opens and cannot be asked anything. This is
 * the real one.
 *
 * ## Every byte of it is outbound
 *
 * A Runway `backend_rpc` tool is **not a webhook**. `@runwayml/avatars-node-rpc`'s
 * `createRpcHandler` opens a LiveKit `Room` with credentials for the session,
 * joins it as one more participant, and calls `localParticipant.registerRpcMethod`.
 * The avatar's model then performs an RPC *to a participant already in the room*.
 * The provider never dials us.
 *
 * That is why `ask_syl` needs no inbound exposure, no public hostname and no
 * Tailscale Funnel — and it is stated here as well as in `ask-syl.ts` because
 * this file is where someone would otherwise go looking for the listener.
 *
 * ## Where the secret is, and where it is not
 *
 * The library will fetch its own room credentials given `apiKey` + `sessionId`.
 * **We do not let it.** `RunwayClient` is documented as the one place in this
 * service that holds `RUNWAYML_API_SECRET`, so the credentials are fetched
 * through the broker's `connectBackend` and handed over pre-fetched. The vendor
 * library receives a room-scoped token that expires with the session and never
 * sees the org secret. Verified against the published `0.1.0` types, which
 * document `credentials` as the alternative to `apiKey` + `sessionId`.
 *
 * ## Why the package is imported lazily
 *
 * It drags `@livekit/rtc-node`, a platform-specific native binary, into a
 * service that deploys from a plain `tsc` build. A variable module specifier
 * keeps `tsc` from resolving it at compile time and the dynamic import keeps it
 * off the boot path, so the whole subsystem typechecks, unit-tests and builds
 * on a machine where the package is not installed. Production resolves it the
 * first time a face opens.
 *
 * **It must be installed where Syl actually runs.** A missing package surfaces
 * as an attach failure, which `routes/face.ts` logs as `face.rpc.attach_failed`
 * and then hands the session over anyway — she appears, and she is mute. That
 * is the right call for a billable session and a bad thing to diagnose from the
 * outside, so the log line names the module.
 */

/* ------------------------------------------------------------------ *
 * Local typings for `@runwayml/avatars-node-rpc`.
 *
 * Mirrors the published 0.1.0 declarations so this module depends on the SHAPE
 * rather than on the package being resolvable when `tsc` runs.
 * ------------------------------------------------------------------ */

/** One RPC tool: the model's arguments in, a structured result out. */
export type RpcToolHandler = (args: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** The `/connect_backend` response, as the library wants it. */
export interface LiveKitCredentials {
  url: string;
  token: string;
  roomName: string;
}

/** The subset of `createRpcHandler`'s options this transport uses. */
export interface CreateRpcHandlerOptions {
  apiKey?: string;
  sessionId?: string;
  baseUrl?: string;
  credentials?: LiveKitCredentials;
  tools: Record<string, RpcToolHandler>;
  onConnected?: () => void;
  onDisconnected?: () => void;
  onError?: (error: Error) => void;
  debug?: boolean;
}

/** The live handler `createRpcHandler` returns. */
export interface RpcHandlerLike {
  close(): Promise<void>;
  readonly connected: boolean;
}

/** The factory signature. The real one comes from the package. */
export type CreateRpcHandlerFn = (options: CreateRpcHandlerOptions) => Promise<RpcHandlerLike>;

/**
 * The default factory: the vendor package, imported the first time a face opens.
 *
 * The specifier is a variable on purpose — see the header.
 */
const defaultCreateHandler: CreateRpcHandlerFn = async (options) => {
  const moduleName = "@runwayml/avatars-node-rpc";
  const loaded = (await import(/* @vite-ignore */ moduleName)) as {
    createRpcHandler: CreateRpcHandlerFn;
  };
  return loaded.createRpcHandler(options);
};

export interface RunwayFaceTransportOptions {
  /** The one gate. Both doors verify through it — see `ask-syl.ts`. */
  readonly ingress: Pick<AskSylIngress, "handlerFor">;
  /**
   * Room credentials for a session. `broker.connectBackend`, which creates no
   * second session and charges no second upfront credit.
   */
  readonly connectBackend: (sessionId: string) => Promise<LiveKitConnectCreds>;
  /** Injected by tests. Defaults to the lazily imported vendor factory. */
  readonly createHandler?: CreateRpcHandlerFn;
  readonly log?: (event: string, fields: Record<string, unknown>) => void;
}

/** A {@link FaceTransport} that can also be asked what it is holding. */
export interface RunwayFaceTransport extends FaceTransport {
  /** Is a handler registered for this session right now? */
  has(sessionId: string): boolean;
  /** Leave every room. The service's half of the lifecycle, at shutdown. */
  closeAll(): Promise<void>;
}

export function createRunwayFaceTransport(
  options: RunwayFaceTransportOptions,
): RunwayFaceTransport {
  const createHandler = options.createHandler ?? defaultCreateHandler;
  const log =
    options.log ??
    ((event: string, fields: Record<string, unknown>): void => {
      console.info(`[syl] ${event}`, fields);
    });

  /** One handler per live session. */
  const handlers = new Map<string, RpcHandlerLike>();

  /** Drop a handler, quietly. Never throws — teardown must not fail teardown. */
  async function drop(sessionId: string): Promise<boolean> {
    const handler = handlers.get(sessionId);
    if (handler === undefined) return false;
    handlers.delete(sessionId);
    try {
      await handler.close();
    } catch (error) {
      log("face.rpc.close_failed", {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  return {
    async attach(input: { sessionId: string; askSecret: string }): Promise<void> {
      const { sessionId, askSecret } = input;

      // A retry of the same session must not leave a second participant in the
      // room with nobody holding it. The renewal path opens a *fresh* session
      // and so does not come through here twice.
      await drop(sessionId);

      const creds = await options.connectBackend(sessionId);

      // The credential is bound HERE, at attach time, because the handler is
      // created per session by us. The LiveKit path therefore presents a real
      // credential to the real verifier rather than being trusted for arriving
      // on a socket — one gate, two doors.
      const tools = options.ingress.handlerFor(sessionId, askSecret);

      const handler = await createHandler({
        credentials: { url: creds.url, token: creds.token, roomName: creds.roomName },
        tools,
        onConnected: () => {
          log("face.rpc.connected", { sessionId, roomName: creds.roomName });
        },
        onDisconnected: () => {
          // The room dropped us. Forget the handler so a later `close` is not a
          // lie, and so the reaper's escalation reads the truth.
          handlers.delete(sessionId);
          log("face.rpc.disconnected", { sessionId, roomName: creds.roomName });
        },
        onError: (error: Error) => {
          log("face.rpc.error", { sessionId, error: error.message });
        },
      });

      handlers.set(sessionId, handler);
      log("face.rpc.attached", { sessionId, roomName: creds.roomName });
    },

    async close(sessionId: string): Promise<void> {
      await drop(sessionId);
    },

    has(sessionId: string): boolean {
      return handlers.has(sessionId);
    },

    async closeAll(): Promise<void> {
      await Promise.all([...handlers.keys()].map((sessionId) => drop(sessionId)));
    },
  };
}
