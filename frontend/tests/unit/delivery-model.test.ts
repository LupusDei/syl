import { describe, expect, it } from "vitest";

import type { Delivery, DeliveryPage, Ok } from "@syl/shared/types";

import {
  ackLatencyMs,
  coalescedCount,
  DELIVERY_STATES,
  deliveryStateTone,
  describeEngagement,
  isUnconfirmed,
  sortDeliveries,
  standingLabel,
  standingOf,
  standingTone,
  summariseOutbox,
  summaryHeadline,
  summaryTone,
  unconfirmedForMs,
} from "../../src/features/delivery/delivery-model";
import { fixture } from "../helpers/fixtures";

const outbox: readonly Delivery[] = (fixture("http/deliveries.page") as Ok<DeliveryPage>).data.items;

function withState(state: Delivery["state"]): Delivery {
  const found = outbox.find((delivery) => delivery.state === state);
  if (found === undefined) throw new Error(`no ${state} row in the fixture`);
  return found;
}

const acknowledged = withState("acknowledged");
const deliveredNotAcked = withState("delivered");
const retrying = withState("pending");

describe("DELIVERY_STATES", () => {
  it("should offer every state the contract defines, once each", () => {
    expect(DELIVERY_STATES).toContain("abandoned");
    expect(new Set(DELIVERY_STATES).size).toBe(DELIVERY_STATES.length);
  });
});

describe("standingOf", () => {
  it("should treat only an acknowledgement as confirmation", () => {
    expect(standingOf(acknowledged)).toBe("acknowledged");
  });

  it("should call a delivered-but-unacknowledged row unconfirmed", () => {
    // APNs accepted it. The device never said it arrived. Those are different
    // facts, and conflating them is how a night of missed reminders looks
    // green.
    expect(standingOf(deliveredNotAcked)).toBe("awaiting_ack");
    expect(standingLabel(standingOf(deliveredNotAcked))).toBe("unconfirmed");
  });

  it("should call a row still being attempted in flight", () => {
    expect(standingOf(retrying)).toBe("in_flight");
  });

  it("should call failed and abandoned rows never confirmed", () => {
    expect(standingOf({ ...retrying, state: "failed" })).toBe("abandoned");
    expect(standingOf({ ...retrying, state: "abandoned" })).toBe("abandoned");
    expect(standingLabel("abandoned")).toBe("never confirmed");
  });

  it("should keep an acknowledgement even on a row the server calls failed", () => {
    // The ack is the ground truth; a state that disagrees does not undo it.
    expect(standingOf({ ...acknowledged, state: "failed" })).toBe("acknowledged");
  });
});

describe("isUnconfirmed", () => {
  it("should be true for anything with no ackedAt, whatever the state says", () => {
    expect(isUnconfirmed(deliveredNotAcked)).toBe(true);
    expect(isUnconfirmed(retrying)).toBe(true);
    expect(isUnconfirmed(acknowledged)).toBe(false);
  });
});

describe("tones", () => {
  it("should never colour an unconfirmed row as success", () => {
    expect(standingTone("acknowledged")).toBe("ok");
    expect(standingTone("awaiting_ack")).toBe("warn");
    expect(standingTone("abandoned")).toBe("fail");
    expect(standingTone("in_flight")).toBe("pending");
  });

  it("should refuse to colour `delivered` as success", () => {
    expect(deliveryStateTone("delivered")).toBe("warn");
    expect(deliveryStateTone("acknowledged")).toBe("ok");
    expect(deliveryStateTone("failed")).toBe("fail");
    expect(deliveryStateTone("abandoned")).toBe("fail");
    expect(deliveryStateTone("pending")).toBe("pending");
    expect(deliveryStateTone("sending")).toBe("pending");
  });
});

describe("summariseOutbox", () => {
  it("should count the shipped page by standing", () => {
    const summary = summariseOutbox(outbox);
    expect(summary.total).toBe(3);
    expect(summary.acknowledged).toBe(1);
    expect(summary.awaitingAck).toBe(1);
    expect(summary.inFlight).toBe(1);
    expect(summary.abandoned).toBe(0);
    expect(summary.unconfirmed).toBe(2);
  });

  it("should count an abandoned row", () => {
    const summary = summariseOutbox([...outbox, { ...retrying, state: "abandoned" }]);
    expect(summary.abandoned).toBe(1);
    expect(summary.unconfirmed).toBe(3);
  });

  it("should handle an empty outbox", () => {
    expect(summariseOutbox([]).unconfirmed).toBe(0);
  });
});

describe("summaryTone", () => {
  it("should escalate to failure the moment anything was abandoned", () => {
    expect(summaryTone(summariseOutbox([{ ...retrying, state: "abandoned" }]))).toBe("fail");
  });

  it("should warn while anything reached APNs unacknowledged", () => {
    expect(summaryTone(summariseOutbox([deliveredNotAcked]))).toBe("warn");
  });

  it("should stay pending while work is still in flight", () => {
    expect(summaryTone(summariseOutbox([retrying]))).toBe("pending");
  });

  it("should only be ok when every row was acknowledged", () => {
    expect(summaryTone(summariseOutbox([acknowledged]))).toBe("ok");
    expect(summaryTone(summariseOutbox([]))).toBe("ok");
  });
});

describe("summaryHeadline", () => {
  it("should lead with the count that would otherwise be missed", () => {
    expect(summaryHeadline(summariseOutbox([{ ...retrying, state: "abandoned" }]))).toContain(
      "never confirmed",
    );
    expect(summaryHeadline(summariseOutbox([deliveredNotAcked]))).toContain("not been acknowledged");
    expect(summaryHeadline(summariseOutbox([retrying]))).toContain("still being attempted");
  });

  it("should never say delivered about something unacknowledged", () => {
    const headline = summaryHeadline(summariseOutbox(outbox));
    expect(headline).not.toMatch(/\bdelivered\b/);
  });

  it("should say so plainly when everything is confirmed, or empty", () => {
    expect(summaryHeadline(summariseOutbox([acknowledged]))).toBe(
      "All 1 acknowledged by the device.",
    );
    expect(summaryHeadline(summariseOutbox([]))).toBe("Nothing in the outbox.");
  });
});

describe("sortDeliveries", () => {
  it("should put the unconfirmed above the confirmed", () => {
    const sorted = sortDeliveries(outbox);
    expect(standingOf(sorted[sorted.length - 1] as Delivery)).toBe("acknowledged");
    expect(sorted.length).toBe(outbox.length);
  });

  it("should put an abandoned row above everything", () => {
    const abandoned: Delivery = { ...retrying, id: "syl:delivery:x", state: "abandoned" };
    expect(sortDeliveries([...outbox, abandoned])[0]?.id).toBe(abandoned.id);
  });

  it("should show the oldest unconfirmed row first within its group", () => {
    // The row that has gone unconfirmed longest is the likeliest real drop.
    const older: Delivery = { ...retrying, id: "syl:delivery:old", createdAt: "2020-01-01T00:00:00.000Z" };
    expect(sortDeliveries([retrying, older])[0]?.id).toBe(older.id);
  });

  it("should not mutate its argument", () => {
    const original = [...outbox];
    sortDeliveries(outbox);
    expect(outbox).toEqual(original);
  });
});

describe("unconfirmedForMs", () => {
  const now = new Date("2026-08-09T14:00:00.000Z");

  it("should measure from the moment APNs accepted it", () => {
    expect(unconfirmedForMs(deliveredNotAcked, now)).toBe(
      now.getTime() - new Date(deliveredNotAcked.deliveredAt as string).getTime(),
    );
  });

  it("should fall back to when it was scheduled if it never reached APNs", () => {
    expect(unconfirmedForMs(retrying, now)).toBe(
      now.getTime() - new Date(retrying.scheduledFor as string).getTime(),
    );
  });

  it("should fall back again to creation when there is no schedule", () => {
    const unscheduled: Delivery = { ...retrying, deliveredAt: null, scheduledFor: null };
    expect(unconfirmedForMs(unscheduled, now)).toBe(
      now.getTime() - new Date(unscheduled.createdAt).getTime(),
    );
  });

  it("should be null once the device has confirmed", () => {
    expect(unconfirmedForMs(acknowledged, now)).toBeNull();
  });
});

describe("ackLatencyMs", () => {
  it("should measure APNs acceptance to device acknowledgement", () => {
    expect(ackLatencyMs(acknowledged)).toBe(6_740);
  });

  it("should be null while there is no acknowledgement", () => {
    expect(ackLatencyMs(deliveredNotAcked)).toBeNull();
  });
});

describe("describeEngagement", () => {
  it("should report what the device said it did", () => {
    expect(describeEngagement(acknowledged)).toBe("opened");
  });

  it("should call an acknowledged row with no engagement what it is", () => {
    // A real answer, not a blank: the device confirmed and nothing happened.
    expect(describeEngagement({ ...acknowledged, engagement: null })).toBe("no signal");
  });

  it("should leave an unacknowledged row blank", () => {
    expect(describeEngagement(deliveredNotAcked)).toBe("—");
  });
});

describe("coalescedCount", () => {
  it("should count the reminders one row stands for", () => {
    expect(coalescedCount(deliveredNotAcked)).toBe(3);
    expect(coalescedCount(acknowledged)).toBe(0);
  });
});
