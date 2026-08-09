import type { Delivery } from "@syl/shared";

import type { ApnsNotification, ApnsResult } from "../services/apns-service.js";
import type { DeviceTokenService } from "../services/device-token-service.js";
import type { Outbox } from "../services/outbox.js";

/**
 * Drain the outbox to Apple.
 *
 * Also a zero-turn path — no model, no subprocess. The only thing this decides
 * is what an APNs answer means, and it deliberately decides as little as
 * possible: the outbox owns retry, the device store owns unregistering, and
 * the sender owns the wire.
 *
 * The notification carries the delivery id as a custom key. That is the
 * mechanism by which the guarantee closes: the device reads it, calls
 * `POST /deliveries/{id}/ack`, and only then is the row delivered. Without it
 * the ack would have nothing to name.
 */

/** Just enough of the APNs client for this job to be tested without one. */
export interface ApnsSender {
  send(notification: ApnsNotification): Promise<ApnsResult>;
}

export interface PushOutboxDeps {
  readonly outbox: Outbox;
  readonly devices: DeviceTokenService;
  /** `null` when APNs is not configured on this machine. */
  readonly apns: ApnsSender | null;
}

/** What one drain did. */
export interface PushOutboxResult {
  readonly accepted: readonly string[];
  readonly failed: readonly string[];
  /** Tokens Apple told us are gone. Unregistered on the spot. */
  readonly unregistered: readonly string[];
}

/**
 * Attempt every delivery whose moment has come.
 *
 * Sequential rather than parallel. One persistent HTTP/2 session multiplexes
 * fine, but the outbox is a single-writer SQLite table and the volume here is
 * a handful of notifications a day; concurrency would buy nothing and cost the
 * ability to reason about ordering.
 */
export async function pushDueDeliveries(
  deps: PushOutboxDeps,
  now?: number,
): Promise<PushOutboxResult> {
  const { outbox, devices, apns } = deps;

  const accepted: string[] = [];
  const failed: string[] = [];
  const unregistered: string[] = [];

  for (const delivery of outbox.due(now)) {
    if (delivery.channel !== "apns") {
      // Retryable rather than permanent: a channel this build does not know
      // about is a deployment state, not a broken notification, and the row
      // must survive until the build that does know arrives.
      outbox.recordFailure(delivery.id, {
        error: `This build cannot deliver over "${delivery.channel}".`,
        retryable: true,
      });
      failed.push(delivery.id);
      continue;
    }

    if (apns === null) {
      outbox.recordFailure(delivery.id, {
        error: "APNs is not configured on this machine.",
        retryable: true,
      });
      failed.push(delivery.id);
      continue;
    }

    const targets = devices.targets();
    if (targets.length === 0) {
      // Not an error worth abandoning over: the phone may simply not have
      // registered yet, and the row must still be here when it does.
      outbox.recordFailure(delivery.id, {
        error: "No device is registered to receive this.",
        retryable: true,
      });
      failed.push(delivery.id);
      continue;
    }

    outbox.markSending(delivery.id);

    let uniqueId: string | null = null;
    let anyAccepted = false;
    let anyRetryable = false;
    const errors: string[] = [];

    for (const target of targets) {
      const result = await apns.send(notificationFor(delivery, target.token, target.environment));

      if (result.ok) {
        anyAccepted = true;
        uniqueId = uniqueId ?? result.apnsUniqueId;
        devices.touch(target.deviceId);
        continue;
      }

      errors.push(`${target.token.slice(-8)}: APNs ${result.status} ${result.reason}`);
      if (result.disposition === "unregister") {
        devices.deactivateByToken(target.token);
        unregistered.push(target.deviceId);
      }
      if (result.disposition === "retry") anyRetryable = true;
    }

    if (anyAccepted) {
      // Accepted, not delivered. Apple taking the request is not the phone
      // receiving it, and only the device's own acknowledgement closes this.
      outbox.recordAccepted(delivery.id, { apnsUniqueId: uniqueId });
      accepted.push(delivery.id);
      continue;
    }

    outbox.recordFailure(delivery.id, {
      error: errors.join("; "),
      // A token that was just unregistered is not retryable against that
      // token — but the phone re-registering is exactly the case the outbox
      // exists to survive, so the row waits rather than failing outright.
      retryable: anyRetryable || unregistered.length > 0,
    });
    failed.push(delivery.id);
  }

  return { accepted, failed, unregistered };
}

/** Turn an outbox row into a notification. */
export function notificationFor(
  delivery: Delivery,
  token: string,
  environment: "sandbox" | "production",
): ApnsNotification {
  return {
    token,
    environment,
    payload: delivery.payload,
    // The device needs this to acknowledge, and the acknowledgement is the
    // only evidence of delivery that exists.
    data: {
      deliveryId: delivery.id,
      ...(delivery.reminderId === null ? {} : { reminderId: delivery.reminderId }),
    },
    // Our own id, so a retry is recognisably the same notification to Apple
    // rather than a second one.
    apnsId: apnsIdFor(delivery.id),
  };
}

/**
 * A stable UUID for a delivery, so retrying sends the same `apns-id`.
 *
 * Our ids are `syl:delivery:<uuidv7>`, so the UUID is already in there and
 * there is nothing to derive.
 */
export function apnsIdFor(deliveryId: string): string {
  const parts = deliveryId.split(":");
  return parts[2] ?? deliveryId;
}
