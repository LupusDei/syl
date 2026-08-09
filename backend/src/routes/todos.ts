import { Router, type Request, type RequestHandler } from "express";

import type { Todo, TodoStatus } from "@syl/shared";

import { isId } from "../services/id.js";
import type { IdempotencyStore } from "../services/idempotency.js";
import { PagingError } from "../services/paging.js";
import {
  TodoError,
  TodoService,
  type CreateTodoInput,
  type UpdateTodoInput,
} from "../services/todo-service.js";
import { ApiFailure, sendOk } from "./envelope.js";
import { pageOptionsOf, requireString } from "./devices.js";
import { runIdempotent, sendIdempotent } from "./idempotency.js";

/**
 * To-dos over HTTP.
 *
 * `shared/openapi.yaml` has published these five operations since the contract
 * was written and the service answered none of them (`syl-c1m`). The mock
 * derives its routes from the spec, so both clients were built against
 * endpoints that existed only there — the iOS outbox has `createTodo` and
 * `completeTodo` as first-class queued intents.
 *
 * Every write goes through `runIdempotent`. That is not politeness: the phone's
 * outbox retries by design, and `completeTodo` in particular is a call the
 * device will send again after any lost response.
 */

/** Turn a store refusal into the right contract failure. */
function asTodoFailure(error: unknown): never {
  if (error instanceof TodoError) {
    switch (error.kind) {
      case "bad_text":
        throw new ApiFailure("VALIDATION_FAILED", error.message, { details: { field: "text" } });
      case "bad_status":
        throw new ApiFailure("VALIDATION_FAILED", error.message, { details: { field: "status" } });
      case "bad_source":
        throw new ApiFailure("VALIDATION_FAILED", error.message, { details: { field: "source" } });
      case "bad_due_at":
        throw new ApiFailure("VALIDATION_FAILED", error.message, { details: { field: "dueAt" } });
      case "unknown_goal":
        // A body field naming a row that is not there, not a missing resource:
        // answering NOT_FOUND would tell the client the to-do it was creating
        // does not exist, which is both untrue and unactionable.
        throw new ApiFailure("VALIDATION_FAILED", error.message, { details: { field: "goalId" } });
    }
  }
  if (error instanceof PagingError) {
    throw new ApiFailure("VALIDATION_FAILED", error.message, {
      details: { field: error.kind === "bad_cursor" ? "cursor" : "limit", reason: error.message },
    });
  }
  throw error;
}

function idOf(raw: unknown): string {
  const id = typeof raw === "string" ? raw : "";
  if (!isId(id, "todo")) throw new ApiFailure("NOT_FOUND", "That is not a to-do id.");
  return id;
}

function found(todo: Todo | null): Todo {
  if (todo === null) throw new ApiFailure("NOT_FOUND", "There is no such to-do.");
  return todo;
}

function bodyOf(request: Request): Record<string, unknown> {
  const body: unknown = request.body;
  return typeof body === "object" && body !== null
    ? // Safe assertion: guarded above, and every field is re-tested on read.
      (body as Record<string, unknown>)
    : {};
}

/**
 * Read an optional field that distinguishes absent from null.
 *
 * `PATCH /todos/{id}` needs all three answers: leave it alone, clear it, set
 * it. Collapsing absent and null into one would make it impossible to unset a
 * deadline without also being unable to leave one untouched.
 */
function optionalString(body: Record<string, unknown>, field: string): string | null | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new ApiFailure("VALIDATION_FAILED", `${field} must be a string or null.`, {
      details: { field },
    });
  }
  return value;
}

function optionalBoolean(body: Record<string, unknown>, field: string): boolean | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new ApiFailure("VALIDATION_FAILED", `${field} must be true or false.`, {
      details: { field },
    });
  }
  return value;
}

/** Read the `status` query filter, refusing anything outside the enum. */
function statusOf(request: Request): TodoStatus | undefined {
  const raw = request.query["status"];
  if (raw === undefined) return undefined;
  const match = TodoService.statuses.find((candidate) => candidate === raw);
  if (match === undefined) {
    throw new ApiFailure("VALIDATION_FAILED", "That is not a to-do status.", {
      details: { field: "status", reason: `must be one of ${TodoService.statuses.join(", ")}` },
    });
  }
  return match;
}

export interface TodoRouterOptions {
  readonly todos: TodoService;
  readonly idempotency: IdempotencyStore;
  readonly authenticate: RequestHandler;
}

export function createTodoRouter(options: TodoRouterOptions): Router {
  const { todos, idempotency, authenticate } = options;
  const router = Router();

  router.use("/todos", authenticate);

  router.get("/todos", (request, response) => {
    const status = statusOf(request);
    try {
      sendOk(
        response,
        todos.list({ ...pageOptionsOf(request), ...(status === undefined ? {} : { status }) }),
      );
    } catch (error) {
      asTodoFailure(error);
    }
  });

  router.post("/todos", (request, response) => {
    sendIdempotent(
      response,
      runIdempotent(idempotency, request, () => {
        const body = bodyOf(request);
        const input: CreateTodoInput = {
          text: requireString(body, "text", 2_000),
          goalId: optionalString(body, "goalId") ?? null,
          dueAt: optionalString(body, "dueAt") ?? null,
          pinned: optionalBoolean(body, "pinned") ?? false,
          ...(body["source"] === undefined ? {} : { source: String(body["source"]) }),
        };

        try {
          return { status: 201, data: todos.create(input) };
        } catch (error) {
          asTodoFailure(error);
        }
      }),
    );
  });

  router.get("/todos/:todoId", (request, response) => {
    sendOk(response, found(todos.get(idOf(request.params["todoId"]))));
  });

  router.patch("/todos/:todoId", (request, response) => {
    const id = idOf(request.params["todoId"]);
    sendIdempotent(
      response,
      runIdempotent(idempotency, request, () => {
        const body = bodyOf(request);
        const patch: UpdateTodoInput = {
          ...(body["text"] === undefined ? {} : { text: requireString(body, "text", 2_000) }),
          ...(body["goalId"] === undefined ? {} : { goalId: optionalString(body, "goalId") ?? null }),
          ...(body["dueAt"] === undefined ? {} : { dueAt: optionalString(body, "dueAt") ?? null }),
          ...(body["pinned"] === undefined
            ? {}
            : { pinned: optionalBoolean(body, "pinned") ?? false }),
          ...(body["status"] === undefined ? {} : { status: String(body["status"]) }),
        };

        try {
          return { status: 200, data: found(todos.update(id, patch)) };
        } catch (error) {
          asTodoFailure(error);
        }
      }),
    );
  });

  router.post("/todos/:todoId/complete", (request, response) => {
    const id = idOf(request.params["todoId"]);
    sendIdempotent(
      response,
      runIdempotent(idempotency, request, () => ({
        status: 200,
        data: found(todos.complete(id)),
      })),
    );
  });

  return router;
}
