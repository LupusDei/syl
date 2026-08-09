import type { Server } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";

import type {
  Message,
  PresenceState,
  Principal,
  WsAuthChallenge,
  WsClientChatMessage,
  WsConnected,
  WsDeliveryConfirmation,
  WsError,
  WsPresence,
  WsServerChatMessage,
  WsServerFrame,
  WsSyncResponse,
} from "@syl/shared";
import { WebSocketServer, type WebSocket } from "ws";

import { ApiFailure } from "../routes/envelope.js";
import type { ApiKeyService } from "./api-key-service.js";
import { instant, systemClock, type Clock } from "./clock.js";
import { FrameLog, DEFAULT_CAPACITY } from "./frame-log.js";
import type { MessageStore } from "./message-store.js";
import type { AttachmentSink } from "./presence.js";

/**
 * The live socket.
 *
 * Three decisions here are protocol, not implementation, and changing any of
 * them breaks a client in the field:
 *
 * **The server speaks first.** `auth_challenge` arrives before the client
 * sends anything. A client that sends `auth_response` unprompted is answering
 * a challenge it has not seen, and the server closes on it.
 *
 * **Authentication is a frame, not a header.** The browser WebSocket API
 * cannot set one. The iOS client *could* and deliberately does not: one
 * handshake, one code path, two platforms. It is also why the token must never
 * appear in the URL — query strings reach proxy logs, and a bearer token in a
 * log file is a bearer token that has leaked.
 *
 * **`presence` is never replayed and carries no `seq`.** See `FrameLog`.
 */

/** The protocol this server speaks. Clients refuse what they do not know. */
export const PROTOCOL_VERSION = 1;

/**
 * How long an unauthenticated socket may stay open.
 *
 * Without this, anyone who can reach the port can hold connections open
 * indefinitely without ever presenting a credential.
 */
export const DEFAULT_AUTH_TIMEOUT_MS = 10_000;

/** Frames larger than this are refused before being parsed. */
const MAX_FRAME_BYTES = 128 * 1024;

/** The path the contract puts the socket on. */
export const WS_PATH = "/api/v1/ws";

/** Per-connection state. */
interface Connection {
  readonly socket: WebSocket;
  readonly nonce: string;
  principal: Principal | null;
  authTimer: NodeJS.Timeout | null;
}

export interface SylSocketServerOptions {
  readonly server: Server;
  readonly keys: ApiKeyService;
  readonly messages: MessageStore;
  /**
   * Told whether anybody is attached.
   *
   * The socket is the only component that knows this, and `idle` is defined as
   * "present but silent" — so without this parameter Syl can never leave
   * `absent`, which is what the running service did: both halves of presence
   * worked and nothing joined them (`syl-c5q`).
   *
   * Optional, because a socket with no character attached is still a working
   * socket and every frame-level test wants one.
   */
  readonly presence?: AttachmentSink;
  readonly clock?: Clock;
  readonly path?: string;
  readonly capacity?: number;
  readonly authTimeoutMs?: number;
}

/** A frame the server refuses to act on, with the reason a client may see. */
function protocolError(message: string, fatal: boolean): WsError {
  return {
    type: "error",
    error: new ApiFailure("VALIDATION_FAILED", message).toApiError(),
    fatal,
  };
}

/** The one message every authentication failure produces. */
function authError(): WsError {
  return {
    type: "error",
    error: new ApiFailure(
      "UNAUTHORIZED",
      "That token was not accepted. Re-pair this device.",
    ).toApiError(),
    fatal: true,
  };
}

/** Compare two strings without leaking where they differ. */
function equalsInConstantTime(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export class SylSocketServer {
  readonly #wss: WebSocketServer;
  readonly #keys: ApiKeyService;
  readonly #messages: MessageStore;
  readonly #presence: AttachmentSink | null;
  readonly #clock: Clock;
  readonly #log: FrameLog;
  readonly #authTimeoutMs: number;
  readonly #connections = new Set<Connection>();

  constructor(options: SylSocketServerOptions) {
    this.#keys = options.keys;
    this.#messages = options.messages;
    this.#presence = options.presence ?? null;
    this.#clock = options.clock ?? systemClock;
    this.#log = new FrameLog(options.capacity ?? DEFAULT_CAPACITY);
    this.#authTimeoutMs = options.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;

    this.#wss = new WebSocketServer({
      server: options.server,
      path: options.path ?? WS_PATH,
      maxPayload: MAX_FRAME_BYTES,
    });

    this.#wss.on("connection", (socket) => this.#onConnection(socket));

    // `ws` forwards the HTTP server's `error` event onto this emitter. Without
    // a listener here, an EventEmitter with no `error` handler THROWS during
    // the emit — which happens before any listener the caller added to the
    // HTTP server itself, so a plain `EADDRINUSE` on startup surfaces as an
    // uncaught exception instead of rejecting the promise that was waiting for
    // exactly that. Attaching this restores the ordinary path.
    this.#wss.on("error", (error) => {
      console.error("[syl] websocket server error", error);
    });
  }

  /** The newest frame sequence this server has issued. */
  get lastSeq(): number {
    return this.#log.lastSeq;
  }

  /** How many authenticated clients are attached. */
  get clientCount(): number {
    let count = 0;
    for (const connection of this.#connections) {
      if (connection.principal !== null) count += 1;
    }
    return count;
  }

  /** Stop accepting connections and close the ones that are open. */
  async close(): Promise<void> {
    for (const connection of this.#connections) {
      if (connection.authTimer !== null) clearTimeout(connection.authTimer);
      connection.socket.terminate();
    }
    this.#connections.clear();
    this.#reportAttachment();
    await new Promise<void>((resolve, reject) => {
      this.#wss.close((error) => (error ? reject(error) : resolve()));
    });
  }

  /**
   * Tell presence whether anybody is watching.
   *
   * Derived from the connection set rather than asserted by whichever handler
   * happened to run, so two clients attaching and one leaving does not read as
   * "nobody is here". Called from every place the set changes; a fact that is
   * recomputed cannot drift from the thing it describes.
   */
  #reportAttachment(): void {
    this.#presence?.setAttached(this.clientCount > 0);
  }

  /**
   * Publish a message to every attached client.
   *
   * Numbered and logged, so a client that was in a tunnel gets it on reconnect.
   */
  broadcastMessage(message: Message): WsServerChatMessage {
    const frame = this.#log.append({
      type: "chat_message",
      ts: instant(this.#clock()),
      message,
    } satisfies Omit<WsServerChatMessage, "seq">);

    this.#broadcast(frame);
    return frame;
  }

  /**
   * Announce Syl's current state.
   *
   * **Not numbered and not logged.** `since` is when the state began, not when
   * the frame was sent, and it is held constant across repeated frames of the
   * same state — re-stamping it would make it a duplicate of the send time and
   * destroy the only information it carries.
   */
  announcePresence(presence: {
    readonly state: PresenceState;
    readonly intensity: number;
    readonly since: string;
    readonly ttlMs: number;
  }): void {
    const frame: WsPresence = {
      type: "presence",
      state: presence.state,
      intensity: Math.min(1, Math.max(0, presence.intensity)),
      since: presence.since,
      // The one snake_case field on the wire. Three sources pin the spelling.
      ttl_ms: presence.ttlMs,
    };
    this.#broadcast(frame);
  }

  // ------------------------------------------------------------ internals ---

  #onConnection(socket: WebSocket): void {
    const connection: Connection = {
      socket,
      nonce: randomBytes(8).toString("hex"),
      principal: null,
      authTimer: null,
    };
    this.#connections.add(connection);

    connection.authTimer = setTimeout(() => {
      if (connection.principal === null) {
        this.#send(socket, authError());
        socket.close();
      }
    }, this.#authTimeoutMs);
    // A pending timer must not hold the process open on its own.
    connection.authTimer.unref?.();

    socket.on("message", (raw) => this.#onMessage(connection, raw));
    socket.on("close", () => {
      if (connection.authTimer !== null) clearTimeout(connection.authTimer);
      this.#connections.delete(connection);
      this.#reportAttachment();
    });
    socket.on("error", () => {
      // A transport error is not something the peer can be told about; the
      // close handler does the cleanup.
    });

    const challenge: WsAuthChallenge = {
      type: "auth_challenge",
      nonce: connection.nonce,
      protocolVersion: PROTOCOL_VERSION,
    };
    this.#send(socket, challenge);
  }

  #onMessage(connection: Connection, raw: unknown): void {
    let frame: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(String(raw));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("not an object");
      }
      // Safe assertion: guarded immediately above; every field is type-tested
      // before it is used.
      frame = parsed as Record<string, unknown>;
    } catch {
      this.#send(connection.socket, protocolError("That frame is not JSON.", false));
      return;
    }

    const type = frame["type"];
    if (typeof type !== "string") {
      this.#send(connection.socket, protocolError("A frame needs a type.", false));
      return;
    }

    if (connection.principal === null) {
      if (type !== "auth_response") {
        // Answering before the handshake finishes, or ignoring it entirely.
        this.#send(connection.socket, authError());
        connection.socket.close();
        return;
      }
      this.#authenticate(connection, frame);
      return;
    }

    switch (type) {
      case "auth_response":
        this.#send(
          connection.socket,
          protocolError("This connection is already authenticated.", false),
        );
        return;
      case "chat_message":
        this.#onChatMessage(connection, frame);
        return;
      case "sync":
        this.#onSync(connection, frame);
        return;
      case "ping":
        this.#send(connection.socket, {
          type: "pong",
          ts: typeof frame["ts"] === "string" ? frame["ts"] : instant(this.#clock()),
          serverTime: instant(this.#clock()),
        });
        return;
      default:
        this.#send(connection.socket, protocolError(`Unknown frame type ${type}.`, false));
    }
  }

  #authenticate(connection: Connection, frame: Record<string, unknown>): void {
    const token = frame["token"];
    if (typeof token !== "string") {
      this.#send(connection.socket, authError());
      connection.socket.close();
      return;
    }

    // The nonce is optional in the contract. When it is present it must be
    // ours: a client echoing someone else's challenge is not answering ours.
    const nonce = frame["nonce"];
    if (typeof nonce === "string" && !equalsInConstantTime(connection.nonce, nonce)) {
      this.#send(connection.socket, authError());
      connection.socket.close();
      return;
    }

    const result = this.#keys.verify(token);
    if (!result.ok) {
      // `fatal: true` is what tells the client to stop reconnecting and
      // re-pair rather than loop against a wall.
      this.#send(connection.socket, authError());
      connection.socket.close();
      return;
    }

    connection.principal = result.principal;
    if (connection.authTimer !== null) {
      clearTimeout(connection.authTimer);
      connection.authTimer = null;
    }

    const connected: WsConnected = {
      type: "connected",
      lastSeq: this.#log.lastSeq,
      serverTime: instant(this.#clock()),
      protocolVersion: PROTOCOL_VERSION,
      principal: result.principal,
    };
    this.#send(connection.socket, connected);

    // After `connected`, never before it. A client that has not been told the
    // handshake succeeded has no business being told what Syl is doing.
    this.#reportAttachment();
  }

  #onChatMessage(connection: Connection, frame: Record<string, unknown>): void {
    const clientId = frame["clientId"];
    const text = frame["text"];
    const conversationId = frame["conversationId"];

    if (typeof clientId !== "string" || typeof text !== "string") {
      this.#send(
        connection.socket,
        protocolError("A chat_message needs a clientId and text.", false),
      );
      return;
    }

    let appended;
    try {
      appended = this.#messages.append({
        ...(typeof conversationId === "string" ? { conversationId } : {}),
        clientId,
        role: "user",
        text,
      } satisfies Parameters<MessageStore["append"]>[0]);
    } catch (error) {
      this.#send(
        connection.socket,
        protocolError(error instanceof Error ? error.message : "That message was refused.", false),
      );
      return;
    }

    // The confirmation is numbered and logged, and it carries BOTH sequences:
    // `seq` is its position in the frame stream, `messageSeq` is the resulting
    // message's position in its conversation. Feeding the wrong one back into
    // `sync` makes a client either replay everything or believe it is caught
    // up. They are named apart deliberately.
    const confirmation = this.#log.append({
      type: "delivery_confirmation",
      ts: instant(this.#clock()),
      clientId,
      serverId: appended.message.id,
      conversationId: appended.message.conversationId,
      messageSeq: appended.message.seq,
      acceptedAt: appended.message.createdAt,
    } satisfies Omit<WsDeliveryConfirmation, "seq">);

    this.#broadcast(confirmation);

    // A replayed send already produced its chat_message frame the first time.
    if (!appended.replayed) this.broadcastMessage(appended.message);
  }

  #onSync(connection: Connection, frame: Record<string, unknown>): void {
    const sinceSeq = frame["sinceSeq"];
    if (typeof sinceSeq !== "number" || !Number.isInteger(sinceSeq) || sinceSeq < 0) {
      this.#send(
        connection.socket,
        protocolError("sync needs an integer sinceSeq.", false),
      );
      return;
    }

    const limit = frame["limit"];
    const replay = this.#log.since(
      sinceSeq,
      typeof limit === "number" && Number.isInteger(limit) && limit > 0
        ? limit
        : Number.MAX_SAFE_INTEGER,
    );

    const response: WsSyncResponse = {
      type: "sync_response",
      fromSeq: replay.fromSeq,
      toSeq: replay.toSeq,
      complete: replay.complete,
      frames: [...replay.frames],
    };
    this.#send(connection.socket, response);
  }

  /** Send to every authenticated client. */
  #broadcast(frame: WsServerFrame): void {
    for (const connection of this.#connections) {
      if (connection.principal === null) continue;
      this.#send(connection.socket, frame);
    }
  }

  #send(socket: WebSocket, frame: WsServerFrame): void {
    if (socket.readyState !== socket.OPEN) return;
    socket.send(JSON.stringify(frame));
  }
}

/** A client chat frame, for the tests and for anything that builds one. */
export type ClientChatFrame = WsClientChatMessage;
