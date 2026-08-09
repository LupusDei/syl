import { Router, type Request, type RequestHandler } from "express";

import type { Reminder, ReminderDeliveryState } from "@syl/shared";

import { isId } from "../services/id.js";
import type { IdempotencyStore } from "../services/idempotency.js";
import { PagingError } from "../services/paging.js";
import {
  ReminderError,
  ReminderService,
  type CreateReminderInput,
  type UpdateReminderInput,
} from "../services/reminder-service.js";
import { ApiFailure, sendOk } from "./envelope.js";
import { pageOptionsOf, requireString } from "./devices.js";
import { runIdempotent, sendIdempotent } from "./idempotency.js";

/**
 * Reminders over HTTP.
 *
 * `POST /reminders/{id}/snooze` is the one endpoint here with a hard rule
 * attached: the server must return a strictly later instant, or refuse. The
 * notification action lives on the device; the authority does not, because a
 * phone that is wiped, restored or replaced would take a device-local deferral
 * with it, and a deferral that vanishes is the one outcome this project
 * forbids.
 */

/** Turn a store refusal into the right contract failure. */
function asReminderFailure(error: unknown): never {
  if (error instanceof ReminderError) {
    switch (error.kind) {
      case "rrule_unsupported":
        throw new ApiFailure("RRULE_UNSUPPORTED", error.message, {
          details: { field: "rrule", reason: error.message },
        });
      case "not_later":
        throw new ApiFailure("DEFERRAL_NOT_LATER", error.message, {
          details: { reason: "a deferral must move a reminder strictly later" },
        });
      case "bad_text":
        throw new ApiFailure("VALIDATION_FAILED", error.message, { details: { field: "text" } });
      case "bad_wall_time":
        throw new ApiFailure("VALIDATION_FAILED", error.message, { details: { field: "wallTime" } });
      case "bad_timezone":
        throw new ApiFailure("VALIDATION_FAILED", error.message, { details: { field: "tz" } });
      case "bad_kind":
        throw new ApiFailure("VALIDATION_FAILED", error.message, { details: { field: "kind" } });
      case "bad_schedule":
        throw new ApiFailure("VALIDATION_FAILED", error.message, { details: { field: "date" } });
    }
  }
  if (error instanceof PagingError) {
    throw new ApiFailure("VALIDATION_FAILED", error.message, {
      details: { field: error.kind === "bad_cursor" ? "cursor" : "limit" },
    });
  }
  throw error;
}

function idOf(raw: unknown): string {
  const id = typeof raw === "string" ? raw : "";
  if (!isId(id, "reminder")) throw new ApiFailure("NOT_FOUND", "That is not a reminder id.");
  return id;
}

/** Read an optional string body field, distinguishing absent from null. */
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

function bodyOf(request: Request): Record<string, unknown> {
  const body: unknown = request.body;
  return typeof body === "object" && body !== null
    ? // Safe assertion: guarded above, and every field is re-tested on read.
      (body as Record<string, unknown>)
    : {};
}

export interface ReminderRouterOptions {
  readonly reminders: ReminderService;
  readonly idempotency: IdempotencyStore;
  readonly authenticate: RequestHandler;
}

export function createReminderRouter(options: ReminderRouterOptions): Router {
  const { reminders, idempotency, authenticate } = options;
  const router = Router();

  router.use("/reminders", authenticate);

  router.get("/reminders", (request, response) => {
    const rawState = request.query["state"];
    let state: ReminderDeliveryState | undefined;
    if (rawState !== undefined) {
      const match = ReminderService.states.find((candidate) => candidate === rawState);
      if (match === undefined) {
        throw new ApiFailure("VALIDATION_FAILED", "That is not a reminder delivery state.", {
          details: { field: "state", reason: `must be one of ${ReminderService.states.join(", ")}` },
        });
      }
      state = match;
    }

    const rawDueBefore = request.query["dueBefore"];
    if (rawDueBefore !== undefined && typeof rawDueBefore !== "string") {
      throw new ApiFailure("VALIDATION_FAILED", "dueBefore must appear at most once.", {
        details: { field: "dueBefore", reason: "repeated" },
      });
    }

    try {
      sendOk(
        response,
        reminders.list({
          ...pageOptionsOf(request),
          ...(state === undefined ? {} : { state }),
          ...(rawDueBefore === undefined ? {} : { dueBefore: rawDueBefore }),
        }),
      );
    } catch (error) {
      asReminderFailure(error);
    }
  });

  router.post("/reminders", (request, response) => {
    sendIdempotent(
      response,
      runIdempotent(idempotency, request, () => {
        const body = bodyOf(request);
        const input: CreateReminderInput = {
          text: requireString(body, "text", 2_000),
          wallTime: requireString(body, "wallTime", 5),
          tz: requireString(body, "tz", 64),
          ...(body["kind"] === undefined ? {} : { kind: String(body["kind"]) }),
          date: optionalString(body, "date") ?? null,
          rrule: optionalString(body, "rrule") ?? null,
          todoId: optionalString(body, "todoId") ?? null,
          urgent: body["urgent"] === true,
        };

        try {
          return { status: 201, data: reminders.create(input) };
        } catch (error) {
          asReminderFailure(error);
        }
      }),
    );
  });

  router.get("/reminders/:reminderId", (request, response) => {
    sendOk(response, found(reminders.get(idOf(request.params["reminderId"]))));
  });

  router.patch("/reminders/:reminderId", (request, response) => {
    const id = idOf(request.params["reminderId"]);
    sendIdempotent(
      response,
      runIdempotent(idempotency, request, () => {
        const body = bodyOf(request);
        const patch: UpdateReminderInput = {
          ...(body["text"] === undefined ? {} : { text: requireString(body, "text", 2_000) }),
          ...(body["wallTime"] === undefined
            ? {}
            : { wallTime: requireString(body, "wallTime", 5) }),
          ...(body["tz"] === undefined ? {} : { tz: requireString(body, "tz", 64) }),
          ...(body["rrule"] === undefined ? {} : { rrule: optionalString(body, "rrule") ?? null }),
          ...(body["urgent"] === undefined ? {} : { urgent: body["urgent"] === true }),
        };

        try {
          return { status: 200, data: found(reminders.update(id, patch)) };
        } catch (error) {
          asReminderFailure(error);
        }
      }),
    );
  });

  router.delete("/reminders/:reminderId", (request, response) => {
    const id = idOf(request.params["reminderId"]);
    sendIdempotent(
      response,
      // Cancelled, not deleted. A row that disappears takes its history with
      // it, and the history is what proves nothing was silently dropped.
      runIdempotent(idempotency, request, () => ({ status: 200, data: found(reminders.cancel(id)) })),
    );
  });

  router.post("/reminders/:reminderId/complete", (request, response) => {
    const id = idOf(request.params["reminderId"]);
    sendIdempotent(
      response,
      runIdempotent(idempotency, request, () => ({
        status: 200,
        data: found(reminders.complete(id)),
      })),
    );
  });

  router.post("/reminders/:reminderId/snooze", (request, response) => {
    const id = idOf(request.params["reminderId"]);
    sendIdempotent(
      response,
      runIdempotent(idempotency, request, () => {
        const body = bodyOf(request);
        const until = body["until"];
        const minutes = body["minutes"];

        if (until != null && minutes != null) {
          throw new ApiFailure("VALIDATION_FAILED", "Supply exactly one of until or minutes.", {
            details: { reason: "until and minutes are alternatives" },
          });
        }
        if (until != null && typeof until !== "string") {
          throw new ApiFailure("VALIDATION_FAILED", "until must be an instant.", {
            details: { field: "until" },
          });
        }
        if (minutes != null && typeof minutes !== "number") {
          throw new ApiFailure("VALIDATION_FAILED", "minutes must be a whole number.", {
            details: { field: "minutes" },
          });
        }

        try {
          return {
            status: 200,
            data: found(
              reminders.snooze(id, {
                ...(typeof until === "string" ? { until } : {}),
                ...(typeof minutes === "number" ? { minutes } : {}),
              }),
            ),
          };
        } catch (error) {
          asReminderFailure(error);
        }
      }),
    );
  });

  return router;
}

function found(reminder: Reminder | null): Reminder {
  if (reminder === null) throw new ApiFailure("NOT_FOUND", "There is no such reminder.");
  return reminder;
}
