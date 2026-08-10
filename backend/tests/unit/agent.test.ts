import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, it, expect, vi } from "vitest";

import {
  LANES,
  MEMORYLESS_LANES,
  SylAgent,
  fileSessionStore,
  memorySessionStore,
  type SessionStore,
} from "../../src/harness/agent.js";
import type { TurnOptions, TurnResult, TurnRunner } from "../../src/harness/session.js";
import { autoMemoryAt } from "../../src/memory/auto-memory.js";

function fakeResult(sessionId: string, text = "ok"): TurnResult {
  return {
    sessionId,
    text,
    costUsd: 0.001,
    numTurns: 1,
    init: {
      kind: "init",
      sessionId,
      raw: {},
      model: "claude-haiku-4-5",
      apiKeySource: "none",
      mcpServers: [],
      tools: [],
      capabilities: [],
      autoMemoryPath: undefined,
    },
    events: [],
  };
}

/** In-memory store, optionally pre-seeded per lane. */
function memoryStore(initial: Record<string, string> = {}): SessionStore {
  const lanes = new Map(Object.entries(initial));
  return {
    read: (lane) => lanes.get(lane),
    write: (lane, id) => {
      lanes.set(lane, id);
    },
    clear: (lane) => {
      lanes.delete(lane);
    },
  };
}

/** Options passed to the Nth runner call, asserted to exist. */
function optionsOfCall(runner: ReturnType<typeof vi.fn<TurnRunner>>, index: number): TurnOptions {
  const call = runner.mock.calls[index];
  if (!call) throw new Error(`expected runner call #${index}`);
  return call[1];
}

/**
 * A runner that behaves like `runTurn`: it announces the session id it is about
 * to use before doing any work, and returns that same id.
 */
function announcingRunner(idFor: (call: number) => string): ReturnType<typeof vi.fn<TurnRunner>> {
  let call = 0;
  return vi.fn<TurnRunner>(async (_prompt, options) => {
    const id = options.resume ?? options.sessionId ?? idFor(call++);
    options.onSessionId?.(id);
    return fakeResult(id);
  });
}

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "syl-agent-"));
  dirs.push(dir);
  return dir;
}

describe("SylAgent", () => {
  it("should omit resume on the first turn when no session has been stored", async () => {
    const runner = vi.fn<TurnRunner>(async () => fakeResult("sess-1"));
    const agent = new SylAgent({ runner, store: memoryStore() });

    await agent.ask("hello");

    expect(runner).toHaveBeenCalledTimes(1);
    expect(optionsOfCall(runner, 0).resume).toBeUndefined();
  });

  it("should resume the stored session on the next turn so context carries over", async () => {
    const runner = vi.fn<TurnRunner>(async () => fakeResult("sess-1"));
    const agent = new SylAgent({ runner, store: memoryStore() });

    await agent.ask("first");
    await agent.ask("second");

    expect(optionsOfCall(runner, 1).resume).toBe("sess-1");
  });

  it("should persist the session id so continuity survives a process restart", async () => {
    const store = memoryStore();
    const runner = vi.fn<TurnRunner>(async () => fakeResult("sess-42"));

    await new SylAgent({ runner, store }).ask("first");
    // A brand-new agent instance stands in for a restarted process.
    await new SylAgent({ runner, store }).ask("second");

    expect(optionsOfCall(runner, 1).resume).toBe("sess-42");
  });

  it("should forward the soul as the system prompt on every turn", async () => {
    const runner = vi.fn<TurnRunner>(async () => fakeResult("s"));
    const agent = new SylAgent({ runner, store: memoryStore(), soul: "be helpful" });

    await agent.ask("hi");

    expect(optionsOfCall(runner, 0).systemPrompt).toBe("be helpful");
  });

  it("should pre-authorise its turns, since a headless turn has nobody to approve it", async () => {
    // runTurn deliberately has no default permission mode. This is the trusted
    // lane — the Commander's own conversation — so it opts in explicitly rather
    // than inheriting a default that would also apply to untrusted content.
    const runner = vi.fn<TurnRunner>(async () => fakeResult("s"));

    await new SylAgent({ runner, store: memoryStore() }).ask("hi");

    expect(optionsOfCall(runner, 0).permissionMode).toBe("bypassPermissions");
  });

  it("should let the caller override the permission mode", async () => {
    const runner = vi.fn<TurnRunner>(async () => fakeResult("s"));
    const agent = new SylAgent({ runner, store: memoryStore(), turnOptions: { permissionMode: "plan" } });

    await agent.ask("hi");

    expect(optionsOfCall(runner, 0).permissionMode).toBe("plan");
  });

  it("should drop a stale session id when resuming fails, so a bad id cannot wedge the agent permanently", async () => {
    // Guards the failure where a session is expired or pruned: without this the
    // agent retries the same dead id forever and never speaks again.
    const runner = vi
      .fn<TurnRunner>()
      .mockRejectedValueOnce(new Error("No conversation found with session ID: dead"))
      .mockResolvedValueOnce(fakeResult("sess-new"));
    const agent = new SylAgent({ runner, store: memoryStore({ commander: "dead" }) });

    const result = await agent.ask("hello");

    expect(runner).toHaveBeenCalledTimes(2);
    expect(optionsOfCall(runner, 0).resume).toBe("dead");
    expect(optionsOfCall(runner, 1).resume).toBeUndefined();
    expect(result.sessionId).toBe("sess-new");
  });

  it("should propagate a non-resume failure rather than silently starting a fresh session", async () => {
    // A billing or auth failure must surface. Retrying without resume would
    // hide it and burn a second turn for nothing.
    const runner = vi
      .fn<TurnRunner>()
      .mockRejectedValue(new Error("Claude API error (billing_error): Credit balance is too low"));
    const agent = new SylAgent({ runner, store: memoryStore({ commander: "sess-1" }) });

    await expect(agent.ask("hello")).rejects.toThrow(/billing_error/);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("should clear the stored session on reset so the next turn starts clean", async () => {
    const runner = vi.fn<TurnRunner>(async () => fakeResult("sess-2"));
    const agent = new SylAgent({ runner, store: memoryStore({ commander: "sess-1" }) });

    agent.reset();
    await agent.ask("hi");

    expect(optionsOfCall(runner, 0).resume).toBeUndefined();
  });

  describe("session lanes", () => {
    it("should keep each lane on its own conversation", async () => {
      // The failure this prevents: the heartbeat, the morning agenda and the
      // Commander's own conversation sharing one thread, so Syl's inner
      // monologue interleaves with talking to him.
      const store = memoryStore();
      const runner = announcingRunner((n) => `sess-${n}`);
      const syl = new SylAgent({ runner, store });

      await syl.ask("morning agenda please", LANES.agenda);
      await syl.ask("anything needing attention?", LANES.heartbeat);
      await syl.ask("agenda again", LANES.agenda);
      await syl.ask("heartbeat again", LANES.heartbeat);

      expect(optionsOfCall(runner, 0).resume).toBeUndefined();
      expect(optionsOfCall(runner, 1).resume).toBeUndefined();
      // Each lane resumes what it started, not what the other lane last said.
      expect(optionsOfCall(runner, 2).resume).toBe("sess-0");
      expect(optionsOfCall(runner, 3).resume).toBe("sess-1");
    });

    it("should default to the Commander's lane", async () => {
      const store = memoryStore();
      const runner = announcingRunner(() => "sess-c");

      await new SylAgent({ runner, store }).ask("hi");

      expect(store.read(LANES.commander)).toBe("sess-c");
      expect(store.read(LANES.heartbeat)).toBeUndefined();
    });

    it("should expose a lane-scoped agent so a scheduled job can hold a stable handle", async () => {
      const store = memoryStore();
      const runner = announcingRunner((n) => `sess-${n}`);
      const heartbeat = new SylAgent({ runner, store }).forLane(LANES.heartbeat);

      await heartbeat.ask("tick");
      await heartbeat.ask("tock");

      expect(heartbeat.lane).toBe(LANES.heartbeat);
      expect(optionsOfCall(runner, 1).resume).toBe("sess-0");
      expect(store.read(LANES.commander)).toBeUndefined();
    });

    it("should reset only the lane it was asked to reset", async () => {
      const store = memoryStore({ commander: "sess-c", heartbeat: "sess-h" });
      const runner = announcingRunner(() => "fresh");
      const syl = new SylAgent({ runner, store });

      syl.reset(LANES.heartbeat);

      expect(syl.sessionIdFor(LANES.commander)).toBe("sess-c");
      expect(syl.sessionIdFor(LANES.heartbeat)).toBeUndefined();
    });

    it("should recover a stale lane without disturbing the others", async () => {
      const store = memoryStore({ commander: "sess-c", heartbeat: "dead" });
      const runner = vi
        .fn<TurnRunner>()
        .mockRejectedValueOnce(new Error("No conversation found with session ID: dead"))
        .mockResolvedValueOnce(fakeResult("sess-h2"));
      const syl = new SylAgent({ runner, store });

      await syl.ask("tick", LANES.heartbeat);

      expect(syl.sessionIdFor(LANES.heartbeat)).toBe("sess-h2");
      expect(syl.sessionIdFor(LANES.commander)).toBe("sess-c");
    });

    it("should reject a lane name that cannot be a file name", async () => {
      // Lane names become paths in the file-backed store; "../../etc/passwd"
      // must not be one of them.
      const syl = new SylAgent({ runner: announcingRunner(() => "s"), store: memoryStore() });

      await expect(syl.ask("hi", "../escape")).rejects.toThrow(/lane/i);
      expect(() => syl.forLane("has space")).toThrow(/lane/i);
    });
  });

  describe("auto-memory", () => {
    /**
     * Lanes exist to keep transcripts apart. Memory is the one thing that must
     * *not* be kept apart: a fact learned while talking to the Commander is
     * exactly what the morning agenda needs, and the consolidation lane — whose
     * whole job is compacting what the others learned — could otherwise only
     * ever see its own. The reasoning is written out in `memory/auto-memory.ts`.
     */
    it("should send the configured memory directory on every turn", async () => {
      const runner = announcingRunner(() => "sess-1");
      const syl = new SylAgent({
        runner,
        store: memoryStore(),
        autoMemory: autoMemoryAt("/srv/syl/memory"),
      });

      await syl.ask("hello");

      expect(optionsOfCall(runner, 0).autoMemory).toEqual({
        mode: "directory",
        directory: "/srv/syl/memory",
      });
    });

    it("should refuse the consolidation lane any auto-memory, so the dream cannot consolidate itself", async () => {
      // The gap constraint 7's wording does not cover. It forbids writing the
      // dream LOG into the graph; this is neither. Claude Code's auto-memory
      // writes what a turn learned into MEMORY.md, and that index is loaded at
      // the start of EVERY session — so a judgment turn on this lane would have
      // its own speculation read back as experience by the next dream. The
      // corpus contaminates itself with its own output, interleaved with the
      // Commander's real memories in a markdown file with no provenance column
      // to separate them by.
      const runner = announcingRunner(() => "sess-1");
      const syl = new SylAgent({
        runner,
        store: memoryStore(),
        autoMemory: autoMemoryAt("/srv/syl/memory"),
      });

      await syl.forLane("consolidation").ask("consolidate the day");

      expect(optionsOfCall(runner, 0).autoMemory).toEqual({ mode: "off" });
    });

    it("should refuse it even when no memory directory was configured at all", async () => {
      // Auto-memory is ON by default in headless `-p`. So "do not pass a
      // directory" is not the same as "do not write memory" — omitting the
      // option lets the CLI default apply and the dream writes into
      // ~/.claude/projects/<slug>/memory/ instead, which is outside .syl/ and
      // not covered by its gitignore. The lane must assert OFF, not stay quiet.
      const runner = announcingRunner(() => "sess-1");
      const syl = new SylAgent({ runner, store: memoryStore() });

      await syl.forLane("consolidation").ask("consolidate the day");

      expect(optionsOfCall(runner, 0).autoMemory).toEqual({ mode: "off" });
    });

    it("should still keep the consolidation lane's transcript separate", async () => {
      // Turning its memory off must not turn off the reason the lane exists:
      // Syl's inner monologue still must not interleave with the Commander's
      // conversation.
      const runner = announcingRunner((n) => `sess-${n}`);
      const store = memoryStore();
      const syl = new SylAgent({ runner, store, autoMemory: autoMemoryAt("/srv/syl/memory") });

      await syl.ask("hello");
      await syl.forLane("consolidation").ask("consolidate");

      expect(store.read("commander")).not.toBe(store.read("consolidation"));
      expect(store.read("consolidation")).toBeDefined();
    });

    it("should give every lane that may remember the same memory directory", async () => {
      // The rule this used to state was "every lane, no exceptions", and it was
      // right about the ones it listed and wrong about the one it swept in with
      // them. Sharing is correct wherever memory is EXPERIENCE — a fact learned
      // in conversation must reach the morning agenda. `consolidation` is not
      // that: its output is speculation about the corpus, so it is excluded
      // here and asserted off in its own test above. Restated rather than
      // relaxed, so the sharing guarantee is still pinned for the lanes it
      // genuinely covers.
      const runner = announcingRunner((n) => `sess-${n}`);
      const syl = new SylAgent({
        runner,
        store: memoryStore(),
        autoMemory: autoMemoryAt("/srv/syl/memory"),
      });

      await syl.ask("hi", LANES.commander);
      await syl.ask("tick", LANES.heartbeat);
      await syl.ask("morning", LANES.agenda);

      const directories = [0, 1, 2].map((n) => optionsOfCall(runner, n).autoMemory);
      expect(new Set(directories.map((m) => JSON.stringify(m))).size).toBe(1);
      expect(directories[0]).toEqual({ mode: "directory", directory: "/srv/syl/memory" });
    });

    it("should keep every remembering lane out of MEMORYLESS_LANES, so the split stays deliberate", async () => {
      // Guards the list itself rather than its current contents: if someone
      // adds a lane to MEMORYLESS_LANES, the lanes above stop sharing memory
      // and this says so at the point of change instead of at the point of
      // confusion.
      expect(MEMORYLESS_LANES.has(LANES.commander)).toBe(false);
      expect(MEMORYLESS_LANES.has(LANES.heartbeat)).toBe(false);
      expect(MEMORYLESS_LANES.has(LANES.agenda)).toBe(false);
      expect(MEMORYLESS_LANES.has(LANES.consolidation)).toBe(true);
    });

    it("should carry the memory directory into a lane-scoped view", async () => {
      // `forLane` builds a new agent; a field forgotten there is a lane that
      // silently remembers nothing.
      const runner = announcingRunner(() => "sess-1");
      const syl = new SylAgent({
        runner,
        store: memoryStore(),
        autoMemory: autoMemoryAt("/srv/syl/memory"),
      });

      await syl.forLane(LANES.heartbeat).ask("tick");

      expect(optionsOfCall(runner, 0).autoMemory).toEqual({
        mode: "directory",
        directory: "/srv/syl/memory",
      });
    });

    it("should not let an incidental turnOptions move where memory lives", async () => {
      const runner = announcingRunner(() => "sess-1");
      const syl = new SylAgent({
        runner,
        store: memoryStore(),
        autoMemory: autoMemoryAt("/srv/syl/memory"),
        turnOptions: { autoMemory: autoMemoryAt("/tmp/somewhere-else") },
      });

      await syl.ask("hello");

      expect(optionsOfCall(runner, 0).autoMemory).toEqual({
        mode: "directory",
        directory: "/srv/syl/memory",
      });
    });

    it("should say nothing about memory when the agent was not configured with any", async () => {
      // An agent nobody told about memory must not quietly assert a directory;
      // `runTurn` only checks the init frame when it was asked to.
      const runner = announcingRunner(() => "sess-1");

      await new SylAgent({ runner, store: memoryStore() }).ask("hello");

      expect(optionsOfCall(runner, 0).autoMemory).toBeUndefined();
    });
  });

  describe("crash-safe session ids", () => {
    it("should persist the session id before the turn runs, not after it succeeds", async () => {
      // The window: the CLI creates the session on disk, then the process dies
      // before init. If the id is only learned from the result, that
      // conversation is unreachable forever.
      const store = memoryStore();
      const runner = vi.fn<TurnRunner>(async (_prompt, options) => {
        options.onSessionId?.("sess-born");
        throw new Error("claude exited with code 1 before the init handshake. stderr: boom");
      });

      await expect(new SylAgent({ runner, store }).ask("hi")).rejects.toThrow(/init handshake/);

      expect(store.read(LANES.commander)).toBe("sess-born");
    });

    it("should resume the id a crashed turn left behind", async () => {
      const store = memoryStore();
      const runner = vi
        .fn<TurnRunner>()
        .mockImplementationOnce(async (_prompt, options) => {
          options.onSessionId?.("sess-born");
          throw new Error("claude exited with code 1 before the init handshake");
        })
        .mockImplementationOnce(async () => fakeResult("sess-born"));
      const syl = new SylAgent({ runner, store });

      await syl.ask("hi").catch(() => undefined);
      await syl.ask("still there?");

      expect(optionsOfCall(runner, 1).resume).toBe("sess-born");
    });

    it("should not persist an announced id from a retry that then fails outright", async () => {
      // A resume failure clears the lane and retries fresh. If that retry also
      // dies, the lane must hold the *new* id — the old one is known dead.
      const store = memoryStore({ commander: "dead" });
      const runner = vi
        .fn<TurnRunner>()
        .mockImplementationOnce(async () => {
          throw new Error("No conversation found with session ID: dead");
        })
        .mockImplementationOnce(async (_prompt, options) => {
          options.onSessionId?.("sess-second");
          throw new Error("claude exited with code 1 before the init handshake");
        });

      await expect(new SylAgent({ runner, store }).ask("hi")).rejects.toThrow(/init handshake/);

      expect(store.read(LANES.commander)).toBe("sess-second");
    });
  });

  describe("memorySessionStore", () => {
    it("should keep lanes apart within the process", () => {
      const store = memorySessionStore();

      store.write("commander", "sess-c");
      store.write("heartbeat", "sess-h");

      expect(store.read("commander")).toBe("sess-c");
      expect(store.read("heartbeat")).toBe("sess-h");
    });

    it("should report an unwritten lane as absent, and forget one on clear", () => {
      const store = memorySessionStore();
      store.write("commander", "sess-c");

      store.clear("commander");

      expect(store.read("commander")).toBeUndefined();
      expect(store.read("agenda")).toBeUndefined();
    });

    it("should reject an invalid lane name just as the file-backed store does", () => {
      // The two stores are interchangeable, so they must agree on what a lane
      // is. A name that only fails once it reaches disk is a latent surprise.
      const store = memorySessionStore();

      expect(() => store.write("../escape", "sess")).toThrow(/lane/i);
      expect(() => store.read("a/b")).toThrow(/lane/i);
    });

    it("should be the default, giving continuity for the life of the process only", async () => {
      const runner = announcingRunner(() => "sess-default");
      const syl = new SylAgent({ runner });

      await syl.ask("first");
      await syl.ask("second");

      expect(optionsOfCall(runner, 1).resume).toBe("sess-default");
      // A fresh agent has a fresh store, which is what "no continuity" means.
      expect(new SylAgent({ runner }).sessionId).toBeUndefined();
    });
  });

  describe("fileSessionStore", () => {
    it("should keep each lane in its own file", () => {
      const dir = tempDir();
      const store = fileSessionStore(dir);

      store.write("commander", "sess-c");
      store.write("heartbeat", "sess-h");

      expect(store.read("commander")).toBe("sess-c");
      expect(store.read("heartbeat")).toBe("sess-h");
      expect(readFileSync(join(dir, "heartbeat"), "utf8")).toBe("sess-h");
    });

    it("should report an unwritten lane as absent rather than throwing", () => {
      const store = fileSessionStore(join(tempDir(), "not", "created", "yet"));

      expect(store.read("commander")).toBeUndefined();
    });

    it("should treat an empty or whitespace-only file as no session", () => {
      // How a cleared lane looks on disk, and how a truncated write looks too.
      const dir = tempDir();
      writeFileSync(join(dir, "commander"), "  \n", "utf8");

      expect(fileSessionStore(dir).read("commander")).toBeUndefined();
    });

    it("should forget a lane on clear", () => {
      const dir = tempDir();
      const store = fileSessionStore(dir);
      store.write("commander", "sess-c");

      store.clear("commander");

      expect(store.read("commander")).toBeUndefined();
    });

    it("should refuse a lane name that would escape its directory", () => {
      const store = fileSessionStore(tempDir());

      expect(() => store.write("../outside", "sess")).toThrow(/lane/i);
      expect(() => store.read("a/b")).toThrow(/lane/i);
    });
  });
});
