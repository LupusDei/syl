import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AGENT_KEY_LABEL,
  ensureAgentKey,
  SUPERSEDED_AT_BOOT,
} from "../../src/services/agent-key.js";
import type { ApiKeyService } from "../../src/services/api-key-service.js";
import type { SylDatabase } from "../../src/services/database.js";
import { testDatabase, testKeys } from "../helpers/service.js";

/**
 * Syl's own credential, and the invariant it holds.
 *
 * The claim is not "a row exists". It is that **after a boot there is exactly
 * one live `agent` key on this machine and the running process is the only
 * thing that holds its token** — nothing on disk, nothing on a socket, nothing
 * a second process can read out of `syl.db`.
 */

let db: SylDatabase;
let keys: ApiKeyService;

beforeEach(() => {
  db = testDatabase();
  keys = testKeys(db);
});

afterEach(() => {
  db.close();
});

describe("ensureAgentKey", () => {
  it("should mint a key with `agent` scope on a store that has none", () => {
    const credential = ensureAgentKey({ keys });

    expect(keys.verify(credential.token)).toMatchObject({ ok: true, key: { scope: "agent" } });
  });

  it("should return the id of the key it minted, so she can be revoked", () => {
    // US3: revoking her credential has to be possible without hunting the row
    // by name. The id is the handle, and it is the reason this returns a record
    // rather than a bare string.
    const credential = ensureAgentKey({ keys });

    expect(keys.liveKeysWithScope("agent").map((key) => key.id)).toEqual([credential.keyId]);
    expect(keys.revoke(credential.keyId, "hands withdrawn")).toBe(true);
    expect(keys.verify(credential.token)).toEqual({ ok: false, reason: "revoked" });
  });

  it("should leave exactly one live agent key after a second boot", () => {
    // The store keeps only a SHA-256 of a token, so the plaintext of the key a
    // previous process minted died with that process. A row nobody can present
    // is not a credential — reusing it is not merely undesirable, it is
    // impossible — so a boot supersedes rather than adopts.
    const first = ensureAgentKey({ keys });
    const second = ensureAgentKey({ keys });

    expect(second.token).not.toBe(first.token);
    expect(keys.liveKeysWithScope("agent").map((key) => key.id)).toEqual([second.keyId]);
  });

  it("should revoke the superseded key rather than delete it, and say why", () => {
    const first = ensureAgentKey({ keys });
    ensureAgentKey({ keys });

    const stale = keys.list().find((key) => key.id === first.keyId);
    expect(stale?.revokedAt).not.toBeNull();
    expect(stale?.revokedReason).toBe(SUPERSEDED_AT_BOOT);
    expect(keys.verify(first.token)).toEqual({ ok: false, reason: "revoked" });
  });

  it("should report how many it superseded, so a pile-up is visible", () => {
    expect(ensureAgentKey({ keys }).superseded).toBe(0);
    expect(ensureAgentKey({ keys }).superseded).toBe(1);
  });

  it("should not touch a paired device or an admin key", () => {
    // The whole reason her credential is separate: revoking her must not
    // unpair his phone, and minting hers must not disturb anything either.
    const device = keys.pair(keys.issuePairingCode().code, "Commander's iPhone");
    const admin = keys.mint("Web admin (console)", { scope: "admin" });

    ensureAgentKey({ keys });
    ensureAgentKey({ keys });

    expect(keys.verify(device.token)).toMatchObject({ ok: true, key: { scope: "device" } });
    expect(keys.verify(admin.token)).toMatchObject({ ok: true, key: { scope: "admin" } });
  });

  it("should label the key so a human reading the key list knows whose it is", () => {
    const credential = ensureAgentKey({ keys });
    const record = keys.list().find((key) => key.id === credential.keyId);

    expect(record?.deviceName).toBe(AGENT_KEY_LABEL);
  });

  it("should never put the token itself in the store", () => {
    // The property every key in this table has, restated for the one key the
    // service mints for itself. A copy of `syl.db` must contain nothing that
    // can be presented to the API.
    const credential = ensureAgentKey({ keys });
    const rows = db.handle.prepare("SELECT * FROM api_keys").all();

    expect(JSON.stringify(rows)).not.toContain(credential.token);
    expect(JSON.stringify(keys.list())).not.toContain(credential.token);
  });

  it("should carry the expiry the key was minted with", () => {
    const credential = ensureAgentKey({ keys });
    const record = keys.list().find((key) => key.id === credential.keyId);

    expect(credential.expiresAt).toBe(record?.expiresAt);
  });
});
