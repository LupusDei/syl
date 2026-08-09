import { Router, type Request, type RequestHandler } from "express";

import type { SyncResourceType } from "@syl/shared";

import { PagingError } from "../services/paging.js";
import { SYNC_RESOURCE_TYPES, type SyncService } from "../services/sync-service.js";
import { ApiFailure, sendOk } from "./envelope.js";

/**
 * `GET /sync` — the device's catch-up.
 *
 * One read-only route. The whole argument for what this endpoint means, and
 * why it cannot have a conflict, is on `SyncService`; this file is only the
 * translation from a query string to that service and back.
 *
 * There is no `POST /sync`, deliberately. The push half of the device loop is
 * the ordinary write endpoints with their idempotency keys, and giving this
 * endpoint a write side would be inventing a merge problem the architecture
 * does not currently have.
 */

/** Turn a paging refusal into the right contract failure. */
function asSyncFailure(error: unknown): never {
  if (error instanceof PagingError) {
    throw new ApiFailure("VALIDATION_FAILED", error.message, {
      details: { field: error.kind === "bad_cursor" ? "since" : "limit", reason: error.message },
    });
  }
  throw error;
}

/** Read a query parameter that must appear at most once. */
function singleString(request: Request, name: string): string | undefined {
  const raw = request.query[name];
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") {
    throw new ApiFailure("VALIDATION_FAILED", `${name} must appear at most once.`, {
      details: { field: name, reason: "repeated" },
    });
  }
  return raw;
}

/**
 * Read `types`, in either spelling a client might send.
 *
 * OpenAPI's default array serialisation repeats the key (`?types=todo&
 * types=goal`), which Express hands back as an array; a single value arrives
 * as a bare string. A comma-separated list is accepted too, because it is what
 * half the world sends and refusing it teaches nobody anything.
 */
function typesOf(request: Request): readonly SyncResourceType[] | undefined {
  const raw = request.query["types"];
  if (raw === undefined) return undefined;

  const parts: string[] = [];
  for (const value of Array.isArray(raw) ? raw : [raw]) {
    if (typeof value !== "string") {
      throw new ApiFailure("VALIDATION_FAILED", "types must be resource type names.", {
        details: { field: "types" },
      });
    }
    parts.push(...value.split(",").map((part) => part.trim()).filter((part) => part !== ""));
  }

  const chosen: SyncResourceType[] = [];
  for (const part of parts) {
    const match = SYNC_RESOURCE_TYPES.find((candidate) => candidate === part);
    if (match === undefined) {
      throw new ApiFailure("VALIDATION_FAILED", `"${part}" is not a sync resource type.`, {
        details: { field: "types", reason: `must be one of ${SYNC_RESOURCE_TYPES.join(", ")}` },
      });
    }
    // De-duplicated: a repeated type in the query would repeat every change of
    // that type in the response, which a client would then apply twice.
    if (!chosen.includes(match)) chosen.push(match);
  }
  return chosen;
}

export interface SyncRouterOptions {
  readonly sync: SyncService;
  readonly authenticate: RequestHandler;
}

export function createSyncRouter(options: SyncRouterOptions): Router {
  const { sync, authenticate } = options;
  const router = Router();

  router.use("/sync", authenticate);

  router.get("/sync", (request, response) => {
    const since = singleString(request, "since");
    const rawLimit = singleString(request, "limit");
    const limit = rawLimit === undefined ? undefined : Number(rawLimit);
    if (limit !== undefined && !Number.isInteger(limit)) {
      throw new ApiFailure("VALIDATION_FAILED", "limit must be a whole number.", {
        details: { field: "limit", reason: "not a whole number" },
      });
    }
    const types = typesOf(request);

    try {
      sendOk(
        response,
        sync.changes({
          ...(since === undefined ? {} : { since }),
          ...(limit === undefined ? {} : { limit }),
          ...(types === undefined ? {} : { types }),
        }),
      );
    } catch (error) {
      asSyncFailure(error);
    }
  });

  return router;
}
