import type { Delivery, Device, Reminder, TokenGrant } from "@syl/shared";
import { afterEach, describe, expect, it } from "vitest";

import { sylHome } from "../../src/index.js";
import { fixedClock } from "../../src/services/clock.js";
import { toolConfigPath } from "../../src/tools/config.js";
import { startFakeApns, type FakeApns } from "../helpers/fake-apns.js";
import { expectData, startLiveService, type LiveService } from "../helpers/live-service.js";
import { McpServerProcess, serversDeclaredIn, type McpToolResult } from "../helpers/mcp-client.js";

/**
 * **US3 — revoking her stops her, and leaves the phone working.** `syl-009.5.2`.
 *
 * This is the containment guarantee the whole `agent` scope was built for, and
 * it is **one claim with two halves**:
 *
 * > Pulling Syl's credential stops every tool call she can make, and changes
 * > nothing at all about the Commander's own device path.
 *
 * ## Why both halves live in one test
 *
 * Because two green tests in two files do not prove this. "Revocation stops
 * her" is satisfied by a service that has fallen over; "the phone still works"
 * is satisfied by a service where nothing was ever revoked. Only a single run
 * that revokes, then watches her fail *and* watches his phone keep working,
 * rules out both — and the failure this exists to catch is precisely the one
 * where the two are the same credential and the separation was theatre.
 *
 * `services/agent-key.ts` names revocation as one of the three reasons her key
 * is not the phone's. This file is that sentence, executed.
 *
 * ## What is real here
 *
 * Everything. `startSyl` on a real port and a real SQLite file; the declaration
 * it wrote under her home; her MCP server as a **spawned subprocess**, speaking
 * real MCP over stdio, holding the credential it was handed at spawn; the
 * loopback HTTP client; the auth middleware; the delivery runtime; and a fake
 * Apple that is a real HTTP server.
 *
 * **One server process spans the revocation**, deliberately. Restarting it
 * between the two calls would prove that a rewritten declaration carries a dead
 * token — a much weaker claim. Held open, the process keeps presenting the same
 * string it started with, so what changes is the credential's standing and
 * nothing else.
 */

/** 07:00 in Chicago on a summer morning, as an instant. */
const MORNING = Date.UTC(2026, 7, 10, 12, 0, 0, 0);
/** 16:00 the same day. When his reminder is due. */
const FIRE_AT = "2026-08-10T21:00:00.000Z";
const APNS_TOKEN = "4c81de07".repeat(8);

let syl: LiveService | null = null;
let apple: FakeApns | null = null;

afterEach(async () => {
  await syl?.close();
  await apple?.close();
  syl = null;
  apple = null;
});

/** What a `tools/call` said, as the envelope `tools/server.ts` puts in it. */
interface Envelope {
  readonly ok: boolean;
  readonly action: string;
  readonly reason?: string;
  readonly retryable?: boolean;
}

/** Her hands, started the way Claude Code starts them, from her own declaration. */
async function startHerHands(service: LiveService): Promise<McpServerProcess> {
  const home = sylHome(service.config);
  if (home === undefined) throw new Error("a live service always has a home to declare hands in");

  const declared = serversDeclaredIn(toolConfigPath(home));
  const server = declared[0]?.[1];
  if (server === undefined) {
    throw new Error(`the declaration under ${home} names no server, so she was given no hands`);
  }

  const process_ = McpServerProcess.start(server.command, server.args ?? [], server.env ?? {});
  await process_.handshake("syl-revocation");
  return process_;
}

/** Ask her to make a reminder, and read the envelope back. */
async function remindHim(hands: McpServerProcess, text: string): Promise<Envelope> {
  const called = (await hands.request("tools/call", {
    name: "remind_me",
    arguments: {
      text,
      // Tomorrow morning, so the one reminder she makes is not also due when
      // the delivery loop steps forward to his — this test asserts on exactly
      // one push, and it must be his.
      when: { said: "tomorrow at eight", kind: "date_time", date: "2026-08-11", wallTime: "08:00" },
      because: "He asked me to, just now.",
    },
  })) as McpToolResult;

  const said = (called.content ?? []).map((block) => block.text ?? "").join("");
  return JSON.parse(said) as Envelope;
}

describe("revoking her hands", () => {
  it("should stop every tool call and leave his phone completely unaffected", async () => {
    apple = await startFakeApns();
    let now = MORNING;
    // Frozen stores, a delivery loop the test steps by hand: "the notification
    // arrived" has to be a statement about the reminder rather than about the
    // second the suite ran.
    syl = await startLiveService({
      clock: fixedClock(MORNING),
      delivery: { apple, clock: () => now },
    });
    const service = syl;

    // His phone, registered over the same API it really uses.
    await expectData<Device>(
      await service.api("/devices", {
        method: "POST",
        body: JSON.stringify({
          token: APNS_TOKEN,
          environment: "production",
          platform: "ios",
          name: "Commander's iPhone",
          appVersion: "0.1.0 (14)",
          osVersion: "26.1",
        }),
      }),
    );
    const due = await expectData<Reminder>(
      await service.api("/reminders", {
        method: "POST",
        body: JSON.stringify({
          text: "Call the pharmacy — the refill lapses today.",
          wallTime: "16:00",
          tz: "America/Chicago",
          date: "2026-08-10",
        }),
      }),
    );
    expect(due.nextFireAt).toBe(FIRE_AT);

    const hands = await startHerHands(service);
    try {
      // ---- The control. Without it, "she cannot act" proves nothing: a server
      // that never worked also cannot act after a revocation.
      const before = await remindHim(hands, "Take the bread out of the oven.");
      expect(before.ok, `she could not act even before revocation: ${before.reason ?? ""}`).toBe(
        true,
      );

      // ---- Revoke her, the way an operator would: by her row's id, which is
      // the handle `AgentCredential.keyId` exists to be. Her phone is untouched
      // because it is a different row, which is the whole design.
      const hers = service.deps.keys.liveKeysWithScope("agent");
      expect(hers).toHaveLength(1);
      const revoked = service.deps.keys.revoke(
        hers[0]?.id ?? "",
        "the Commander took her hands away",
      );
      expect(revoked).toBe(true);

      // ---- HALF ONE: she is stopped. A different errand from the control, so
      // "nothing landed" can be asked of the store rather than inferred.
      const after = await remindHim(hands, "Water the plants.");
      expect(after.ok).toBe(false);
      // A sentence a person could act on, and the three facts in it are the
      // three he needs: nothing was written, his phone is fine, and how she
      // gets her hands back. The API's own 401 says "Re-pair this device" —
      // correct for the audience it was written for and, said by Syl, an
      // instruction to go and fix the one thing that is not broken. See
      // `revokedCredential` in `tools/client.ts`.
      const reason = after.reason ?? "";
      expect(reason).toMatch(/credential/iu);
      expect(reason).toMatch(/nothing was written/iu);
      expect(reason).toMatch(/phone/iu);
      expect(reason).not.toMatch(/re-pair this device/iu);
      // Not retryable: a revoked key does not come back on a second attempt,
      // and a retryable refusal invites exactly that loop.
      expect(after.retryable).toBe(false);
      // And nothing landed. "She was refused" and "she was refused after the
      // write" are different outcomes, and only the store can tell them apart.
      const stored = await expectData<{ items: Reminder[] }>(
        await service.api("/reminders?limit=50"),
      );
      const texts = stored.items.map((item) => item.text);
      expect(texts).not.toContain("Water the plants.");
      // The control's reminder is still there, which is what makes the line
      // above a statement about the revocation rather than about the store.
      expect(texts).toContain("Take the bread out of the oven.");

      // ---- HALF TWO: his phone, in the same run, after the same revocation.

      // Pairing still works — a new device can still be brought in.
      const pairing = await service.api("/auth/pair", {
        method: "POST",
        anonymous: true,
        body: JSON.stringify({
          pairingCode: service.issuePairingCode(),
          deviceName: "Commander's iPad",
        }),
      });
      expect(pairing.status).toBe(200);
      const granted = await expectData<TokenGrant>(pairing);
      expect(granted.token).not.toBe("");

      // Conversations still work, on the token he was already holding and on
      // the one just issued. His transcript is not collateral damage.
      expect((await service.api("/conversations")).status).toBe(200);
      expect((await service.api("/conversations", { token: granted.token })).status).toBe(200);

      // And the reminder still reaches his phone. This is the half that would
      // be silently lost if the two credentials were ever collapsed into one:
      // the push is signed by the service, but the *device row* it targets was
      // registered under his token.
      now = Date.parse(FIRE_AT);
      await service.runtime.runner.start();
      await service.runtime.runner.tick();

      expect(apple.pushes).toHaveLength(1);
      expect(apple.pushes[0]?.path).toBe(`/3/device/${APNS_TOKEN}`);

      // Right down to the acknowledgement, which is his phone writing back.
      const body = apple.pushes[0]?.body as Record<string, unknown>;
      const acked = await expectData<Delivery>(
        await service.api(`/deliveries/${encodeURIComponent(String(body["deliveryId"]))}/ack`, {
          method: "POST",
          body: JSON.stringify({ ackedAt: FIRE_AT, engagement: "opened" }),
        }),
      );
      expect(acked.state).toBe("acknowledged");
    } finally {
      hands.stop();
    }
  });
});
