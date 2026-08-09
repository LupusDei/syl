/**
 * What the outbox actually says, as pure functions.
 *
 * The whole viewer turns on one distinction the contract is emphatic about:
 *
 * > `deliveredAt` means "APNs accepted the request". Only `ackedAt` — set by
 * > this call, from the device — marks the row delivered.
 *
 * APNs cannot tell us whether a notification arrived, and while a device is
 * offline Apple keeps only the *most recent* notification per app, so a night
 * of reminders can collapse into one. A viewer that treats `delivered` as
 * done would therefore show a green screen for a night the Commander never
 * heard about — which is the exact failure this surface exists to catch.
 *
 * So: **a row is confirmed only when it has been acknowledged**, and every
 * count, tone and sort below is built on that and nothing else.
 */

import type { Delivery, DeliveryState } from "@syl/shared/types";

import { elapsedMs } from "../../format/time";
import { humanise } from "../../format/text";
import type { Tone } from "../../ui/Badge";

/**
 * Exhaustive by construction: a state added to the contract fails typecheck
 * here rather than quietly dropping out of the filter.
 */
const DELIVERY_STATE_SET: Record<DeliveryState, true> = {
  pending: true,
  sending: true,
  delivered: true,
  acknowledged: true,
  failed: true,
  abandoned: true,
};

// Safe: the keys of an exhaustive `Record<DeliveryState, …>`.
export const DELIVERY_STATES = Object.keys(DELIVERY_STATE_SET) as readonly DeliveryState[];

/**
 * Where a row stands against the never-drop guarantee. This is the only
 * classification the viewer uses; `state` is shown but never trusted to mean
 * "arrived".
 */
export type Standing =
  /** The device said it got it. The only value that satisfies the guarantee. */
  | "acknowledged"
  /** Nobody is retrying this any more and it was never acknowledged. */
  | "abandoned"
  /** APNs accepted it and the device has still not confirmed. */
  | "awaiting_ack"
  /** Still being attempted. */
  | "in_flight";

export function standingOf(delivery: Delivery): Standing {
  if (delivery.ackedAt !== null) return "acknowledged";
  if (delivery.state === "abandoned" || delivery.state === "failed") return "abandoned";
  if (delivery.deliveredAt !== null) return "awaiting_ack";
  return "in_flight";
}

/** True for anything that has not been acknowledged, whatever its state. */
export function isUnconfirmed(delivery: Delivery): boolean {
  return delivery.ackedAt === null;
}

const STANDING_TONE: Record<Standing, Tone> = {
  acknowledged: "ok",
  abandoned: "fail",
  awaiting_ack: "warn",
  in_flight: "pending",
};

export function standingTone(standing: Standing): Tone {
  return STANDING_TONE[standing];
}

const STANDING_LABEL: Record<Standing, string> = {
  acknowledged: "acknowledged",
  abandoned: "never confirmed",
  awaiting_ack: "unconfirmed",
  in_flight: "in flight",
};

export function standingLabel(standing: Standing): string {
  return STANDING_LABEL[standing];
}

export function deliveryStateTone(state: DeliveryState): Tone {
  switch (state) {
    case "acknowledged":
      return "ok";
    case "failed":
    case "abandoned":
      return "fail";
    case "delivered":
      // Deliberately not "ok". APNs accepting a request is not arrival.
      return "warn";
    default:
      return "pending";
  }
}

export interface OutboxSummary {
  readonly total: number;
  readonly acknowledged: number;
  readonly awaitingAck: number;
  readonly inFlight: number;
  readonly abandoned: number;
  /** Everything that is not acknowledged. The number that matters. */
  readonly unconfirmed: number;
}

export function summariseOutbox(items: readonly Delivery[]): OutboxSummary {
  let acknowledged = 0;
  let awaitingAck = 0;
  let inFlight = 0;
  let abandoned = 0;

  for (const delivery of items) {
    switch (standingOf(delivery)) {
      case "acknowledged":
        acknowledged += 1;
        break;
      case "awaiting_ack":
        awaitingAck += 1;
        break;
      case "abandoned":
        abandoned += 1;
        break;
      default:
        inFlight += 1;
    }
  }

  return {
    total: items.length,
    acknowledged,
    awaitingAck,
    inFlight,
    abandoned,
    unconfirmed: awaitingAck + inFlight + abandoned,
  };
}

export function summaryTone(summary: OutboxSummary): Tone {
  if (summary.abandoned > 0) return "fail";
  if (summary.awaitingAck > 0) return "warn";
  if (summary.inFlight > 0) return "pending";
  return "ok";
}

/**
 * The banner sentence.
 *
 * It leads with the count that would otherwise be missed, and it never says
 * "delivered" about something that has not been acknowledged.
 */
export function summaryHeadline(summary: OutboxSummary): string {
  if (summary.total === 0) return "Nothing in the outbox.";
  if (summary.abandoned > 0) {
    return `${summary.abandoned} of ${summary.total} were never confirmed and nothing is retrying them.`;
  }
  if (summary.awaitingAck > 0) {
    return `${summary.awaitingAck} of ${summary.total} reached APNs and have not been acknowledged.`;
  }
  if (summary.inFlight > 0) {
    return `${summary.inFlight} of ${summary.total} are still being attempted.`;
  }
  return `All ${summary.total} acknowledged by the device.`;
}

const STANDING_ORDER: Record<Standing, number> = {
  abandoned: 0,
  awaiting_ack: 1,
  in_flight: 2,
  acknowledged: 3,
};

/**
 * Worst first, then oldest first inside each group.
 *
 * Oldest rather than newest is deliberate: the row that has gone unconfirmed
 * longest is the one most likely to be a real drop, and burying it under
 * today's traffic is how a guarantee quietly stops holding.
 */
export function sortDeliveries(items: readonly Delivery[]): Delivery[] {
  return [...items].sort((a, b) => {
    const byStanding = STANDING_ORDER[standingOf(a)] - STANDING_ORDER[standingOf(b)];
    if (byStanding !== 0) return byStanding;
    return a.createdAt.localeCompare(b.createdAt);
  });
}

/** How long a row has gone unacknowledged, or `null` once it has been. */
export function unconfirmedForMs(delivery: Delivery, now: Date): number | null {
  if (delivery.ackedAt !== null) return null;
  const since = delivery.deliveredAt ?? delivery.scheduledFor ?? delivery.createdAt;
  return elapsedMs(since, now.toISOString());
}

/** How long the device took to confirm, once it has. */
export function ackLatencyMs(delivery: Delivery): number | null {
  return elapsedMs(delivery.deliveredAt, delivery.ackedAt);
}

/**
 * What the row says about the interruption ledger. `null` engagement on an
 * acknowledged row is a real answer — the device confirmed and the Commander
 * did nothing with it — so it is shown rather than left blank.
 */
export function describeEngagement(delivery: Delivery): string {
  if (delivery.engagement !== null) return humanise(delivery.engagement);
  return delivery.ackedAt === null ? "—" : "no signal";
}

/**
 * A coalesced row stands for several reminders. The count matters because
 * Apple's "most recent notification only" behaviour is precisely why
 * coalescing exists — and because one acknowledgement then covers several
 * commitments.
 */
export function coalescedCount(delivery: Delivery): number {
  return delivery.coalescedReminderIds.length;
}
