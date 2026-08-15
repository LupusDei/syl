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
import { PRECEDENCE_SECTION } from "../../src/harness/turn-context.js";
import { autoMemoryAt } from "../../src/memory/auto-memory.js";

/**
 * Two lanes that are not in {@link LANES}, for the tests about lanes as a
 * mechanism rather than about today's list of them.
 *
 * `Lane` is a plain string on purpose — a caller may add one without touching
 * `harness/agent.ts` — and these are what that looks like. They are used where
 * a test needs two ordinary remembering lanes, which the named list no longer
 * supplies: `commander` is the only one left that is not memoryless, since the
 * Commander merged her unattended turns onto it (2026-08-11).
 */
const A_LANE = "research";
const ANOTHER_LANE = "briefing";

function fakeResult(sessionId: string, text = "ok"): TurnResult {
  return {
    sessionId,
    text,
    // No tool call in a double, so the two are the same string.
    spoken: text,
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

  it("should give her what she remembers as part of who she is, not as a second message", async () => {
    // She was asked "what is your personality?" and answered by describing
    // SOUL.md and naming the agent that built her. Identity arrived as a
    // config file and memory arrived not at all, so the ambient context — a
    // repository — won. One system prompt, identity then memory, is what makes
    // "you know this about him" different from "here is some data".
    const runner = announcingRunner(() => "sess-1");
    const agent = new SylAgent({
      runner,
      store: memoryStore(),
      soul: "You are Syl.",
      recall: () => "He is teaching his daughter piano.",
    });

    await agent.ask("morning");

    const prompt = optionsOfCall(runner, 0).systemPrompt ?? "";
    expect(prompt).toContain("You are Syl.");
    expect(prompt).toContain("He is teaching his daughter piano.");
    expect(prompt.indexOf("You are Syl.")).toBeLessThan(
      prompt.indexOf("He is teaching his daughter piano."),
    );
  });

  it("should send the soul unchanged when she remembers nothing yet", async () => {
    // An empty projection is the ordinary state of a new install, not a fault.
    // Appending an empty section would tell her she has a memory and that it is
    // blank, which reads as damage; saying nothing lets SOUL.md's own line
    // about being early do the work.
    const runner = announcingRunner(() => "sess-1");
    const agent = new SylAgent({
      runner,
      store: memoryStore(),
      soul: "You are Syl.",
      recall: () => "",
    });

    await agent.ask("morning");

    expect(optionsOfCall(runner, 0).systemPrompt).toBe("You are Syl.");
  });

  it("should ask what she remembers on every turn, so a night of consolidation lands", async () => {
    // Read per turn rather than captured at construction: the projection is
    // rebuilt nightly and the service outlives the night. A value read once at
    // boot would leave her remembering the day she started, forever.
    const runner = announcingRunner((n) => `sess-${n}`);
    let generation = 0;
    const agent = new SylAgent({
      runner,
      store: memoryStore(),
      soul: "You are Syl.",
      recall: () => `memory ${(generation += 1)}`,
    });

    await agent.ask("one");
    await agent.ask("two");

    expect(optionsOfCall(runner, 0).systemPrompt).toContain("memory 1");
    expect(optionsOfCall(runner, 1).systemPrompt).toContain("memory 2");
  });

  it("should send her precedence ladder exactly once, from SOUL.md and nowhere else", async () => {
    // Composition moved to `harness/turn-context.ts`, but the LADDER did not:
    // it is prose in SOUL.md § "What outranks what", in her own voice. The
    // module enforces the same ordering and emits no second copy — two copies
    // in two voices drift, and she ends up with two answers to one question.
    const runner = announcingRunner(() => "sess-1");
    const soul = readFileSync(new URL("../../../SOUL.md", import.meta.url), "utf8");
    const agent = new SylAgent({
      runner,
      store: memoryStore(),
      soul,
      recall: () => "He prefers very short answers.",
    });

    await agent.ask("morning");

    const prompt = optionsOfCall(runner, 0).systemPrompt ?? "";
    expect(prompt.split(PRECEDENCE_SECTION)).toHaveLength(2);
    expect(prompt).toBe(`${soul}\n\n---\n\nHe prefers very short answers.`);
  });

  it("should let a contributor add to the prompt without touching this file", async () => {
    // `syl-009` adds tool schemas. It must not have to edit the composition,
    // which is exactly how three tracks end up each believing they own a slice.
    const runner = announcingRunner(() => "sess-1");
    const agent = new SylAgent({
      runner,
      store: memoryStore(),
      soul: "You are Syl.",
      recall: () => "He has a daughter.",
      contributors: [{ id: "tools", kind: "capability", text: "TOOL SCHEMAS" }],
    });

    await agent.ask("morning");

    const prompt = optionsOfCall(runner, 0).systemPrompt ?? "";
    expect(prompt.indexOf("You are Syl.")).toBeLessThan(prompt.indexOf("He has a daughter."));
    expect(prompt.indexOf("He has a daughter.")).toBeLessThan(prompt.indexOf("TOOL SCHEMAS"));
  });

  it("should let contributors differ per lane, the way auto-memory already does", async () => {
    // MEMORYLESS_LANES is the same argument one layer down: a lane that must not
    // carry something is a decision made per lane, not per agent.
    const runner = announcingRunner(() => "sess-1");
    const agent = new SylAgent({
      runner,
      store: memoryStore(),
      soul: "You are Syl.",
      contributors: (lane) =>
        lane === LANES.consolidation ? [] : [{ id: "tools", kind: "capability", text: "TOOL SCHEMAS" }],
    });

    await agent.ask("dream", LANES.consolidation);
    await agent.ask("morning", ANOTHER_LANE);

    expect(optionsOfCall(runner, 0).systemPrompt).not.toContain("TOOL SCHEMAS");
    expect(optionsOfCall(runner, 1).systemPrompt).toContain("TOOL SCHEMAS");
  });

  it("should refuse a contributor that tries to be a second memory", async () => {
    // The double registration the module exists to catch: two tracks each
    // believing they own the memory slice, and the prompt quietly carrying both.
    const runner = announcingRunner(() => "sess-1");
    const agent = new SylAgent({
      runner,
      store: memoryStore(),
      soul: "You are Syl.",
      recall: () => "He has a daughter.",
      contributors: [{ id: "working-memory", kind: "memory", text: "he has a son" }],
    });

    await expect(agent.ask("morning")).rejects.toThrow(/working-memory/);
  });

  it("should carry contributors into a lane-scoped view", async () => {
    const runner = announcingRunner(() => "sess-1");
    const agent = new SylAgent({
      runner,
      store: memoryStore(),
      soul: "You are Syl.",
      contributors: [{ id: "tools", kind: "capability", text: "TOOL SCHEMAS" }],
    });

    await agent.forLane("agenda").ask("morning");

    expect(optionsOfCall(runner, 0).systemPrompt).toContain("TOOL SCHEMAS");
  });

  it("should carry recall into a lane-scoped view", async () => {
    // forLane builds a new agent; a field forgotten there is a lane that
    // silently remembers nothing about him.
    const runner = announcingRunner(() => "sess-1");
    const agent = new SylAgent({
      runner,
      store: memoryStore(),
      soul: "You are Syl.",
      recall: () => "He is teaching his daughter piano.",
    });

    await agent.forLane("agenda").ask("morning");

    expect(optionsOfCall(runner, 0).systemPrompt).toContain("daughter piano");
  });

  it("should take her turns in her OWN directory, not wherever the service was launched", async () => {
    // Asked who she was, she answered: "running as Claude Code inside
    // /Users/Reason/code/ai/syl, the repo that builds the persistent version of
    // me... an engineer on this codebase". She was not confused. She was
    // accurate. The service is launched from the repo, cwd defaulted to
    // process.cwd(), and Claude Code loads what it finds there: CLAUDE.md's
    // engineering instructions, the SessionStart hook that injects the beads
    // workflow, and the beads memories. A soul cannot out-argue the room she is
    // standing in.
    const runner = announcingRunner(() => "sess-1");
    const agent = new SylAgent({
      runner,
      store: memoryStore(),
      soul: "You are Syl.",
      turnOptions: { cwd: "/home/syl" },
    });

    await agent.ask("who are you?");

    expect(optionsOfCall(runner, 0).cwd).toBe("/home/syl");
  });

  // Parameterised over LANES rather than over today's names, so a lane added
  // later FAILS until somebody decides what container it gets instead of
  // inheriting silence. That is exactly how her unattended turns came to wake
  // her in the source repository, back when they had lanes of their own.
  describe.each(Object.values(LANES))("the %s lane", (lane) => {
    it("should carry her home, her empty built-in surface, and no ambient settings", async () => {
      // Three separate mechanisms and every one of them load-bearing. `cwd`
      // decides which CLAUDE.md she reads and therefore who she thinks she is.
      // `tools` empties the BUILT-INS — and only those; an attached MCP server
      // keeps every tool it exposes, measured 2026-08-10 as 0 built-ins and 59
      // MCP tools under `--tools ""`. `settingSources` is the one that survived
      // the other two: hooks and plugins are not read from the working
      // directory, so moving her home did nothing to them.
      const runner = announcingRunner(() => "sess-1");
      const agent = new SylAgent({
        runner,
        store: memoryStore(),
        turnOptions: { cwd: "/home/syl", tools: "", settingSources: "" },
      });

      await agent.forLane(lane).ask("who are you?");

      const options = optionsOfCall(runner, 0);
      expect(options.cwd).toBe("/home/syl");
      expect(options.tools).toBe("");
      expect(options.settingSources).toBe("");
    });

    it("should attach no ambient MCP servers", async () => {
      // Not "only Syl's servers" — none, unless one is named. Asked to say
      // hello on her first live turn she answered through
      // `mcp__adjutant__send_message`, development tooling, because it was
      // simply there; the reply never reached the Commander's phone.
      const runner = announcingRunner(() => "sess-1");
      const agent = new SylAgent({ runner, store: memoryStore() });

      await agent.forLane(lane).ask("who are you?");

      expect(optionsOfCall(runner, 0).strictMcpConfig).toBe(true);
      expect(optionsOfCall(runner, 0).mcpConfig).toBeUndefined();
    });

    it("should say which lane it is, so a wrapper can tell one transcript from another", async () => {
      // A runner wrapper sees a prompt and an options object and nothing else,
      // so anything it needs to know has to be in one of them.
      const runner = announcingRunner(() => "sess-1");
      const agent = new SylAgent({ runner, store: memoryStore() });

      await agent.forLane(lane).ask("who are you?");

      expect(optionsOfCall(runner, 0).lane).toBe(lane);
    });

    it("should never mark a turn as the Commander's own words unless the caller said so", async () => {
      // THE ONE THAT PROTECTS HIS SLEEP. `index.ts` records the prompt of a
      // turn as evidence of what he said, and `harness/urgency.ts` checks a
      // claimed urgent phrase against that file — so a turn wrongly marked can
      // quote the words it was woken with and pierce quiet hours.
      //
      // It used to be inferred: first from `mcpConfig !== undefined`, then from
      // the lane being `commander`. Both were exactly right until they were
      // silently wrong, and the second stopped being true the day the Commander
      // moved her unattended turns onto his lane. So it is asked and not
      // inferred, and ABSENT MEANS NO — including on his own lane, where every
      // scheduled turn she takes now runs.
      const runner = announcingRunner(() => "sess-1");
      const agent = new SylAgent({ runner, store: memoryStore() });

      await agent.forLane(lane).ask("nobody asked you for anything");

      expect(optionsOfCall(runner, 0).hisWords).toBe(false);
    });

    it("should not let a caller's options award themselves the Commander's voice", async () => {
      // Same shape as the lane forgery test below, and a sharper consequence:
      // a turn that could set this in its own `turnOptions` could grant itself
      // the quiet-hours bypass. Written after the caller's overrides, so the
      // last word belongs to the agent.
      const runner = announcingRunner(() => "sess-1");
      const agent = new SylAgent({
        runner,
        store: memoryStore(),
        turnOptions: { hisWords: true } as TurnOptions,
      });

      await agent.forLane(lane).ask("nobody asked you for anything");

      expect(optionsOfCall(runner, 0).hisWords).toBe(false);
    });

    it("should mark a turn as his when the caller holding his message says so", async () => {
      // The other half: the safe default is worth nothing if the real path
      // cannot get through it. `services/conversation-service.ts` is the one
      // caller entitled to pass this, because it holds a message off the store
      // that he authenticated to send.
      const runner = announcingRunner(() => "sess-1");
      const agent = new SylAgent({ runner, store: memoryStore() });

      await agent.ask("wake me for this one, whatever the hour", lane, { hisWords: true });

      expect(optionsOfCall(runner, 0).hisWords).toBe(true);
    });

    it("should not let a caller's options claim to be a different lane", async () => {
      // The whole value of the field is that it cannot be forged: it is written
      // after the caller's overrides, not before.
      const runner = announcingRunner(() => "sess-1");
      const agent = new SylAgent({
        runner,
        store: memoryStore(),
        turnOptions: { lane: LANES.commander },
      });

      await agent.forLane(lane).ask("who are you?");

      expect(optionsOfCall(runner, 0).lane).toBe(lane);
    });
  });

  it("should take her turns with no built-in tools at all", async () => {
    // The Commander's call, 2026-08-10: "let's try it out without the tools."
    // She is an assistant, not an engineer — everything she owns runs through
    // the service. `--tools ""`, not `--allowedTools`: the latter pre-approves
    // names on a surface that still exists, the former sets what exists at all,
    // and only the latter makes a turn incapable of acting.
    const runner = announcingRunner(() => "sess-1");
    const agent = new SylAgent({
      runner,
      store: memoryStore(),
      turnOptions: { tools: "" },
    });

    await agent.ask("who are you?");

    expect(optionsOfCall(runner, 0).tools).toBe("");
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
      // What a lane still guarantees, after three of them were merged onto the
      // Commander's: two lanes are two transcripts. The dream must not read
      // back its own speculation as though it were experience, and the
      // extraction turn must not carry a pasted article into anything.
      const store = memoryStore();
      const runner = announcingRunner((n) => `sess-${n}`);
      const syl = new SylAgent({ runner, store });

      await syl.ask("first on one", ANOTHER_LANE);
      await syl.ask("first on the other", A_LANE);
      await syl.ask("second on one", ANOTHER_LANE);
      await syl.ask("second on the other", A_LANE);

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
      expect(store.read(A_LANE)).toBeUndefined();
    });

    it("should expose a lane-scoped agent so a scheduled job can hold a stable handle", async () => {
      const store = memoryStore();
      const runner = announcingRunner((n) => `sess-${n}`);
      const scoped = new SylAgent({ runner, store }).forLane(A_LANE);

      await scoped.ask("tick");
      await scoped.ask("tock");

      expect(scoped.lane).toBe(A_LANE);
      expect(optionsOfCall(runner, 1).resume).toBe("sess-0");
      expect(store.read(LANES.commander)).toBeUndefined();
    });

    it("should reset only the lane it was asked to reset", async () => {
      const store = memoryStore({ commander: "sess-c", research: "sess-h" });
      const runner = announcingRunner(() => "fresh");
      const syl = new SylAgent({ runner, store });

      syl.reset(A_LANE);

      expect(syl.sessionIdFor(LANES.commander)).toBe("sess-c");
      expect(syl.sessionIdFor(A_LANE)).toBeUndefined();
    });

    it("should recover a stale lane without disturbing the others", async () => {
      const store = memoryStore({ commander: "sess-c", research: "dead" });
      const runner = vi
        .fn<TurnRunner>()
        .mockRejectedValueOnce(new Error("No conversation found with session ID: dead"))
        .mockResolvedValueOnce(fakeResult("sess-h2"));
      const syl = new SylAgent({ runner, store });

      await syl.ask("tick", A_LANE);

      expect(syl.sessionIdFor(A_LANE)).toBe("sess-h2");
      expect(syl.sessionIdFor(LANES.commander)).toBe("sess-c");
    });

    it("should take one turn at a time on a lane, so two --resume processes never share a session", async () => {
      // A turn is `claude --resume <session id>`, and two of those at once are
      // two processes reading and appending one transcript. Nothing used to be
      // able to arrange it: every unattended turn had a lane of its own, so the
      // per-conversation queue in `ConversationService` was accidentally a
      // per-session queue too. Merging her turns onto his lane ends that — the
      // hour fires from the job runner while he is typing — so the exclusion
      // has to be stated here, where the session id actually lives.
      const store = memoryStore();
      let open = 0;
      let overlapped = false;
      const order: string[] = [];
      const runner = vi.fn<TurnRunner>(async (prompt, options) => {
        open += 1;
        if (open > 1) overlapped = true;
        await new Promise((resolve) => setTimeout(resolve, 5));
        open -= 1;
        order.push(prompt);
        options.onSessionId?.("sess-1");
        return fakeResult("sess-1");
      });
      const syl = new SylAgent({ runner, store });

      await Promise.all([syl.ask("his message"), syl.ask("her hour"), syl.ask("his next")]);

      expect(overlapped, "two turns ran against one session id at once").toBe(false);
      expect(order).toEqual(["his message", "her hour", "his next"]);
    });

    it("should let a lane go again after a turn throws, rather than wedging it forever", async () => {
      // A queue that only released on success would turn one failed turn into a
      // lane that never speaks again — which is a far worse failure than the
      // one the queue exists to prevent.
      const runner = vi
        .fn<TurnRunner>()
        .mockRejectedValueOnce(new Error("claude exited 1"))
        .mockResolvedValueOnce(fakeResult("sess-2"));
      const syl = new SylAgent({ runner, store: memoryStore() });

      await expect(syl.ask("first")).rejects.toThrow(/exited 1/);
      await expect(syl.ask("second")).resolves.toMatchObject({ sessionId: "sess-2" });
    });

    it("should report the lane busy while a turn holds it, so a low-priority job can stand aside", async () => {
      // What `jobs/heartbeat-job.ts` asks before spending an hour. Read off the
      // same queue `ask` uses — a second bookkeeping scheme over one session id
      // is the bug this queue exists to prevent, wearing a hat.
      let release = (): void => undefined;
      const runner = vi.fn<TurnRunner>(async (_prompt, options) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        options.onSessionId?.("sess-1");
        return fakeResult("sess-1");
      });
      const syl = new SylAgent({ runner, store: memoryStore() });

      expect(syl.busy()).toBe(false);
      const turn = syl.ask("his message");
      expect(syl.busy()).toBe(true);
      // Another lane is another transcript, so it is not busy for this one.
      expect(syl.busy(A_LANE)).toBe(false);

      // The runner starts on a microtask, so `release` is not the real one
      // until the queue has actually handed the turn over.
      await Promise.resolve();
      await Promise.resolve();
      release();
      await turn;
      expect(syl.busy()).toBe(false);
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
      await syl.ask("tick", A_LANE);
      await syl.ask("morning", ANOTHER_LANE);

      const directories = [0, 1, 2].map((n) => optionsOfCall(runner, n).autoMemory);
      expect(new Set(directories.map((m) => JSON.stringify(m))).size).toBe(1);
      expect(directories[0]).toEqual({ mode: "directory", directory: "/srv/syl/memory" });
    });

    it("should keep every remembering lane out of MEMORYLESS_LANES, so the split stays deliberate", async () => {
      // Guards the list itself rather than its current contents: if someone
      // adds a lane to MEMORYLESS_LANES, the lanes above stop sharing memory
      // and this says so at the point of change instead of at the point of
      // confusion. `commander` matters most of the four now — every unattended
      // turn she takes runs on it, so putting it in that set would silently
      // switch auto-memory off for all of them at once.
      expect(MEMORYLESS_LANES.has(LANES.commander)).toBe(false);
      expect(MEMORYLESS_LANES.has(A_LANE)).toBe(false);
      expect(MEMORYLESS_LANES.has(ANOTHER_LANE)).toBe(false);
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

      await syl.forLane(A_LANE).ask("tick");

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
