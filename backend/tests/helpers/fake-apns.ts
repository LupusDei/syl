import { createServer, type Http2Server, type IncomingHttpHeaders } from "node:http2";
import type { AddressInfo } from "node:net";

/**
 * A real HTTP/2 server standing in for Apple.
 *
 * Plaintext h2c rather than TLS: the sender's job is to speak HTTP/2 with the
 * right pseudo-headers, the right path, and one reused session, and none of
 * that is affected by the transport being encrypted. A local certificate would
 * add setup and test nothing.
 *
 * The point of a real server rather than a stub is that the failures worth
 * catching here are protocol failures — a header on the wrong stream, a body
 * sent after `end`, a session that is silently reconnected per notification.
 * A mock of our own client cannot have any of them.
 */

/** One request the fake saw. */
export interface CapturedPush {
  readonly headers: IncomingHttpHeaders;
  readonly path: string;
  readonly authorization: string;
  readonly body: unknown;
  /** Which HTTP/2 session carried it. Reuse is the property under test. */
  readonly sessionId: number;
}

/** What the fake should answer with next. */
export interface FakeApnsReply {
  readonly status: number;
  readonly reason?: string;
  readonly apnsUniqueId?: string;
  /** Delay before answering, for exercising a client-side timeout. */
  readonly delayMs?: number;
}

export interface FakeApns {
  readonly origin: string;
  readonly pushes: readonly CapturedPush[];
  /** How many distinct HTTP/2 sessions have been accepted. */
  readonly sessionCount: number;
  /** Queue one reply. Exhausted queues fall back to 200. */
  reply(next: FakeApnsReply): void;
  /**
   * Refuse **every** push from now on, until {@link FakeApns.accept}.
   *
   * A queue cannot express "for the rest of the week". Journey 4 drives 169
   * passes and the number of network attempts in them is a property of the
   * implementation under test — the whole question that journey asks — so a
   * fixture of *n* queued refusals silently becomes "Apple starts accepting
   * after the nth attempt", at an hour nobody chose. That is a fixture deciding
   * the outcome of the test.
   */
  refuse(reply: FakeApnsReply): void;
  /** Stop refusing. The credentials were fixed. */
  accept(): void;
  close(): Promise<void>;
}

/** Start a fake APNs endpoint on an ephemeral loopback port. */
export async function startFakeApns(): Promise<FakeApns> {
  const pushes: CapturedPush[] = [];
  const replies: FakeApnsReply[] = [];
  /** The standing answer, when one has been set. Outranks the queue. */
  let standing: FakeApnsReply | null = null;
  let sessions = 0;
  const sessionIds = new WeakMap<object, number>();
  const open = new Set<{ destroy(): void }>();

  const server: Http2Server = createServer();

  server.on("session", (session) => {
    sessions += 1;
    sessionIds.set(session, sessions);
    open.add(session);
    session.on("close", () => open.delete(session));
  });

  server.on("stream", (stream, headers) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown = raw;
      try {
        body = JSON.parse(raw);
      } catch {
        // Left as the raw string; a test asserting on it will say so plainly.
      }

      pushes.push({
        headers,
        path: String(headers[":path"] ?? ""),
        authorization: String(headers["authorization"] ?? ""),
        body,
        sessionId: sessionIds.get(stream.session ?? {}) ?? 0,
      });

      const reply = standing ?? replies.shift() ?? { status: 200 };
      const send = (): void => {
        if (stream.destroyed) return;
        const responseHeaders: Record<string, string | number> = {
          ":status": reply.status,
          "apns-unique-id": reply.apnsUniqueId ?? "FAKE-UNIQUE-ID",
        };
        if (reply.status === 200) {
          stream.respond(responseHeaders);
          stream.end();
          return;
        }
        stream.respond({ ...responseHeaders, "content-type": "application/json" });
        stream.end(JSON.stringify({ reason: reply.reason ?? "BadRequest" }));
      };

      if (reply.delayMs === undefined) send();
      else setTimeout(send, reply.delayMs).unref();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${address.port}`,
    get pushes() {
      return pushes;
    },
    get sessionCount() {
      return sessions;
    },
    reply: (next) => {
      replies.push(next);
    },
    refuse: (next) => {
      standing = next;
    },
    accept: () => {
      standing = null;
    },
    close: () =>
      new Promise<void>((resolve) => {
        // A session the client is still holding open would keep `close`
        // waiting forever, so they are torn down first.
        for (const session of open) session.destroy();
        open.clear();
        server.close(() => resolve());
      }),
  };
}
