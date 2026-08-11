import { describe, expect, it } from "vitest";

import { fenceReplies, MAX_REPLY_BYTES, REPLY_FENCE_OPEN, type AgentReply } from "../../src/agents/fencing.js";
import { AGENT_REPLIES_MAX_BYTES, replyContributor } from "../../src/agents/reply-contributor.js";

/**
 * The thing that turns fenced answers into a contribution to her turn.
 *
 * `fencing.ts` makes one batch of answers safe to read. It does not bound how
 * many there are — and the budget in `turn-context.ts` is a promise about the
 * SUM, which no contributor can keep unless somebody counts. Ten answers at the
 * per-reply cap is 40 KB into a 24 KB prompt: an injection by volume with no
 * hostile content in it at all, just a fleet that had a busy afternoon.
 */

const reply = (over: Partial<AgentReply> = {}): AgentReply => ({
  from: "treasurer",
  body: "His health insurance is $1,485 a month.",
  at: "2026-08-11T00:20:00.000Z",
  ...over,
});

describe("replyContributor", () => {
  it("should contribute nothing at all when nobody has answered", () => {
    // Not an empty section. `composeTurnContext` drops blank contributors, but
    // handing it one at all is a claim that this track had something to say.
    expect(replyContributor([])).toBeUndefined();
  });

  it("should contribute as reports, never as memory or capability", () => {
    // The whole placement argument in one assertion. `memory` would annex an
    // agent's answer into what she knows about the Commander; `capability`
    // would rank it above the thing it is a report to.
    expect(replyContributor([reply()])?.kind).toBe("reports");
  });

  it("should hand over text the fence has already been through", () => {
    const contributor = replyContributor([reply()]);

    expect(contributor?.text).toContain(REPLY_FENCE_OPEN);
    expect(contributor?.text).toContain("treasurer");
  });

  it("should name itself something a person can go and talk to", () => {
    expect(contributorId()).not.toBe("");
  });

  it("should have room for one answer at the per-reply cap, note and all", () => {
    // The invariant that makes the greedy fit terminate usefully: whatever else
    // is dropped, the newest answer always fits. If `fencing.ts` grows its
    // preamble, this is the test that says so — rather than the Commander
    // getting a turn that quietly showed him nothing.
    const maximal = fenceReplies([reply({ body: "x".repeat(MAX_REPLY_BYTES * 2) })]);

    expect(Buffer.byteLength(maximal, "utf8")).toBeLessThan(AGENT_REPLIES_MAX_BYTES);
  });

  it("should stay inside its declared ceiling however many answers arrive", () => {
    // The budget proof in `turn-context.ts` is over DECLARED maxima. A
    // contributor that can exceed its own declaration turns that proof into a
    // decoration.
    const many = Array.from({ length: 20 }, (_, i) =>
      reply({ body: "y".repeat(MAX_REPLY_BYTES), at: `2026-08-11T00:${String(i).padStart(2, "0")}:00.000Z` }),
    );

    const contributor = replyContributor(many);

    expect(Buffer.byteLength(contributor?.text ?? "", "utf8")).toBeLessThanOrEqual(
      AGENT_REPLIES_MAX_BYTES,
    );
  });

  it("should keep the newest answers when they do not all fit", () => {
    const contributor = replyContributor([
      reply({ from: "raynor", body: "z".repeat(MAX_REPLY_BYTES), at: "2026-08-11T00:10:00.000Z" }),
      reply({ from: "treasurer", body: "The rent went up.", at: "2026-08-11T00:40:00.000Z" }),
    ]);

    expect(contributor?.text).toContain("The rent went up.");
  });

  it("should say how many answers it did not show, rather than quietly showing fewer", () => {
    // CLAUDE.md constraint 4's shape: a dropped answer she does not know was
    // dropped is one she will confidently tell him is everything the fleet
    // said. Delivery is the outbox's job and is unaffected — this is only about
    // what fits in one turn — but she has to be able to say so.
    const many = Array.from({ length: 5 }, (_, i) =>
      reply({ body: "y".repeat(MAX_REPLY_BYTES), at: `2026-08-11T00:0${String(i)}:00.000Z` }),
    );

    expect(replyContributor(many)?.text).toMatch(/4 (?:earlier|more)/);
  });

  it("should say nothing about omissions when everything fits", () => {
    // A note that fires on the ordinary case is noise she has to reason about
    // on every turn.
    expect(replyContributor([reply(), reply({ from: "raynor" })])?.text).not.toMatch(/not shown/i);
  });

  it("should read oldest first, the order the exchange happened in", () => {
    const contributor = replyContributor([
      reply({ from: "treasurer", body: "FIRST", at: "2026-08-11T00:10:00.000Z" }),
      reply({ from: "raynor", body: "SECOND", at: "2026-08-11T00:40:00.000Z" }),
    ]);

    const text = contributor?.text ?? "";
    expect(text.indexOf("FIRST")).toBeGreaterThan(-1);
    expect(text.indexOf("FIRST")).toBeLessThan(text.indexOf("SECOND"));
  });
});

function contributorId(): string {
  return replyContributor([reply()])?.id ?? "";
}
