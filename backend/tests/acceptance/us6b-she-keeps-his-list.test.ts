import type { Todo } from "@syl/shared";
import { afterEach, describe, expect, it } from "vitest";

import type { SylEvent } from "../../src/harness/protocol.js";
import type { TurnResult, TurnRunner } from "../../src/harness/session.js";
import { INTERACTIVE_CONVERSATION_ID } from "../../src/services/database.js";
import { expectData, startLiveService, type LiveService } from "../helpers/live-service.js";
import {
  McpServerProcess,
  serversDeclaredIn,
  type McpToolDescription,
  type McpToolResult,
} from "../helpers/mcp-client.js";

/**
 * **US6, the other half — she keeps his list.**
 *
 * > As the Commander, I want to hand her a to-do in the middle of a sentence
 * > and tell her when it is done, so that the list is hers to keep and not one
 * > more thing I maintain.
 *
 * `us6-she-can-act` proves the reminder verb end to end. This proves the three
 * that make a list: he says *"add milk to my list"* and a row exists; he says
 * *"mark the dentist thing done"* and the row he meant is closed — reached the
 * way the schema says it is reached, by looking at what is outstanding and
 * taking the id from there.
 *
 * ## What is real here, and the one thing that is not
 *
 * Real: the HTTP write path, `ConversationService`, the per-lane queue,
 * `SylAgent`, whatever `bootstrap` hands the commander lane, the MCP server as
 * a spawned process speaking real MCP over stdio, the tools, their HTTP client,
 * the agent credential, the routes, `TodoService`, and a real SQLite file.
 *
 * Substituted: **the model, and only the model.** A test may not spend a
 * subscription turn and may not depend on what a language model decides, so the
 * stand-in does the one thing a model does — read his sentence, pick a verb,
 * fill the fields — and is otherwise deliberately stupid: two regular
 * expressions and a substring match. If a verb's schema demands something that
 * cannot be produced from what he said, this test fails and names the field,
 * which is `T006`'s "schemas the model can actually satisfy" as an executable
 * requirement rather than an aspiration.
 *
 * ## The third case is the one worth the file
 *
 * `finish_todo` is the only verb that takes something away, and the dangerous
 * failure is not a typo — it is her acting on an id she half-remembers from an
 * earlier turn. So the last story here is a stand-in that gets it **wrong**,
 * and the thing asserted is that his list is untouched and that she says so.
 * Constraint 4 forbids the silent discard; a wrong guess that costs a sentence
 * instead of an item is the shape it has to have.
 */

/** His to-do that already exists, put there over HTTP exactly as his phone does. */
const THE_DENTIST = "Call the dentist about the crown";

const WHAT_HE_SAID_ADDING = "add milk to my list";
const WHAT_HE_SAID_FINISHING = "mark the dentist thing done";

const ADD_TODO = "add_todo";
const FINISH_TODO = "finish_todo";
const WHATS_OUTSTANDING = "whats_outstanding";

/**
 * The envelope, as a client of the process reads it.
 *
 * Declared here rather than imported: this JSON crosses a process boundary, so
 * the test reads it the way anything else on the far side would. A shape read
 * back out of the module that wrote it agrees with itself by construction.
 */
interface Envelope {
  readonly ok: boolean;
  readonly action: string;
  readonly subject?: unknown;
  readonly reason?: string;
}

// --------------------------------------------------------------------------
// What a model knows, and nothing else.
// --------------------------------------------------------------------------

/** "add milk to my list" -> `milk`. */
const HE_IS_ADDING = /add (?<what>.+?) to (?:my|the) list/iu;
/** "mark the dentist thing done" -> `dentist`. */
const HE_IS_FINISHING = /mark (?:the )?(?<what>.+?)(?: thing)? (?:as )?done/iu;

/**
 * Arguments assembled from the tool's own schema and a handful of things a
 * model actually has.
 *
 * Read from the schema rather than hard-coded, so this test does not pre-empt
 * field names it does not own. What it insists on is narrower and is the
 * requirement worth holding: every required field can be answered from his
 * sentence, the list she was shown, and why he wants it.
 */
function argumentsAModelCouldProduce(
  tool: McpToolDescription,
  known: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const properties = Object.keys(tool.inputSchema?.properties ?? {});
  const required = tool.inputSchema?.required ?? [];

  const args: Record<string, unknown> = {};
  const unanswerable: string[] = [];

  for (const field of new Set([...properties, ...required])) {
    const value = known[field];
    if (value === undefined) {
      if (required.includes(field)) unanswerable.push(field);
      continue;
    }
    args[field] = value;
  }

  if (unanswerable.length > 0) {
    throw new Error(
      `${tool.name} requires ${unanswerable.join(", ")}, and nothing the Commander said ` +
        `supplies it. A schema a model cannot satisfy from what he said is a tool she cannot ` +
        `use (T006). Either the tool should not require it, or this stand-in should learn the ` +
        `field name.`,
    );
  }
  return args;
}

/** What the stand-in saw and did, so an assertion can say why it failed. */
interface Hands {
  mcpConfig: string | null;
  readonly advertised: string[];
  readonly called: { readonly name: string; readonly args: Record<string, unknown> }[];
  /** The refusal she was given, when a verb said no. Not a test failure. */
  refusal: string | null;
  /** The reason she could not act at all. This one IS a test failure. */
  failure: string | null;
}

function freshHands(): Hands {
  return { mcpConfig: null, advertised: [], called: [], refusal: null, failure: null };
}

/** Call a verb over MCP and read the pinned envelope back out of the result. */
type CallVerb = (name: string, args: Record<string, unknown>) => Promise<Envelope>;

/** What a turn does once it has her tools in front of it. */
type Act = (tools: readonly McpToolDescription[], call: CallVerb) => Promise<string>;

function toolNamed(tools: readonly McpToolDescription[], name: string): McpToolDescription {
  const found = tools.find((tool) => tool.name === name);
  if (found === undefined) {
    throw new Error(
      `she was not offered ${name}. Advertised: ` +
        `${tools.length === 0 ? "nothing" : tools.map((tool) => tool.name).join(", ")}.`,
    );
  }
  return found;
}

/** Spawn every server the declaration names, and act on the one that has her verbs. */
async function useHerTools(configPath: string, hands: Hands, act: Act): Promise<string> {
  const servers = serversDeclaredIn(configPath);
  if (servers.length === 0) {
    throw new Error(`the MCP config at ${configPath} names no servers, so she was given no tools.`);
  }

  for (const [name, server] of servers) {
    const process_ = McpServerProcess.start(server.command, server.args ?? [], server.env ?? {});
    try {
      await process_.handshake("syl-us6b-acceptance");

      const listed = (await process_.request("tools/list", {})) as {
        tools?: readonly McpToolDescription[];
      };
      const tools = listed.tools ?? [];
      hands.advertised.push(...tools.map((tool) => `${name}:${tool.name}`));
      if (!tools.some((tool) => tool.name === ADD_TODO)) continue;

      const call: CallVerb = async (verb, args) => {
        hands.called.push({ name: verb, args });
        const result = (await process_.request("tools/call", {
          name: verb,
          arguments: args,
        })) as McpToolResult;
        const said = (result.content ?? []).map((block) => block.text ?? "").join("\n");

        // The envelope is the first content block and is the whole of it as
        // JSON. Parsing it here rather than reading the text is the point: a
        // caller programmatically reads one block and gets the pinned shape.
        const envelope = JSON.parse(said) as Envelope;
        if (envelope.ok !== true) {
          // A refusal is an ANSWER, not a crash — she has something to say. It
          // is recorded and re-thrown so the turn text carries it, exactly as a
          // model would repeat it to him.
          hands.refusal = envelope.reason ?? said;
          throw new Error(`${verb} refused: ${hands.refusal}`);
        }
        return envelope;
      };

      return await act(tools, call);
    } finally {
      process_.stop();
    }
  }

  throw new Error(
    `no server in ${configPath} offers ${ADD_TODO}. Advertised: ` +
      `${hands.advertised.length === 0 ? "nothing" : hands.advertised.join(", ")}.`,
  );
}

/**
 * A model that keeps his list.
 *
 * The one substitution. It stands in for the model's judgement — "he is handing
 * me a to-do, so call the verb that makes one" — and for nothing else: the
 * tools it reaches are the ones the running service handed this turn, spoken to
 * over real MCP.
 *
 * `wrongId`, when given, is a model that has half-remembered an id from an
 * earlier turn and finishes it without looking. That is not a strawman; it is
 * the exact failure `finish_todo` is shaped around.
 */
function aModelThatKeepsHisList(hands: Hands, wrongId?: string): TurnRunner {
  return async (prompt, options): Promise<TurnResult> => {
    const sessionId = options.resume ?? options.sessionId ?? "us6b-session";
    options.onSessionId?.(sessionId);

    let text: string;

    try {
      if (options.mcpConfig === undefined) {
        throw new Error(
          "the commander lane's turn carried no MCP config, so this turn had no way to do " +
            "anything but talk. That is syl-act1 exactly: text, and no action.",
        );
      }
      hands.mcpConfig = options.mcpConfig;

      text = await useHerTools(options.mcpConfig, hands, async (tools, call) => {
        const adding = HE_IS_ADDING.exec(prompt)?.groups?.["what"];
        if (adding !== undefined) {
          const envelope = await call(
            ADD_TODO,
            argumentsAModelCouldProduce(toolNamed(tools, ADD_TODO), {
              text: adding.trim(),
              because: "He asked me to, just now.",
            }),
          );
          return `On the list: ${(envelope.subject as Todo).text}`;
        }

        const finishing = HE_IS_FINISHING.exec(prompt)?.groups?.["what"];
        if (finishing === undefined) {
          throw new Error(`this stand-in does not know what to do with "${prompt}".`);
        }

        // The id comes from the list, which is what `whats_outstanding` says it
        // is for and the only place she can honestly get one.
        const id =
          wrongId ??
          (await (async () => {
            const open = await call(
              WHATS_OUTSTANDING,
              argumentsAModelCouldProduce(toolNamed(tools, WHATS_OUTSTANDING), { of: "todos" }),
            );
            const todos = (open.subject as { todos?: readonly Todo[] }).todos ?? [];
            const match = todos.find((todo) =>
              todo.text.toLowerCase().includes(finishing.trim().toLowerCase()),
            );
            if (match === undefined) {
              throw new Error(
                `nothing outstanding matches "${finishing}". She was shown: ` +
                  `${todos.map((todo) => todo.text).join("; ") || "nothing"}.`,
              );
            }
            return match.id;
          })());

        const envelope = await call(
          FINISH_TODO,
          argumentsAModelCouldProduce(toolNamed(tools, FINISH_TODO), {
            id,
            because: "He told me it was done.",
          }),
        );
        return `Off the list: ${(envelope.subject as Todo).text}`;
      });
    } catch (error) {
      // Recorded rather than thrown, so an assertion can say WHY the row did or
      // did not change instead of only that it did not.
      const said = error instanceof Error ? error.message : String(error);
      if (hands.refusal === null) hands.failure = said;
      text = `I could not: ${said}`;
    }

    // `turn.tool` is the record of what she did on his machine (US3), and it
    // only exists if the harness sees the call.
    const events: SylEvent[] = hands.called.map((made) => ({
      kind: "tool_use",
      sessionId,
      raw: {},
      name: made.name,
      input: made.args,
    }));

    return {
      sessionId,
      text,
      // No tool call in a double, so the two are the same string.
      spoken: text,
      costUsd: 0,
      numTurns: 1,
      init: {
        kind: "init",
        sessionId,
        raw: {},
        model: "stand-in",
        apiKeySource: "none",
        mcpServers: [],
        tools: [ADD_TODO, FINISH_TODO, WHATS_OUTSTANDING],
        capabilities: [],
        autoMemoryPath: undefined,
      },
      events,
    };
  };
}

// --------------------------------------------------------------------------

describe("US6 — she keeps his list", () => {
  let syl: LiveService | null = null;

  afterEach(async () => {
    await syl?.close();
    syl = null;
  });

  /** Say something to her, and wait for the turn that runs behind the answer. */
  async function heSays(service: LiveService, what: string, clientId: string): Promise<void> {
    await expectData(
      await service.api(
        `/conversations/${encodeURIComponent(INTERACTIVE_CONVERSATION_ID)}/messages`,
        { method: "POST", body: JSON.stringify({ clientId, text: what }) },
      ),
    );
    // The turn runs behind the response, never inside it. `idle` is the seam's
    // own answer to "is she finished".
    await service.deps.chat.idle();
  }

  /** His list, read back over the same API his phone reads. */
  async function hisTodos(service: LiveService): Promise<readonly Todo[]> {
    return (await expectData<{ items: Todo[] }>(await service.api("/todos"))).items;
  }

  it("should put milk on his list when he says to add it", async () => {
    const hands = freshHands();
    syl = await startLiveService({ runner: aModelThatKeepsHisList(hands) });

    await heSays(syl, WHAT_HE_SAID_ADDING, "syl:message:00000000-0000-7000-8000-0000000060b1");

    // Asserted first so a failure says what went wrong rather than only that
    // the list is empty.
    expect(hands.failure, `she could not act: ${hands.failure ?? ""}`).toBeNull();
    expect(hands.advertised.join(", ")).toContain(ADD_TODO);

    const todos = await hisTodos(syl);
    expect(todos).toHaveLength(1);
    expect(todos[0]?.text).toBe("milk");
    expect(todos[0]?.status).toBe("open");
    // Every write carries its reason. Not stored on this row — a to-do has
    // nowhere to keep one — but present in the arguments, which is what
    // `turn.tool` records and the only place he can later ask "why is this
    // here?" and be answered.
    expect(hands.called[0]?.args["because"]).toBe("He asked me to, just now.");
  });

  it("should take the dentist thing off it when he says it is done", async () => {
    const hands = freshHands();
    syl = await startLiveService({ runner: aModelThatKeepsHisList(hands) });

    // Put there over HTTP, as his phone would, so the row she finishes is not
    // one she made herself.
    const seeded = await expectData<Todo>(
      await syl.api("/todos", { method: "POST", body: JSON.stringify({ text: THE_DENTIST }) }),
    );

    await heSays(syl, WHAT_HE_SAID_FINISHING, "syl:message:00000000-0000-7000-8000-0000000060b2");

    expect(hands.failure, `she could not act: ${hands.failure ?? ""}`).toBeNull();
    // She found the id the way the schema says she finds one, rather than
    // guessing at it.
    expect(hands.called.map((made) => made.name)).toEqual([WHATS_OUTSTANDING, FINISH_TODO]);
    expect(hands.called[1]?.args["id"]).toBe(seeded.id);

    const todos = await hisTodos(syl);
    expect(todos).toHaveLength(1);
    expect(todos[0]?.status).toBe("done");
    expect(todos[0]?.completedAt).not.toBeNull();
    // And it is off the list she is shown, which is the thing he actually
    // experiences.
    const open = await expectData<{ items: Todo[] }>(await syl.api("/todos?status=open"));
    expect(open.items).toEqual([]);
  });

  it("should take NOTHING off his list when she has the wrong id", async () => {
    // Constraint 4, at the one verb that removes. A model acting on an id it
    // half-remembers must cost him a sentence, never an item — and she has to
    // say plainly that nothing changed, because "I could not" and "nothing came
    // off your list" are different pieces of news.
    const hands = freshHands();
    syl = await startLiveService({
      runner: aModelThatKeepsHisList(hands, "syl:todo:0198f2c1-4a3b-7d21-9f00-1a2b3c4d5e6f"),
    });

    await expectData<Todo>(
      await syl.api("/todos", { method: "POST", body: JSON.stringify({ text: THE_DENTIST }) }),
    );

    await heSays(syl, WHAT_HE_SAID_FINISHING, "syl:message:00000000-0000-7000-8000-0000000060b3");

    expect(hands.refusal, "she was not refused; something was taken off his list").not.toBeNull();
    expect(hands.refusal).toMatch(/nothing has come off your list/iu);

    const todos = await hisTodos(syl);
    expect(todos).toHaveLength(1);
    expect(todos[0]?.status).toBe("open");
    expect(todos[0]?.completedAt).toBeNull();
  });
});
