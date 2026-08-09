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
  /**
   * Rows nothing could be attempted for: no channel, no credentials, no
   * device, or credentials Apple refuses.
   *
   * Separate from `failed` because the two mean opposite things to the job
   * above. A failure is about a notification and is worth escalating; a block
   * is about the machine, will not improve by being retried harder, and must
   * not open a breaker — a breaker that opened here would end every *future*
   * reminder on top of the one already waiting.
   */
  readonly blocked: readonly string[];
  /**
   * Rows the outbox will not attempt again: `failed` or `abandoned`.
   *
   * The one outcome that deserves to be escalated rather than waited out.
   * Everything else here either succeeds later by itself or is waiting on a
   * human; this is the outbox saying it has stopped. Nothing may reach this
   * list from a wrong credential — that is `blocked` — so a breaker fed from it
   * cannot be opened by a misconfiguration.
   */
  readonly exhausted: readonly string[];
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
  const blocked: string[] = [];
  const exhausted: string[] = [];
  const unregistered: string[] = [];

  /**
   * Why this machine cannot send, once Apple has told us.
   *
   * Set the moment Apple refuses the *provider* rather than a notification.
   * Every remaining row in this pass is then held without a request: the answer
   * is a property of the credentials, so it is already known for all of them,
   * and asking Apple once per waiting reminder to be told the same thing is the
   * flood the classifier's `permanent` branch was originally trying to avoid.
   */
  let refusedProvider: string | null = null;

  for (const delivery of outbox.due(now)) {
    if (refusedProvider !== null) {
      outbox.deferBlocked(delivery.id, refusedProvider);
      blocked.push(delivery.id);
      continue;
    }

    // The three branches below are *blocked*, not failed: nothing was sent and
    // nothing refused us. `deferBlocked` holds the row without spending its
    // attempt budget and without leaving the loop spinning every thirty
    // seconds until the environment changes.
    if (delivery.channel !== "apns") {
      // A channel this build does not know about is a deployment state, not a
      // broken notification, and the row must survive until the build that
      // does know arrives.
      outbox.deferBlocked(delivery.id, `This build cannot deliver over "${delivery.channel}".`);
      blocked.push(delivery.id);
      continue;
    }

    if (apns === null) {
      outbox.deferBlocked(delivery.id, "APNs is not configured on this machine.");
      blocked.push(delivery.id);
      continue;
    }

    const targets = devices.targets();
    if (targets.length === 0) {
      // Not an error worth abandoning over: the phone may simply not have
      // registered yet, and the row must still be here when it does.
      outbox.deferBlocked(delivery.id, "No device is registered to receive this.");
      blocked.push(delivery.id);
      continue;
    }

    // The claim is a compare-and-swap. Losing it means another pass already
    // took this row, or the device acknowledged it between `due` and here —
    // either way, sending anyway would be a second notification for one
    // reminder.
    if (outbox.markSending(delivery.id) === null) continue;

    let uniqueId: string | null = null;
    let anyAccepted = false;
    let anyRetryable = false;
    // Per delivery, not per pass. A token unregistered while sending an
    // earlier row says nothing about whether THIS one should be retried.
    let anyUnregistered = false;
    // Apple refused the provider, not the notification. Per delivery for the
    // same reason, and hoisted out of the loop below onto `refusedProvider` so
    // the rest of the pass does not ask again.
    let anyBlocked = false;
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
        anyUnregistered = true;
      }
      if (result.disposition === "retry") anyRetryable = true;
      if (result.disposition === "blocked") anyBlocked = true;
    }

    if (anyAccepted) {
      // Accepted, not delivered. Apple taking the request is not the phone
      // receiving it, and only the device's own acknowledgement closes this.
      outbox.recordAccepted(delivery.id, { apnsUniqueId: uniqueId });
      accepted.push(delivery.id);
      continue;
    }

    if (anyBlocked) {
      // `syl-clc`. Apple refused the credentials, so nothing about this row is
      // wrong and nothing about it may be spent: the attempt is refunded, the
      // row goes back to `pending` with a wait, and it is still here — still
      // reachable by `due` — on the day the Commander fixes the `.p8`.
      //
      // The alternative this replaces classified the same answer `permanent`,
      // which wrote `next_attempt_at = NULL` and made the row unreachable by
      // every future pass after ONE refusal.
      refusedProvider = errors.join("; ");
      outbox.deferBlocked(delivery.id, refusedProvider, { refundAttempt: true });
      blocked.push(delivery.id);
      continue;
    }

    const after = outbox.recordFailure(delivery.id, {
      error: errors.join("; "),
      // A token that was just unregistered is not retryable against that
      // token — but the phone re-registering is exactly the case the outbox
      // exists to survive, so the row waits rather than failing outright.
      retryable: anyRetryable || anyUnregistered,
    });
    failed.push(delivery.id);
    // Asked of the row rather than inferred from the disposition: whether this
    // was the attempt that used the row up is the outbox's judgement, and it
    // owns the ceiling that decides.
    if (after?.state === "failed" || after?.state === "abandoned") exhausted.push(delivery.id);
  }

  return { accepted, failed, blocked, exhausted, unregistered };
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
      // Every reminder a digest stands for, so the device knows what it is
      // holding rather than only that it is holding several. `syl-xvx`: a
      // digest carries no `reminderId` by design, which is what left both
      // notification actions with nothing to name — and this is the field a
      // snooze-all would act on. It matches the set the ack path already
      // closes, so the two can never disagree about what the digest covered.
      ...(delivery.coalescedReminderIds.length === 0
        ? {}
        : { coalescedReminderIds: delivery.coalescedReminderIds }),
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
