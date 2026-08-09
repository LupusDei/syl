import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assertExistingStore,
  describePairing,
  issueBriefing,
  tailnetBaseURL,
} from "../../src/ops/cli/pair.js";
import {
  ApiKeyService,
  PairingError,
  type PairingFailure,
} from "../../src/services/api-key-service.js";
import { openDatabase, type SylDatabase } from "../../src/services/database.js";
import { expectData, startLiveService } from "../helpers/live-service.js";
import { testConfig } from "../helpers/service.js";

/**
 * Pairing, against a real file rather than a mock — `syl-q1f`.
 *
 * Two things live here that cannot live in a unit test, and both are the
 * reason the flow was rebuilt around the store in the first place.
 *
 * 1. **`npm run pair` is a different process from the service.** The service
 *    runs under launchd; the Commander is at a shell. They share exactly one
 *    thing — the database file — so a pairing code held in either process's
 *    memory is a code the other cannot see. Every case below opens the file
 *    twice, which is the honest simulation of that split.
 * 2. **Single use has to hold across that split.** A guard in TypeScript
 *    protects one process from itself and nothing else. The guarantee is a
 *    `UNIQUE` index and a conditional `UPDATE`, and the only place either can
 *    be observed is a real, migrated SQLite.
 *
 * `:memory:` would defeat both: two in-memory connections are two separate
 * databases, so every case would pass by not testing anything.
 */

let directory: string;
let databasePath: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "syl-pairing-"));
  databasePath = join(directory, "syl.db");
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

/** A second connection to the same file — a second process, in effect. */
function connect(): SylDatabase {
  return openDatabase({ path: databasePath });
}

/** The reason a pairing attempt refused, or a thrown failure. */
function reasonFor(attempt: () => unknown): PairingFailure {
  try {
    attempt();
  } catch (error) {
    if (error instanceof PairingError) return error.reason;
    throw error;
  }
  throw new Error("that pairing attempt was expected to fail and did not");
}

describe("a code issued by one process and redeemed by another", () => {
  it("should pair, which is the whole point of putting it in the store", () => {
    const cli = connect();
    const code = new ApiKeyService({ db: cli.handle }).issuePairingCode().code;
    cli.close();

    // The service, which has been running the entire time and never saw the
    // command that minted this.
    const service = connect();
    const grant = new ApiKeyService({ db: service.handle }).pair(code, "Commander's iPhone");
    service.close();

    expect(grant.tokenType).toBe("Bearer");
    expect(grant.token).toMatch(/^syl_pat_[0-9a-f]{32}$/);
  });

  it("should survive the issuing process going away entirely", () => {
    // The old design lost the code on restart and called that correct. It is
    // correct for a code held in memory and impossible for a code a *second
    // process* has to be able to issue: `npm run pair` exits immediately.
    const cli = connect();
    const code = new ApiKeyService({ db: cli.handle }).issuePairingCode().code;
    cli.close();

    const reopened = connect();
    const grant = new ApiKeyService({ db: reopened.handle }).pair(code, "Commander's iPhone");
    reopened.close();

    expect(grant.principal.name).toBe("The Commander");
  });

  it("should let the second redemption through no door at all", () => {
    // The case the UNIQUE index exists for. Two connections, each with its own
    // service object, neither able to see the other's memory — so nothing in
    // application code is in a position to prevent this. The store is.
    const issuer = connect();
    const code = new ApiKeyService({ db: issuer.handle }).issuePairingCode().code;

    const first = connect();
    const second = connect();
    new ApiKeyService({ db: first.handle }).pair(code, "Commander's iPhone");

    expect(reasonFor(() => new ApiKeyService({ db: second.handle }).pair(code, "Attacker"))).toBe(
      "already_used",
    );

    const keys = issuer.handle.prepare("SELECT device_name FROM api_keys").all();
    expect(keys).toHaveLength(1);

    first.close();
    second.close();
    issuer.close();
  });

  it("should let a second process supersede a code the first one issued", () => {
    // Running the pairing command twice must leave one live code, not two.
    const first = connect();
    const stale = new ApiKeyService({ db: first.handle }).issuePairingCode().code;
    first.close();

    const again = connect();
    const fresh = new ApiKeyService({ db: again.handle }).issuePairingCode().code;
    again.close();

    const service = connect();
    const keys = new ApiKeyService({ db: service.handle });
    expect(reasonFor(() => keys.pair(stale, "Late device"))).toBe("expired");
    expect(keys.pair(fresh, "Commander's iPhone").tokenType).toBe("Bearer");
    service.close();
  });
});

describe("the whole flow, end to end", () => {
  /**
   * `npm run pair` on the Mac, then a phone, over a real socket.
   *
   * Every layer is the shipping one: `startSyl` — the entire body of `main` — a
   * real TCP port, a real on-disk store, and the pairing command reaching that
   * store from outside the service's process. It is the closest thing to the
   * Commander standing in his kitchen that a test can be.
   */
  it("should take a device from nothing to a working credential", async () => {
    const syl = await startLiveService({ pair: false, databasePath });
    try {
      // He runs the command. Different process, same file.
      const cli = connect();
      const briefing = issueBriefing(cli, testConfig({ databasePath }));
      cli.close();

      // He types the eight digits into a phone.
      const response = await syl.api("/auth/pair", {
        method: "POST",
        anonymous: true,
        body: JSON.stringify({
          pairingCode: briefing.code,
          deviceName: "Commander's iPhone",
        }),
      });
      const grant = await expectData<{ token: string; tokenType: string }>(response);

      expect(response.status).toBe(200);
      expect(grant.tokenType).toBe("Bearer");

      // The app now holds a credential the service accepts. This is the assertion
      // the bead was filed about: before it, every request went out with no
      // `Authorization` header at all and the app was inert.
      const whoami = await fetch(`${syl.baseUrl}/auth/whoami`, {
        headers: { authorization: `Bearer ${grant.token}` },
      });
      expect(whoami.status).toBe(200);
    } finally {
      await syl.close();
    }
  }, 30_000);

  it("should refuse the same code a second time, over HTTP, with a legible reason", async () => {
    const syl = await startLiveService({ pair: false, databasePath });
    try {
      const cli = connect();
      const code = issueBriefing(cli, testConfig({ databasePath })).code;
      cli.close();

      const body = JSON.stringify({ pairingCode: code, deviceName: "Commander's iPhone" });
      await syl.api("/auth/pair", { method: "POST", anonymous: true, body });
      // A *different* idempotency key: the same key would replay the stored grant,
      // which is the right behaviour for a retry and would hide this one.
      const second = await syl.api("/auth/pair", { method: "POST", anonymous: true, body });
      const failure = (await second.json()) as { error: { code: string; message: string } };

      expect(second.status).toBe(401);
      expect(failure.error.code).toBe("PAIRING_CODE_ALREADY_USED");
      // The message has to name the way out. On a phone this is the entire
      // difference between going back to the Mac and retyping the same digits.
      expect(failure.error.message).toContain("npm run pair");
    } finally {
      await syl.close();
    }
  }, 30_000);
});

describe("npm run pair", () => {
  it("should print a code, an expiry and where to point the phone", () => {
    const certStatusPath = join(directory, "cert-status.json");
    writeFileSync(
      certStatusPath,
      JSON.stringify({
        checkedAt: new Date().toISOString(),
        hostname: "bastion.tail0000.ts.net",
        certPath: "/tmp/cert.pem",
        ok: true,
        renewed: false,
        daysRemaining: 70,
        error: null,
      }),
    );

    const db = connect();
    const briefing = issueBriefing(db, testConfig({ databasePath, certStatusPath }));
    db.close();

    expect(briefing.code).toMatch(/^\d{4}-\d{4}$/);
    expect(briefing.baseURL).toBe("https://bastion.tail0000.ts.net/api/v1");
    expect(briefing.pairedDevices).toBe(0);

    const printed = describePairing(briefing).join("\n");
    expect(printed).toContain(briefing.code);
    expect(printed).toContain("https://bastion.tail0000.ts.net/api/v1");
  });

  it("should issue a code that actually pairs, through the same door a phone uses", () => {
    const db = connect();
    const briefing = issueBriefing(db, testConfig({ databasePath }));
    const grant = new ApiKeyService({ db: db.handle }).pair(briefing.code, "Commander's iPhone");
    db.close();

    expect(grant.tokenType).toBe("Bearer");
  });

  it("should say the URL is unknown rather than invent one", () => {
    // A base URL is the one field he cannot check by looking at it. An invented
    // one gets typed in, fails, and looks exactly like a pairing problem — and
    // registering against a guessed host is a failure this project has had.
    const briefing = {
      code: "1234-5678",
      expiresAt: "2026-08-09T07:10:00.000Z",
      baseURL: tailnetBaseURL(join(directory, "there-is-no-such-file.json")),
      pairedDevices: 0,
      databasePath,
    };

    expect(briefing.baseURL).toBeNull();
    const printed = describePairing(briefing).join("\n");
    expect(printed).toContain("unknown");
    expect(printed).not.toContain("localhost");
    expect(printed).not.toContain("127.0.0.1");
  });

  it("should refuse to issue a code into a store it would have had to create", () => {
    // The sharpest edge on this command. The service gets `SYL_DB_PATH` from its
    // launchd plist as an absolute path; a shell has no such variable, so the
    // default is `.syl/syl.db` *relative to the working directory*. Run from the
    // wrong place, this would silently create an empty database, migrate it, and
    // print a perfectly valid code for a store nothing is serving — and the only
    // symptom would be "that pairing code was not accepted", forever, with the
    // command reporting success every time.
    const absent = join(directory, "nowhere", "syl.db");

    expect(() => assertExistingStore(absent, "/Users/commander")).toThrow(/no Syl database/);
    // And it must say enough to fix it: the path it resolved, the variable that
    // sets it, and how to read what the service is using.
    try {
      assertExistingStore(absent, "/Users/commander");
      expect.unreachable("should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain(absent);
      expect(message).toContain("SYL_DB_PATH");
      expect(message).toContain("launchctl print");
    }
  });

  it("should proceed against a store that already exists", () => {
    const db = connect();
    db.close();

    expect(() => assertExistingStore(databasePath)).not.toThrow();
  });

  it("should name the store it wrote the code into", () => {
    // Printed on every run rather than only on failure: it is the one field that
    // can be quietly wrong, and a value you have seen every time is a value you
    // notice changing.
    const db = connect();
    const briefing = issueBriefing(db, testConfig({ databasePath }));
    db.close();

    expect(briefing.databasePath).toBe(resolve(databasePath));
    expect(describePairing(briefing).join("\n")).toContain(resolve(databasePath));
  });

  it("should count the devices already holding a live token", () => {
    const db = connect();
    const keys = new ApiKeyService({ db: db.handle });
    keys.pair(keys.issuePairingCode().code, "Commander's iPhone");

    const briefing = issueBriefing(db, testConfig({ databasePath }));
    db.close();

    // Named so that pairing a second device is visibly not a mistake: the
    // first one keeps working, and he should know that before he wonders.
    expect(briefing.pairedDevices).toBe(1);
    expect(describePairing(briefing).join("\n")).toContain("does not");
  });
});
