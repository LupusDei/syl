import { Router, type Request, type RequestHandler } from "express";

import { DeviceTokenError, type DeviceTokenService } from "../services/device-token-service.js";
import type { IdempotencyStore } from "../services/idempotency.js";
import { isId } from "../services/id.js";
import { PagingError } from "../services/paging.js";
import { ApiFailure, sendOk } from "./envelope.js";
import { runIdempotent, sendIdempotent } from "./idempotency.js";

/**
 * Push targets.
 *
 * The app calls `POST /devices` on every launch and after every token
 * rotation, so this endpoint is hit far more often than a device is actually
 * new. Re-registration updates in place; the idempotency key covers the
 * retries the client's own outbox generates on top of that.
 */

/** Turn a store refusal into the right contract failure. */
export function asDeviceFailure(error: unknown): never {
  if (error instanceof DeviceTokenError) {
    if (error.kind === "bad_token") {
      throw new ApiFailure("DEVICE_TOKEN_INVALID", error.message, {
        details: { field: "token", reason: "not a hexadecimal APNs device token" },
      });
    }
    throw new ApiFailure("VALIDATION_FAILED", error.message, {
      details: { field: error.kind === "bad_environment" ? "environment" : "platform" },
    });
  }
  if (error instanceof PagingError) {
    throw new ApiFailure("VALIDATION_FAILED", error.message, {
      details: { field: error.kind === "bad_cursor" ? "cursor" : "limit", reason: error.message },
    });
  }
  throw error;
}

/** Read `cursor` and `limit` off a query string, refusing repeats. */
export function pageOptionsOf(request: Request): { cursor?: string; limit?: number } {
  const rawCursor = request.query["cursor"];
  const rawLimit = request.query["limit"];

  if (rawCursor !== undefined && typeof rawCursor !== "string") {
    throw new ApiFailure("VALIDATION_FAILED", "cursor must appear at most once.", {
      details: { field: "cursor", reason: "repeated" },
    });
  }
  if (rawLimit !== undefined && typeof rawLimit !== "string") {
    throw new ApiFailure("VALIDATION_FAILED", "limit must appear at most once.", {
      details: { field: "limit", reason: "repeated" },
    });
  }

  const limit = rawLimit === undefined ? undefined : Number(rawLimit);
  if (limit !== undefined && !Number.isInteger(limit)) {
    throw new ApiFailure("VALIDATION_FAILED", "limit must be a whole number.", {
      details: { field: "limit", reason: "not a whole number" },
    });
  }

  return {
    ...(rawCursor === undefined ? {} : { cursor: rawCursor }),
    ...(limit === undefined ? {} : { limit }),
  };
}

/** Read a required string body field. */
export function requireString(body: unknown, field: string, maxLength = 512): string {
  const value =
    typeof body === "object" && body !== null
      ? // Safe assertion: guarded above, and the value is re-tested.
        (body as Record<string, unknown>)[field]
      : undefined;

  if (typeof value !== "string" || value.trim() === "") {
    throw new ApiFailure("VALIDATION_FAILED", `${field} is required.`, {
      details: { field, reason: "must be a non-empty string" },
    });
  }
  if (value.length > maxLength) {
    throw new ApiFailure("VALIDATION_FAILED", `${field} is too long.`, {
      details: { field, reason: `must be at most ${maxLength} characters` },
    });
  }
  return value;
}

export interface DeviceRouterOptions {
  readonly devices: DeviceTokenService;
  readonly idempotency: IdempotencyStore;
  readonly authenticate: RequestHandler;
}

export function createDeviceRouter(options: DeviceRouterOptions): Router {
  const { devices, idempotency, authenticate } = options;
  const router = Router();

  router.use("/devices", authenticate);

  router.get("/devices", (request, response) => {
    try {
      sendOk(response, devices.list(pageOptionsOf(request)));
    } catch (error) {
      asDeviceFailure(error);
    }
  });

  router.post("/devices", (request, response) => {
    sendIdempotent(
      response,
      runIdempotent(idempotency, request, () => {
        try {
          const result = devices.register({
            token: requireString(request.body, "token", 256),
            environment: requireString(request.body, "environment", 32),
            platform: requireString(request.body, "platform", 32),
            name: requireString(request.body, "name", 128),
            appVersion: requireString(request.body, "appVersion", 64),
            osVersion: requireString(request.body, "osVersion", 64),
          });
          // 201 for both: from the client's point of view the device is
          // registered either way, and it has no use for the distinction.
          return { status: 201, data: result.device };
        } catch (error) {
          asDeviceFailure(error);
        }
      }),
    );
  });

  router.delete("/devices/:deviceId", (request, response) => {
    const raw = request.params["deviceId"];
    const id = typeof raw === "string" ? raw : "";
    if (!isId(id, "device")) throw new ApiFailure("NOT_FOUND", "That is not a device id.");

    sendIdempotent(
      response,
      runIdempotent(idempotency, request, () => {
        const device = devices.deactivate(id);
        if (device === null) throw new ApiFailure("NOT_FOUND", "There is no such device.");
        return { status: 200, data: device };
      }),
    );
  });

  return router;
}
