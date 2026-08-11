import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { bootstrap, readSoul, sessionStoreFor } from "../../src/index.js";
import { LANES } from "../../src/harness/agent.js";
import { IN_MEMORY } from "../../src/services/database.js";
import { testConfig } from "../helpers/service.js";
import { BACKEND_SRC, sourceFiles } from "../helpers/sql-tables.js";

/**
 * `syl-vls` — the agent was constructed nowhere and called from nowhere.
 *
 * `runTurn` and `SylAgent` were reachable from exactly one place in the whole
 * tree: `harness/cli/ping.ts`, a manual dev script. Every unit suite around
 * them passed and would have kept passing forever, because the thing that was
 * missing was a *line in bootstrap* and a *call from each write path* — neither
 * of which any test of a component can see. It is the third instance of the
 * same shape (`syl-1o7`, `syl-c5q`, `syl-md5`), so it gets the same kind of
 * guard those did: assertions about the wiring itself, not about a component.
 *
 * The behavioural half is `us2-he-can-talk-to-her`, which attaches a client and
 * makes Syl answer for real. This is the static half — the one that fails the
 * moment somebody deletes a call rather than breaks one.
 */

/** Source files, minus the module that declares the thing being counted. */
function callersOf(needle: string, options: { readonly except?: string } = {}): string[] {
  return sourceFiles(BACKEND_SRC)
    .filter((file) => options.except === undefined || !file.endsWith(options.except))
    .filter((file) => readFileSync(file, "utf8").includes(needle))
    .map((file) => file.slice(BACKEND_SRC.length))
    .sort();
}

describe("the conversation service, as wired into the running service", () => {
  it("should be constructed exactly once, in bootstrap", () => {
    // Two would be two queues over one conversation, which is precisely the
    // overlap the per-conversation serialisation exists to prevent.
    expect(callersOf("new ConversationService(")).toEqual(["index.ts"]);
  });

  it("should be the only thing in the service that constructs an agent", () => {
    // `harness/cli/ping.ts` is the smoke test and is deliberately its own
    // thing; anything else building a `SylAgent` would be a second Syl with its
    // own session ids, resuming the same conversations out from under this one.
    // `harness/agent.ts` is excluded: `forLane` builds a view of an existing
    // agent, sharing its runner, store and soul, which is not a second Syl.
    expect(callersOf("new SylAgent(", { except: "harness/agent.ts" })).toEqual([
      "harness/cli/ping.ts",
      "index.ts",
    ]);
  });

  /**
   * **Both write paths, named.**
   *
   * This is the assertion that keeps HTTP and the socket equivalent. A message
   * posted over HTTP used to be stored and never announced, because the router
   * had no reference to the socket at all; the fix is that neither path knows
   * about the socket and both call the same two methods on the same object.
   */
  it("should be called from both write paths and no others", () => {
    expect(callersOf("chat.accept(", { except: "conversation-service.ts" })).toEqual([
      "routes/conversations.ts",
      "services/ws-server.ts",
    ]);
    expect(callersOf("chat.append(", { except: "conversation-service.ts" })).toEqual([
      "routes/conversations.ts",
      "services/ws-server.ts",
    ]);
  });

  it("should never be awaited by a request handler", () => {
    // A turn runs for up to `DEFAULT_TURN_TIMEOUT_MS` — ten minutes. An HTTP
    // handler or a frame handler that awaited one would hold its caller open
    // for the whole of it, which is the failure this seam exists to avoid.
    for (const file of ["routes/conversations.ts", "services/ws-server.ts"]) {
      const source = readFileSync(join(BACKEND_SRC, file), "utf8");
      expect(source).not.toContain("await chat.accept(");
      expect(source).not.toContain("await this.#chat.accept(");
    }
  });

  it("should reach the socket without anybody having to remember to join them", () => {
    // The socket subscribes itself in its constructor. If that ever moves back
    // into `bootstrap`, this is the test that says so — a join a bootstrap has
    // to remember is a join a bootstrap can forget, which is `syl-c5q`.
    expect(callersOf("setSink(", { except: "presence.ts" }).includes("services/ws-server.ts")).toBe(
      true,
    );
  });
});

describe("what bootstrap gives the agent", () => {
  it("should hand the service a conversation service with a lane per conversation", () => {
    const { database, deps } = bootstrap(testConfig());
    try {
      expect(deps.chat).toBeDefined();
      expect(deps.chat.pending).toBe(0);
    } finally {
      database.close();
    }
  });

  it("should keep session ids beside the store, so continuity survives a restart", () => {
    // Continuity is a persisted session id and nothing else. An in-memory store
    // would mean every restart starts a new conversation with no way back to
    // the old one.
    const directory = mkdtempSync(join(tmpdir(), "syl-sessions-"));
    try {
      const store = sessionStoreFor(testConfig({ databasePath: join(directory, "syl.db") }));
      store.write(LANES.commander, "a-session-id");

      expect(store.read(LANES.commander)).toBe("a-session-id");
      // Re-read through a second store over the same config: this is what a
      // restart is.
      const reopened = sessionStoreFor(testConfig({ databasePath: join(directory, "syl.db") }));
      expect(reopened.read(LANES.commander)).toBe("a-session-id");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("should keep an in-memory service's sessions in memory", () => {
    // Otherwise every unit test that boots a service writes lane files into
    // whichever directory the suite happened to run from.
    const store = sessionStoreFor(testConfig({ databasePath: IN_MEMORY }));
    store.write(LANES.commander, "ephemeral");

    const second = sessionStoreFor(testConfig({ databasePath: IN_MEMORY }));
    expect(second.read(LANES.commander)).toBeUndefined();
  });

  it("should read the standing orders, and shrug when there are none", () => {
    // `SOUL.md` is what makes her Syl rather than a chat box. Missing it is a
    // degraded assistant, not a reason to refuse to start.
    expect(readSoul()).toContain("Syl");
    expect(readSoul(join(tmpdir(), "syl-no-soul-here"))).toBeUndefined();
  });
});
