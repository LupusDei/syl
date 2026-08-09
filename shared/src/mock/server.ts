import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocket, WebSocketServer } from "ws";

import { fixture } from "../fixtures.js";
import type { ApiError, ErrorCode, PresenceState } from "../types.js";
import { API_BASE, matchRoute, pathExists, specRoutes, WS_PATH } from "./router.js";
import {
  createRng,
  DEFAULT_SCENARIO,
  delayFor,
  mergeScenario,
  nextFault,
  type Scenario,
  scenarioFromHeaders,
} from "./scenario.js";
import { type Broadcast, MockStore, nowIso, page } from "./store.js";

/**
 * The mock server.
 *
 * Two squads build against this for days with no backend, so it is held to a
 * higher bar than "returns some JSON":
 *
 * - **Every operation in the contract is routable.** The table comes from the
 *   spec, and a test cross-checks it against the handler map.
 * - **Writes echo the caller's own ids** and change what later reads return.
 * - **Idempotency actually works**, because the mobile outbox retries by
 *   design and cannot be developed against a server that never replays.
 * - **Latency and failure are scriptable**, including the tunnel simply not
 *   being there. A happy-path mock produces clients that fall over the first
 *   time reality is slow.
 */

const PROTOCOL_VERSION = 1;
const REPLAY_BUFFER_SIZE = 200;

export interface MockServerOptions {
  readonly port?: number;
  readonly host?: string;
  /** Starting scenario. Useful for `npm run mock -- --latency 400`. */
  readonly scenario?: Partial<Scenario>;
  /** Silence the request log. Tests set this. */
  readonly quiet?: boolean;
}

interface Pending {
  readonly hash: string;
  readonly status: number;
  readonly body: unknown;
}

type Handler = (context: HandlerContext) => Result;

interface HandlerContext {
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  readonly body: Record<string, unknown>;
  readonly store: MockStore;
  readonly server: MockServer;
}

type Result =
  | { readonly ok: true; readonly status?: number; readonly data: unknown }
  | { readonly ok: false; readonly status: number; readonly code: ErrorCode; readonly message: string };

const ok = (data: unknown, status?: number): Result =>
  status === undefined ? { ok: true, data } : { ok: true, status, data };

const notFound = (what: string): Result => ({
  ok: false,
  status: 404,
  code: "NOT_FOUND",
  message: `No ${what} with that id.`,
});

export class MockServer {
  readonly store = new MockStore();
  scenario: Scenario;
  private readonly http: Server;
  private readonly wss: WebSocketServer;
  private readonly rng: () => number;
  private readonly idempotency = new Map<string, Pending>();
  private readonly quiet: boolean;
  private readonly sockets = new Set<WebSocket>();
  private readonly replay: { seq: number; frame: Record<string, unknown> }[] = [];
  private seq = 4470;

  constructor(private readonly options: MockServerOptions = {}) {
    this.scenario = mergeScenario(DEFAULT_SCENARIO, options.scenario ?? {});
    this.quiet = options.quiet === true;
    this.rng = createRng(this.scenario.seed);
    this.http = createServer((req, res) => {
      // A throw inside the handler would otherwise become an unhandled
      // rejection and take the whole process down — which for a mock two
      // squads are building against means everyone's afternoon, from one bad
      // request. Answer 500 and stay up.
      this.handleHttp(req, res).catch((cause: unknown) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        this.log(`${req.method ?? "GET"} ${req.url ?? "/"} -> 500 ${message}`);
        if (res.headersSent) {
          res.end();
          return;
        }
        this.sendError(res, 500, {
          code: "INTERNAL",
          message,
          retryable: false,
          details: null,
          retryAfterMs: null,
        });
      });
    });
    this.wss = new WebSocketServer({ noServer: true });
    this.http.on("upgrade", (req, socket, head) => {
      this.handleUpgrade(req, socket, head);
    });
  }

  listen(): Promise<number> {
    return new Promise((resolve) => {
      this.http.listen(this.options.port ?? 4210, this.options.host ?? "127.0.0.1", () => {
        resolve(this.port);
      });
    });
  }

  get port(): number {
    const address = this.http.address();
    return typeof address === "object" && address !== null ? address.port : 0;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.terminate();
    this.sockets.clear();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }

  private log(line: string): void {
    if (!this.quiet) console.log(line);
  }

  // ------------------------------------------------------------- routing ---

  private readonly handlers: Readonly<Record<string, Handler>> = {
    getHealth: ({ store }) => ok(store.health()),
    pairDevice: ({ body, store }) =>
      ok({
        ...(fixture("http/auth.pair") as { data: Record<string, unknown> }).data,
        principal: store.principal,
        token: `syl_pat_mock_${String(body["deviceName"] ?? "device").replace(/\W+/g, "_")}`,
      }),
    whoami: ({ store }) => ok(store.principal),

    listConversations: ({ store, query }) => {
      const lane = query.get("lane");
      const items =
        lane === null ? store.conversations : store.conversations.filter((c) => c.lane === lane);
      return ok(page(items));
    },
    getConversation: ({ params, store }) => {
      const found = store.conversation(params["conversationId"] ?? "");
      return found === undefined ? notFound("conversation") : ok(found);
    },
    listMessages: ({ params, store, query }) => {
      const items = store.messagesFor(params["conversationId"] ?? "");
      const ordered = query.get("direction") === "forward" ? items : [...items].reverse();
      return ok(page(ordered));
    },
    sendMessage: ({ params, body, store, server }) => {
      const conversationId = params["conversationId"] ?? "";
      const clientId = body["clientId"];
      if (typeof clientId !== "string" || clientId.length < 8) {
        return {
          ok: false,
          status: 400,
          code: "VALIDATION_FAILED",
          // Without it the client cannot reconcile its optimistic bubble, so
          // the mock refuses rather than inventing one and looking like it
          // worked.
          message: "clientId is required on every send, and must be at least 8 characters.",
        };
      }
      const text = typeof body["text"] === "string" ? body["text"] : "";
      if (text.length === 0) {
        return { ok: false, status: 400, code: "VALIDATION_FAILED", message: "text must not be empty." };
      }
      const { confirmation, broadcasts } = store.sendMessage(conversationId, { clientId, text });
      server.afterSend(broadcasts);
      return ok(confirmation, 201);
    },

    listReminders: ({ store, query }) => {
      const state = query.get("state");
      const items =
        state === null ? store.reminders : store.reminders.filter((r) => r.deliveryState === state);
      return ok(page(items));
    },
    createReminder: ({ body, store }) => ok(store.createReminder(body), 201),
    getReminder: ({ params, store }) => {
      const found = store.reminder(params["reminderId"] ?? "");
      return found === undefined ? notFound("reminder") : ok(found);
    },
    updateReminder: ({ params, body, store }) => {
      const found = store.updateReminder(params["reminderId"] ?? "", body);
      return found === undefined ? notFound("reminder") : ok(found);
    },
    cancelReminder: ({ params, store }) => {
      const found = store.setReminderState(params["reminderId"] ?? "", "cancelled");
      return found === undefined ? notFound("reminder") : ok(found);
    },
    completeReminder: ({ params, store }) => {
      const found = store.setReminderState(params["reminderId"] ?? "", "completed");
      return found === undefined ? notFound("reminder") : ok(found);
    },
    snoozeReminder: ({ params, body, store }) => {
      const result = store.snoozeReminder(params["reminderId"] ?? "", {
        until: (body["until"] as string | null) ?? null,
        minutes: (body["minutes"] as number | null) ?? null,
      });
      if ("reminder" in result) return ok(result.reminder);
      if (result.error === "NOT_FOUND") return notFound("reminder");
      return {
        ok: false,
        status: 409,
        code: "DEFERRAL_NOT_LATER",
        message: "A deferral must resolve to a strictly later instant than the current fire time.",
      };
    },

    listTodos: ({ store, query }) => {
      const status = query.get("status");
      const items = status === null ? store.todos : store.todos.filter((t) => t.status === status);
      return ok(page(items));
    },
    createTodo: ({ body, store }) => ok(store.createTodo(body), 201),
    getTodo: ({ params, store }) => {
      const found = store.todo(params["todoId"] ?? "");
      return found === undefined ? notFound("to-do") : ok(found);
    },
    updateTodo: ({ params, body, store }) => {
      const found = store.updateTodo(params["todoId"] ?? "", body);
      return found === undefined ? notFound("to-do") : ok(found);
    },
    completeTodo: ({ params, store }) => {
      const found = store.completeTodo(params["todoId"] ?? "");
      return found === undefined ? notFound("to-do") : ok(found);
    },

    listGoals: ({ store, query }) => {
      const status = query.get("status");
      const items = status === null ? store.goals : store.goals.filter((g) => g.status === status);
      return ok(page(items));
    },
    createGoal: ({ body, store }) => ok(store.createGoal(body), 201),
    getGoal: ({ params, store }) => {
      const found = store.goal(params["goalId"] ?? "");
      return found === undefined ? notFound("goal") : ok(found);
    },

    listDevices: ({ store }) => ok(page(store.devices)),
    registerDevice: ({ body, store }) => ok(store.registerDevice(body), 201),
    unregisterDevice: ({ params, store }) => {
      const found = store.unregisterDevice(params["deviceId"] ?? "");
      return found === undefined ? notFound("device") : ok(found);
    },

    listDeliveries: ({ store, query }) => {
      let items = store.deliveries;
      const state = query.get("state");
      if (state !== null) items = items.filter((d) => d.state === state);
      if (query.get("unacknowledged") === "true") items = items.filter((d) => d.ackedAt === null);
      return ok(page(items));
    },
    getDelivery: ({ params, store }) => {
      const found = store.delivery(params["deliveryId"] ?? "");
      return found === undefined ? notFound("delivery") : ok(found);
    },
    acknowledgeDelivery: ({ params, body, store }) => {
      const found = store.acknowledgeDelivery(params["deliveryId"] ?? "", {
        ackedAt: typeof body["ackedAt"] === "string" ? body["ackedAt"] : nowIso(),
        engagement: body["engagement"] as never,
      });
      return found === undefined ? notFound("delivery") : ok(found);
    },

    listJobs: ({ store, query }) => {
      let items = store.jobs;
      const state = query.get("state");
      if (state !== null) items = items.filter((j) => j.state === state);
      const kind = query.get("kind");
      if (kind !== null) items = items.filter((j) => j.kind === kind);
      return ok(page(items));
    },
    getJob: ({ params, store }) => {
      const found = store.job(params["jobId"] ?? "");
      return found === undefined ? notFound("job") : ok(found);
    },
    listJobRuns: ({ params, store }) => ok(page(store.runsFor(params["jobId"] ?? ""))),
    getRun: ({ params, store }) => {
      const found = store.run(params["runId"] ?? "");
      return found === undefined ? notFound("run") : ok(found);
    },

    syncSinceCursor: ({ query, store }) => {
      const limit = Number(query.get("limit") ?? "50");
      return ok(store.sync(query.get("since") ?? undefined, Number.isFinite(limit) ? limit : 50));
    },
  };

  /** Handler coverage is asserted against this in the test suite. */
  operationIds(): readonly string[] {
    return Object.keys(this.handlers);
  }

  // ---------------------------------------------------------------- HTTP ---

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    const method = (req.method ?? "GET").toUpperCase();

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    if (method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }

    // The control plane is never delayed and never faulted: a test needs to be
    // able to turn a fault off even while one is in force.
    if (url.pathname.startsWith("/__mock")) {
      await this.handleControl(method, url, req, res);
      return;
    }

    const effective = mergeScenario(this.scenario, scenarioFromHeaders(req.headers));

    if (effective.offline) {
      // Not an error response — the tunnel simply is not there. Clients take a
      // different path for this than for a server that answered.
      req.destroy();
      return;
    }

    const wait = delayFor(effective, this.rng);
    if (wait > 0) await sleep(wait);

    const decision = nextFault(effective, this.rng);
    // Only a fault drawn from the *global* countdown decrements it. A
    // per-request `X-Mock-Error` sets failNext on its own copy, and letting
    // that write back would silently consume a global "fail the next three"
    // that another test was relying on.
    const perRequestOverride = effective.failNext !== this.scenario.failNext;
    if (!perRequestOverride && decision.scenario.failNext !== this.scenario.failNext) {
      this.scenario = { ...this.scenario, failNext: decision.scenario.failNext };
    }
    if (decision.fault !== undefined) {
      this.log(`${method} ${url.pathname} -> ${decision.fault.status} ${decision.fault.code} (injected)`);
      this.sendError(res, decision.fault.status, {
        code: decision.fault.code,
        message: "Injected by the mock scenario.",
        retryable: decision.fault.retryable,
        details: null,
        retryAfterMs: decision.fault.retryable ? 1000 : null,
      });
      return;
    }

    if (!url.pathname.startsWith(API_BASE)) {
      this.sendError(res, 404, {
        code: "NOT_FOUND",
        message: `Everything is mounted under ${API_BASE}.`,
        retryable: false,
        details: null,
        retryAfterMs: null,
      });
      return;
    }

    const pathname = url.pathname.slice(API_BASE.length) || "/";
    const match = matchRoute(method, pathname);
    if (match === undefined) {
      const exists = pathExists(pathname);
      this.sendError(res, exists ? 405 : 404, {
        code: "NOT_FOUND",
        message: exists
          ? `${pathname} exists, but not for ${method}.`
          : `No route for ${method} ${pathname}.`,
        retryable: false,
        details: null,
        retryAfterMs: null,
      });
      return;
    }

    if (!this.authorised(req, match.route.operationId)) {
      this.sendError(res, 401, {
        code: "UNAUTHORIZED",
        message: "Authorization: Bearer <token> is required.",
        retryable: false,
        details: null,
        retryAfterMs: null,
      });
      return;
    }

    const raw = await readBody(req);
    let body: Record<string, unknown> = {};
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        this.sendError(res, 400, {
          code: "VALIDATION_FAILED",
          message: "Request body was not valid JSON.",
          retryable: false,
          details: null,
          retryAfterMs: null,
        });
        return;
      }
    }

    // ---- idempotency -----------------------------------------------------
    let key: string | undefined;
    if (match.route.idempotent) {
      const header = req.headers["idempotency-key"];
      key = Array.isArray(header) ? header[0] : header;
      if (key === undefined || key.length < 8) {
        this.sendError(res, 400, {
          code: "IDEMPOTENCY_KEY_REQUIRED",
          message: "Idempotency-Key is required on every write, and must be at least 8 characters.",
          retryable: false,
          details: null,
          retryAfterMs: null,
        });
        return;
      }
      const hash = hashOf(method, url.pathname, raw);
      const seen = this.idempotency.get(key);
      if (seen !== undefined) {
        if (seen.hash !== hash) {
          this.sendError(res, 409, {
            code: "IDEMPOTENCY_KEY_REUSE",
            message: "That Idempotency-Key was already used with a different body.",
            retryable: false,
            details: null,
            retryAfterMs: null,
          });
          return;
        }
        // The operation ran once. Replay the stored response.
        this.log(`${method} ${url.pathname} -> ${seen.status} (idempotent replay)`);
        res.setHeader("Idempotency-Replayed", "true");
        this.send(res, seen.status, seen.body);
        return;
      }
    }

    const handler = this.handlers[match.route.operationId];
    if (handler === undefined) {
      this.sendError(res, 501, {
        code: "INTERNAL",
        message: `The mock has no handler for ${match.route.operationId}.`,
        retryable: false,
        details: null,
        retryAfterMs: null,
      });
      return;
    }

    const result = handler({
      params: match.params,
      query: url.searchParams,
      body,
      store: this.store,
      server: this,
    });

    const status = result.ok ? (result.status ?? 200) : result.status;
    const payload = result.ok
      ? { success: true, data: result.data }
      : {
          success: false,
          error: {
            code: result.code,
            message: result.message,
            retryable: false,
            details: null,
            retryAfterMs: null,
          },
        };

    if (key !== undefined && result.ok) {
      this.idempotency.set(key, { hash: hashOf(method, url.pathname, raw), status, body: payload });
    }

    this.log(`${method} ${url.pathname} -> ${status}`);
    this.send(res, status, payload);
  }

  /** `/health` and pairing are the only unauthenticated operations. */
  private authorised(req: IncomingMessage, operationId: string): boolean {
    if (operationId === "getHealth" || operationId === "pairDevice") return true;
    const header = req.headers.authorization;
    return typeof header === "string" && header.toLowerCase().startsWith("bearer ");
  }

  private send(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body, null, 2);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(text),
    });
    res.end(text);
  }

  private sendError(res: ServerResponse, status: number, error: ApiError): void {
    this.send(res, status, { success: false, error });
  }

  // ------------------------------------------------------- control plane ---

  private async handleControl(
    method: string,
    url: URL,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const raw = await readBody(req);
    let body: Record<string, unknown> = {};
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        // These are driven by hand-written curl commands, so a malformed body
        // is the expected kind of mistake, not an exceptional one.
        this.send(res, 400, {
          success: false,
          error: {
            code: "VALIDATION_FAILED",
            message: "Control-plane body was not valid JSON.",
            retryable: false,
            details: null,
            retryAfterMs: null,
          },
        });
        return;
      }
    }

    switch (`${method} ${url.pathname}`) {
      case "GET /__mock/scenario":
        this.send(res, 200, this.scenario);
        return;

      case "POST /__mock/scenario":
        this.scenario = mergeScenario(this.scenario, body as Partial<Scenario>);
        this.log(`scenario: ${JSON.stringify(this.scenario)}`);
        this.send(res, 200, this.scenario);
        return;

      case "DELETE /__mock/scenario":
        this.scenario = DEFAULT_SCENARIO;
        this.send(res, 200, this.scenario);
        return;

      case "POST /__mock/reset":
        this.store.reset();
        this.idempotency.clear();
        this.scenario = DEFAULT_SCENARIO;
        this.send(res, 200, { reset: true });
        return;

      case "POST /__mock/presence": {
        // Unnumbered and unbuffered, exactly as the protocol requires.
        const frame = {
          type: "presence",
          state: (body["state"] as PresenceState) ?? "thinking",
          intensity: typeof body["intensity"] === "number" ? body["intensity"] : 0.5,
          since: nowIso(),
          ttl_ms: typeof body["ttl_ms"] === "number" ? body["ttl_ms"] : 5000,
        };
        this.broadcastUnnumbered(frame);
        this.send(res, 200, frame);
        return;
      }

      case "POST /__mock/broadcast": {
        // Push any frame fixture down the socket, numbered and replayable.
        const name = String(body["fixture"] ?? "ws/server_chat_message");
        const frame = { ...(fixture(name) as Record<string, unknown>) };
        this.broadcastNumbered(frame);
        this.send(res, 200, frame);
        return;
      }

      case "POST /__mock/disconnect": {
        // Drop every socket without a close frame, so clients exercise the
        // reconnect-and-replay path rather than a graceful shutdown.
        const count = this.sockets.size;
        for (const socket of this.sockets) socket.terminate();
        this.sockets.clear();
        this.send(res, 200, { disconnected: count });
        return;
      }

      case "GET /__mock/routes":
        this.send(
          res,
          200,
          specRoutes().map((route) => ({
            operationId: route.operationId,
            method: route.method,
            path: `${API_BASE}${route.template}`,
            idempotent: route.idempotent,
          })),
        );
        return;

      case "GET /__mock/state":
        this.send(res, 200, {
          conversations: this.store.conversations.length,
          messages: this.store.messages.length,
          reminders: this.store.reminders.length,
          todos: this.store.todos.length,
          goals: this.store.goals.length,
          devices: this.store.devices.length,
          deliveries: this.store.deliveries.length,
          jobs: this.store.jobs.length,
          runs: this.store.runs.length,
          pendingChanges: this.store.changeCount(),
          sockets: this.sockets.size,
          lastSeq: this.seq,
        });
        return;

      default:
        this.send(res, 404, {
          success: false,
          error: {
            code: "NOT_FOUND",
            message: `Unknown control endpoint ${method} ${url.pathname}.`,
            retryable: false,
            details: null,
            retryAfterMs: null,
          },
        });
    }
  }

  // ----------------------------------------------------------- WebSocket ---

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    if (url.pathname !== WS_PATH || this.scenario.offline) {
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.onConnection(ws);
    });
  }

  private onConnection(ws: WebSocket): void {
    this.sockets.add(ws);
    let authed = false;

    // The server speaks first. A client that sends auth_response unprompted is
    // answering a challenge it has not seen.
    send(ws, { type: "auth_challenge", nonce: randomNonce(), protocolVersion: PROTOCOL_VERSION });

    ws.on("close", () => this.sockets.delete(ws));
    ws.on("error", () => this.sockets.delete(ws));

    ws.on("message", (raw) => {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(String(raw)) as Record<string, unknown>;
      } catch {
        send(ws, {
          type: "error",
          error: {
            code: "VALIDATION_FAILED",
            message: "Frame was not valid JSON.",
            retryable: false,
            details: null,
            retryAfterMs: null,
          },
          fatal: false,
        });
        return;
      }

      switch (frame["type"]) {
        case "auth_response": {
          if (typeof frame["token"] !== "string" || frame["token"].length === 0) {
            send(ws, {
              type: "error",
              error: {
                code: "UNAUTHORIZED",
                message: "A token is required.",
                retryable: false,
                details: null,
                retryAfterMs: null,
              },
              // Stop reconnecting and re-pair, rather than loop against a wall.
              fatal: true,
            });
            ws.close();
            return;
          }
          authed = true;
          send(ws, {
            type: "connected",
            lastSeq: this.seq,
            serverTime: nowIso(),
            protocolVersion: PROTOCOL_VERSION,
            principal: this.store.principal,
          });
          return;
        }

        case "ping":
          send(ws, { type: "pong", ts: frame["ts"] ?? nowIso(), serverTime: nowIso() });
          return;

        case "sync": {
          if (!authed) return this.rejectUnauthed(ws);
          const sinceSeq = Number(frame["sinceSeq"] ?? 0);
          const oldest = this.replay[0]?.seq ?? this.seq + 1;
          const frames = this.replay.filter((e) => e.seq > sinceSeq).map((e) => e.frame);
          send(ws, {
            type: "sync_response",
            fromSeq: sinceSeq,
            toSeq: this.seq,
            // False when the gap is older than the buffer remembers. A client
            // that ignores this silently misses everything that aged out.
            complete: sinceSeq >= oldest - 1 || this.replay.length === 0,
            frames,
          });
          return;
        }

        case "chat_message": {
          if (!authed) return this.rejectUnauthed(ws);
          const clientId = frame["clientId"];
          const text = frame["text"];
          if (typeof clientId !== "string" || typeof text !== "string") {
            send(ws, {
              type: "error",
              error: {
                code: "VALIDATION_FAILED",
                message: "chat_message requires clientId and text.",
                retryable: false,
                details: null,
                retryAfterMs: null,
              },
              fatal: false,
            });
            return;
          }
          const conversationId =
            typeof frame["conversationId"] === "string"
              ? frame["conversationId"]
              : MockStore.INTERACTIVE_CONVERSATION_ID;
          const { broadcasts } = this.store.sendMessage(conversationId, { clientId, text });
          this.afterSend(broadcasts);
          return;
        }

        default:
          return;
      }
    });
  }

  private rejectUnauthed(ws: WebSocket): void {
    send(ws, {
      type: "error",
      error: {
        code: "UNAUTHORIZED",
        message: "Authenticate before sending anything else.",
        retryable: false,
        details: null,
        retryAfterMs: null,
      },
      fatal: true,
    });
    ws.close();
  }

  /**
   * Broadcast the frames a send produces, wrapped in a plausible presence arc.
   *
   * The presence frames are deliberately not numbered and not buffered, so a
   * client that reconnects mid-arc gets the messages back and does not get a
   * stale `thinking` replayed at it four minutes later.
   */
  afterSend(broadcasts: readonly Broadcast[]): void {
    this.broadcastUnnumbered(presence("thinking", 0.55, 15000));
    for (const broadcast of broadcasts) {
      if (broadcast.kind === "confirmation") {
        const { confirmation } = broadcast;
        this.broadcastNumbered({
          type: "delivery_confirmation",
          ts: nowIso(),
          clientId: confirmation.clientId,
          serverId: confirmation.serverId,
          conversationId: confirmation.conversationId,
          // Both sequences travel: `seq` (added by broadcastNumbered) is this
          // frame's place in the stream, `messageSeq` is the message's place
          // in its conversation. They are different numbers.
          messageSeq: confirmation.seq,
          acceptedAt: confirmation.acceptedAt,
        });
      } else {
        this.broadcastNumbered({ type: "chat_message", ts: nowIso(), message: broadcast.message });
      }
    }
    this.broadcastUnnumbered(presence("speaking", 0.4, 4000));
    this.broadcastUnnumbered(presence("idle", 0.1, 30000));
  }

  /** Number the frame, buffer it for replay, and send it. */
  broadcastNumbered(frame: Record<string, unknown>): void {
    this.seq += 1;
    const numbered = { ...frame, seq: this.seq };
    this.replay.push({ seq: this.seq, frame: numbered });
    while (this.replay.length > REPLAY_BUFFER_SIZE) this.replay.shift();
    for (const socket of this.sockets) send(socket, numbered);
  }

  /** Send without a sequence number and without buffering. Presence only. */
  broadcastUnnumbered(frame: Record<string, unknown>): void {
    for (const socket of this.sockets) send(socket, frame);
  }
}

function presence(state: PresenceState, intensity: number, ttl: number): Record<string, unknown> {
  return { type: "presence", state, intensity, since: nowIso(), ttl_ms: ttl };
}

function send(ws: WebSocket, frame: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
}

function randomNonce(): string {
  return Math.random().toString(16).slice(2, 18).padEnd(16, "0");
}

function hashOf(method: string, path: string, body: string): string {
  return createHash("sha256").update(`${method} ${path}\n${body}`).digest("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Start a mock server. Resolves once it is listening. */
export async function startMockServer(options: MockServerOptions = {}): Promise<MockServer> {
  const server = new MockServer(options);
  await server.listen();
  return server;
}
