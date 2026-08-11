import type { WsServerFrame } from "@syl/shared";
import WebSocket from "ws";

/**
 * A WebSocket client that queues frames, so a test can say "the next frame"
 * without racing the server.
 *
 * Written by hand rather than mocked: the protocol's interesting failures are
 * about *ordering* — the server speaking first, a frame arriving before the
 * handshake finished — and a double that resolves calls in the order the test
 * makes them cannot exhibit any of them.
 */
export class TestClient {
  readonly #socket: WebSocket;
  readonly #queue: WsServerFrame[] = [];
  readonly #ignorePresence: boolean;
  #waiting: ((frame: WsServerFrame) => void) | null = null;
  #closed = false;
  #closeCode: number | null = null;

  private constructor(socket: WebSocket, ignorePresence: boolean) {
    this.#socket = socket;
    this.#ignorePresence = ignorePresence;
    socket.on("message", (raw) => {
      // Safe assertion: everything this server sends is a server frame, and
      // any test that cares re-checks the fields it reads.
      const frame = JSON.parse(String(raw)) as WsServerFrame;
      // Presence is unsolicited and asynchronous: attaching flips Syl from
      // `absent` to `idle` and announces it, but only outside quiet hours. A
      // test that reads frames positionally on the real clock therefore passes
      // before 08:00 Chicago and fails after — which is a statement about the
      // hour the suite ran, exactly what this repo has been bitten by before.
      // Tests that are not *about* presence drop it here.
      if (this.#ignorePresence && frame.type === "presence") return;
      const waiting = this.#waiting;
      if (waiting !== null) {
        this.#waiting = null;
        waiting(frame);
      } else {
        this.#queue.push(frame);
      }
    });
    socket.on("close", (code) => {
      this.#closed = true;
      this.#closeCode = code;
    });
  }

  /**
   * Connect and resolve once the socket is open.
   *
   * The listeners are attached *before* the open handshake is awaited. The
   * server speaks first, so a client that waits for `open` and only then
   * subscribes can miss the `auth_challenge` entirely — and a lost first frame
   * looks exactly like a server that never sent one.
   */
  static async connect(
    url: string,
    options: {
      /** Drop presence announcements, for a test that is not about presence. */
      readonly ignorePresence?: boolean;
    } = {},
  ): Promise<TestClient> {
    const socket = new WebSocket(url);
    const client = new TestClient(socket, options.ignorePresence === true);

    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });

    return client;
  }

  /** Whether the server has closed this socket. */
  get closed(): boolean {
    return this.#closed;
  }

  get closeCode(): number | null {
    return this.#closeCode;
  }

  /** Send a client frame. */
  send(frame: Record<string, unknown>): void {
    this.#socket.send(JSON.stringify(frame));
  }

  /** Send something that is not a frame at all. */
  sendRaw(text: string): void {
    this.#socket.send(text);
  }

  /**
   * The next frame from the server.
   *
   * Times out rather than hanging: a protocol test that hangs tells you
   * nothing, and vitest's own timeout would point at the whole test rather
   * than at the frame that never came.
   */
  next(timeoutMs = 2_000): Promise<WsServerFrame> {
    const queued = this.#queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);

    return new Promise<WsServerFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiting = null;
        reject(new Error(`No frame arrived within ${timeoutMs}ms.`));
      }, timeoutMs);

      this.#waiting = (frame) => {
        clearTimeout(timer);
        resolve(frame);
      };
    });
  }

  /** Resolve once the server has closed this socket. */
  async waitForClose(timeoutMs = 2_000): Promise<void> {
    if (this.#closed) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("The socket stayed open.")), timeoutMs);
      this.#socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Assert nothing arrives for a while. Used for "presence is not replayed". */
  async expectSilence(ms = 150): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
    if (this.#queue.length > 0) {
      throw new Error(`Expected silence, got ${JSON.stringify(this.#queue)}`);
    }
  }

  close(): void {
    this.#socket.removeAllListeners();
    this.#socket.terminate();
  }
}
