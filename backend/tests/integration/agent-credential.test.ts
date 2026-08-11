import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import type { ApiError, TokenGrant } from "@syl/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { API_BASE_PATH, bootstrap, createApp, type Bootstrapped } from "../../src/index.js";
import { AGENT_KEY_LABEL } from "../../src/services/agent-key.js";
import { mountedRoutes, specOperations } from "../helpers/contract.js";
import { startTestApp, type RunningApp } from "../helpers/http.js";
import { BACKEND_SRC, sourceFiles } from "../helpers/sql-tables.js";
import { testConfig } from "../helpers/service.js";

/**
 * **A paired device cannot obtain Syl's credential by any published operation.**
 *
 * This is the claim the whole `agent` scope rests on, and it is a claim about
 * the *published surface* rather than about one route — so it is tested against
 * the whole surface, three ways, because each catches something the others
 * cannot:
 *
 * 1. **From the contract.** Exactly one operation is documented as returning a
 *    `TokenGrant`. A future route that published one would fail this without
 *    anybody remembering to come back here.
 * 2. **From the running service.** Every mounted route that a device can reach
 *    unattended is called with a real device token, and the agent's token — a
 *    high-entropy string that exists nowhere else — must appear in none of the
 *    responses.
 * 3. **From the source.** The credential is reachable from `index.ts` and from
 *    nothing under `routes/`. A route cannot leak a value it cannot name.
 *
 * The reasoning behind all three is the same one `0014` used for `admin`: what
 * makes a scope defensible is not the column, it is **where a value can be
 * created**. `pair()` takes no scope argument, so no route is one refactor away
 * from accepting one; `agent` is created by `ensureAgentKey`, which is called by
 * `bootstrap` and by nothing else.
 */

let built: Bootstrapped;
let running: RunningApp;
let deviceToken: string;

interface Envelope<T> {
  readonly success: boolean;
  readonly data?: T;
  readonly error?: ApiError;
}

beforeEach(async () => {
  built = bootstrap(testConfig({ databasePath: ":memory:" }));
  running = await startTestApp(createApp(testConfig(), built.deps));

  const response = await fetch(`${running.baseUrl}${API_BASE_PATH}/auth/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", "Idempotency-Key": randomUUID() },
    body: JSON.stringify({
      pairingCode: built.deps.keys.issuePairingCode().code,
      deviceName: "Commander's iPhone",
    }),
  });
  const body = (await response.json()) as Envelope<TokenGrant>;
  deviceToken = (body.data as TokenGrant).token;
});

afterEach(async () => {
  await running.close();
  built.database.close();
});

describe("the agent credential, against the published contract", () => {
  it("should be documented nowhere: exactly one operation returns a token at all", () => {
    const granting = specOperations()
      .filter((operation) => operation.dataSchema === "TokenGrant")
      .map((operation) => operation.operationId);

    expect(granting).toEqual(["pairDevice"]);
  });

  it("should be unobtainable from the one operation that does grant a token", async () => {
    // `pair` mints `device`, always, and takes no scope argument — so this is
    // not "the route currently passes the right value", it is that there is no
    // parameter through which anything else could be asked for.
    const response = await fetch(`${running.baseUrl}${API_BASE_PATH}/auth/pair`, {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": randomUUID() },
      body: JSON.stringify({
        pairingCode: built.deps.keys.issuePairingCode().code,
        deviceName: "Second device",
        // The obvious attempt, and the one a client library would make if the
        // field ever appeared in the contract.
        scope: "agent",
      }),
    });
    const body = (await response.json()) as Envelope<TokenGrant>;

    // It succeeds — the stray field is ignored, not refused — and the token it
    // hands back is a device token. Refusing would be the weaker outcome: it
    // would mean the route *reads* the field.
    expect(response.status).toBe(200);
    expect(built.deps.keys.verify((body.data as TokenGrant).token)).toMatchObject({
      ok: true,
      key: { scope: "device" },
    });
    expect(built.deps.keys.liveKeysWithScope("agent").map((key) => key.deviceName)).toEqual([
      AGENT_KEY_LABEL,
    ]);
  });
});

describe("the agent credential, against the running service", () => {
  /** Every mounted route a device can call blind: no path parameter, no body. */
  function readableRoutes(): readonly string[] {
    return mountedRoutes(createApp(testConfig(), built.deps))
      .filter((route) => route.startsWith("GET ") && !route.includes("{"))
      .map((route) => route.slice("GET ".length));
  }

  it("should have something to sweep, so this file cannot pass vacuously", () => {
    expect(readableRoutes().length).toBeGreaterThan(5);
  });

  it("should appear in no response a paired device can provoke", async () => {
    // The token is 32 hex characters of entropy that exist in exactly one place
    // — this process's memory — so its appearance anywhere in a response body
    // is unambiguous evidence of a leak, and its absence is not a coincidence.
    const leaked: string[] = [];

    for (const path of readableRoutes()) {
      const response = await fetch(`${running.baseUrl}${API_BASE_PATH}${path}`, {
        headers: { authorization: `Bearer ${deviceToken}` },
      });
      const text = await response.text();
      if (text.includes(built.agentKey.token)) leaked.push(`${path} leaked the token`);
      // The id and the label are softer evidence and worth the same sweep: a
      // key list that showed her row would tell an attacker what to revoke.
      if (text.includes(built.agentKey.keyId)) leaked.push(`${path} leaked her key id`);
      if (text.includes(AGENT_KEY_LABEL)) leaked.push(`${path} leaked her key's label`);
    }

    expect(leaked).toEqual([]);
  });

  it("should not be reachable by asking the sync feed for it", async () => {
    // `GET /sync` walks a change log by resource type. An api key is not one of
    // them and must not become one; this is the assertion that says so out loud.
    const response = await fetch(`${running.baseUrl}${API_BASE_PATH}/sync?since=0`, {
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    const text = await response.text();

    expect(text).not.toContain(built.agentKey.token);
    expect(text).not.toContain("apikey");
  });

  it("should leave the device's own token working, so the sweep proved something", async () => {
    // A sweep against a token that is refused everywhere would find no leak and
    // mean nothing. This is the control.
    const response = await fetch(`${running.baseUrl}${API_BASE_PATH}/auth/whoami`, {
      headers: { authorization: `Bearer ${deviceToken}` },
    });

    expect(response.status).toBe(200);
  });
});

describe("the agent credential, against the source", () => {
  /**
   * A file's source with its comments removed.
   *
   * The distinction matters here: `api-key-service.ts` names `ensureAgentKey`
   * in a doc comment, pointing a reader at where the scope is created. A
   * cross-reference is the opposite of a leak, and an assertion that could not
   * tell the two apart would punish exactly the documentation this design
   * depends on.
   */
  function code(file: string): string {
    return readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//gu, " ")
      .replace(/(^|[^:])\/\/[^\n]*/gu, "$1");
  }

  /** Files under `src/` whose code names the credential. */
  function referencingFiles(): readonly string[] {
    return sourceFiles(BACKEND_SRC)
      .filter((file) => /ensureAgentKey|agentKey/u.test(code(file)))
      .map((file) => file.slice(BACKEND_SRC.length))
      .sort();
  }

  it("should be named only where it is created and where it is handed on", () => {
    // A route cannot leak a value it cannot name. Keeping this list short is
    // what keeps the sweep above from being the only thing standing between the
    // credential and a socket.
    expect(referencingFiles()).toEqual(["index.ts", "services/agent-key.ts"]);
  });

  it("should not be named by any router", () => {
    expect(referencingFiles().filter((file) => file.startsWith("routes/"))).toEqual([]);
  });

  it("should have exactly one caller that can mint the scope at all", () => {
    // `mint(..., { scope: "agent" })` is the only way an agent row comes into
    // existence. If a second call site appears, it should be a decision.
    const minters = sourceFiles(BACKEND_SRC)
      .filter((file) => /scope:\s*"agent"/u.test(code(file)))
      .map((file) => file.slice(BACKEND_SRC.length));

    expect(minters).toEqual(["services/agent-key.ts"]);
  });
});
