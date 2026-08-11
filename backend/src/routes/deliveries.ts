import { Router, type RequestHandler } from "express";

import type { DeliveryEngagement, DeliveryState } from "@syl/shared";

import { parseInstant } from "../services/clock.js";
import { isId } from "../services/id.js";
import type { IdempotencyStore } from "../services/idempotency.js";
import type { Outbox } from "../services/outbox.js";
import type { ReminderService } from "../services/reminder-service.js";
import { ApiFailure, sendOk } from "./envelope.js";
import { asDeviceFailure, pageOptionsOf } from "./devices.js";
import { runIdempotent, sendIdempotent } from "./idempotency.js";

/**
 * The outbox, over HTTP.
 *
 * `POST /deliveries/{id}/ack` is the load-bearing endpoint of the whole
 * delivery guarantee. APNs cannot tell us whether a notification arrived, so
 * `deliveredAt` only ever means "Apple accepted the request". The device
 * saying so is the only evidence that exists, and this is where it arrives.
 */

const STATES: readonly DeliveryState[] = [
  "pending",
  "sending",
  "delivered",
  "acknowledged",
  "failed",
  "abandoned",
];

const ENGAGEMENTS: readonly DeliveryEngagement[] = [
  "delivered",
  "opened",
  "acted_on",
  "dismissed",
  "ignored",
];

export interface DeliveryRouterOptions {
  readonly outbox: Outbox;
  /** So an acknowledgement closes the loop on the reminder as well. */
  readonly reminders: ReminderService;
  readonly idempotency: IdempotencyStore;
  readonly authenticate: RequestHandler;
}

export function createDeliveryRouter(options: DeliveryRouterOptions): Router {
  const { outbox, reminders, idempotency, authenticate } = options;
  const router = Router();

  router.use("/deliveries", authenticate);

  router.get("/deliveries", (request, response) => {
    const rawState = request.query["state"];
    let state: DeliveryState | undefined;
    if (rawState !== undefined) {
      const match = STATES.find((candidate) => candidate === rawState);
      if (match === undefined) {
        throw new ApiFailure("VALIDATION_FAILED", "That is not a delivery state.", {
          details: { field: "state", reason: `must be one of ${STATES.join(", ")}` },
        });
      }
      state = match;
    }

    const rawUnacked = request.query["unacknowledged"];
    if (rawUnacked !== undefined && rawUnacked !== "true" && rawUnacked !== "false") {
      throw new ApiFailure("VALIDATION_FAILED", "unacknowledged must be true or false.", {
        details: { field: "unacknowledged", reason: "must be a boolean" },
      });
    }

    try {
      sendOk(
        response,
        outbox.list({
          ...pageOptionsOf(request),
          ...(state === undefined ? {} : { state }),
          ...(rawUnacked === "true" ? { unacknowledged: true } : {}),
        }),
      );
    } catch (error) {
      asDeviceFailure(error);
    }
  });

  router.get("/deliveries/:deliveryId", (request, response) => {
    sendOk(response, deliveryOr404(outbox, idOf(request.params["deliveryId"])));
  });

  router.post("/deliveries/:deliveryId/ack", (request, response) => {
    const id = idOf(request.params["deliveryId"]);

    sendIdempotent(
      response,
      runIdempotent(idempotency, request, () => {
        deliveryOr404(outbox, id);

        const body: unknown = request.body;
        const raw =
          typeof body === "object" && body !== null
            ? // Safe assertion: guarded above, and every field is re-tested.
              (body as Record<string, unknown>)
            : {};

        const ackedAt = raw["ackedAt"];
        if (typeof ackedAt !== "string" || parseInstant(ackedAt) === null) {
          throw new ApiFailure("VALIDATION_FAILED", "ackedAt must be an RFC 3339 UTC instant.", {
            details: { field: "ackedAt", reason: "e.g. 2026-08-09T21:00:07.220Z" },
          });
        }

        const rawEngagement = raw["engagement"];
        let engagement: DeliveryEngagement | undefined;
        if (rawEngagement !== undefined) {
          const match = ENGAGEMENTS.find((candidate) => candidate === rawEngagement);
          if (match === undefined) {
            throw new ApiFailure("VALIDATION_FAILED", "That is not an engagement.", {
              details: { field: "engagement", reason: `must be one of ${ENGAGEMENTS.join(", ")}` },
            });
          }
          engagement = match;
        }

        // Acknowledging twice is a no-op that returns the existing row: the
        // device retries this call by design, and the first instant is the one
        // that is true.
        const acknowledged = outbox.acknowledge(id, {
          ackedAt,
          ...(engagement === undefined ? {} : { engagement }),
        });
        if (acknowledged === null) throw new ApiFailure("NOT_FOUND", "There is no such delivery.");

        // Close the loop on the reminders this notification stood for. A
        // coalesced digest stands for several, and every one of them has been
        // seen the moment the device says the digest was.
        const covered =
          acknowledged.reminderId === null
            ? acknowledged.coalescedReminderIds
            : [acknowledged.reminderId, ...acknowledged.coalescedReminderIds];
        for (const reminderId of covered) reminders.markAcknowledged(reminderId);

        return { status: 200, data: acknowledged };
      }),
    );
  });

  return router;
}

function idOf(raw: unknown): string {
  const id = typeof raw === "string" ? raw : "";
  if (!isId(id, "delivery")) throw new ApiFailure("NOT_FOUND", "That is not a delivery id.");
  return id;
}

function deliveryOr404(outbox: Outbox, id: string): ReturnType<Outbox["get"]> {
  const delivery = outbox.get(id);
  if (delivery === null) throw new ApiFailure("NOT_FOUND", "There is no such delivery.");
  return delivery;
}
