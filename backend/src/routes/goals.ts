import { Router, type Request, type RequestHandler } from "express";

import type { Goal, GoalStatus } from "@syl/shared";

import { GoalError, GoalService, type CreateGoalInput } from "../services/goal-service.js";
import { isId } from "../services/id.js";
import type { IdempotencyStore } from "../services/idempotency.js";
import { PagingError } from "../services/paging.js";
import { ApiFailure, sendOk } from "./envelope.js";
import { pageOptionsOf, requireString } from "./devices.js";
import { runIdempotent, sendIdempotent } from "./idempotency.js";

/**
 * Goals over HTTP.
 *
 * Three operations, exactly as the contract publishes them: list, create, get.
 * There is deliberately no `PATCH /goals/{id}` — the contract does not declare
 * one, and adding a route the spec does not describe is the same divergence
 * this file exists to close, pointing the other way.
 */

/** Turn a store refusal into the right contract failure. */
function asGoalFailure(error: unknown): never {
  if (error instanceof GoalError) {
    switch (error.kind) {
      case "bad_title":
        throw new ApiFailure("VALIDATION_FAILED", error.message, { details: { field: "title" } });
      case "bad_why":
        throw new ApiFailure("VALIDATION_FAILED", error.message, { details: { field: "why" } });
      case "bad_status":
        throw new ApiFailure("VALIDATION_FAILED", error.message, { details: { field: "status" } });
      case "bad_target_date":
        throw new ApiFailure("VALIDATION_FAILED", error.message, {
          details: { field: "targetDate" },
        });
      case "bad_cadence":
        throw new ApiFailure("VALIDATION_FAILED", error.message, {
          details: { field: "cadenceDays" },
        });
      case "unknown_parent":
        throw new ApiFailure("VALIDATION_FAILED", error.message, { details: { field: "parentId" } });
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
  if (!isId(id, "goal")) throw new ApiFailure("NOT_FOUND", "That is not a goal id.");
  return id;
}

function found(goal: Goal | null): Goal {
  if (goal === null) throw new ApiFailure("NOT_FOUND", "There is no such goal.");
  return goal;
}

function bodyOf(request: Request): Record<string, unknown> {
  const body: unknown = request.body;
  return typeof body === "object" && body !== null
    ? // Safe assertion: guarded above, and every field is re-tested on read.
      (body as Record<string, unknown>)
    : {};
}

function optionalString(body: Record<string, unknown>, field: string): string | null {
  const value = body[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new ApiFailure("VALIDATION_FAILED", `${field} must be a string or null.`, {
      details: { field },
    });
  }
  return value;
}

function optionalInteger(body: Record<string, unknown>, field: string): number | null {
  const value = body[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number") {
    throw new ApiFailure("VALIDATION_FAILED", `${field} must be a whole number or null.`, {
      details: { field },
    });
  }
  return value;
}

/** Read the `status` query filter, refusing anything outside the enum. */
function statusOf(request: Request): GoalStatus | undefined {
  const raw = request.query["status"];
  if (raw === undefined) return undefined;
  const match = GoalService.statuses.find((candidate) => candidate === raw);
  if (match === undefined) {
    throw new ApiFailure("VALIDATION_FAILED", "That is not a goal status.", {
      details: { field: "status", reason: `must be one of ${GoalService.statuses.join(", ")}` },
    });
  }
  return match;
}

export interface GoalRouterOptions {
  readonly goals: GoalService;
  readonly idempotency: IdempotencyStore;
  readonly authenticate: RequestHandler;
}

export function createGoalRouter(options: GoalRouterOptions): Router {
  const { goals, idempotency, authenticate } = options;
  const router = Router();

  router.use("/goals", authenticate);

  router.get("/goals", (request, response) => {
    const status = statusOf(request);
    try {
      sendOk(
        response,
        goals.list({ ...pageOptionsOf(request), ...(status === undefined ? {} : { status }) }),
      );
    } catch (error) {
      asGoalFailure(error);
    }
  });

  router.post("/goals", (request, response) => {
    sendIdempotent(
      response,
      runIdempotent(idempotency, request, () => {
        const body = bodyOf(request);
        const input: CreateGoalInput = {
          title: requireString(body, "title", 500),
          parentId: optionalString(body, "parentId"),
          why: optionalString(body, "why"),
          targetDate: optionalString(body, "targetDate"),
          cadenceDays: optionalInteger(body, "cadenceDays"),
          ...(body["status"] === undefined ? {} : { status: String(body["status"]) }),
        };

        try {
          return { status: 201, data: goals.create(input) };
        } catch (error) {
          asGoalFailure(error);
        }
      }),
    );
  });

  router.get("/goals/:goalId", (request, response) => {
    sendOk(response, found(goals.get(idOf(request.params["goalId"]))));
  });

  return router;
}
