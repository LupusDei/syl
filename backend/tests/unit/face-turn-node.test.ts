import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  FaceTurnRefusedError,
  FaceTurnTimeoutError,
  SylLLM,
  lastUserUtterance,
  type ChatChunk,
  type ChatContextLike,
  type FaceTurnAnswer,
  type FaceTurnRequest,
  type FaceTurnRunner,
} from "../../src/face/turn-node.js";

/**
 * A chat context shaped like the one `@livekit/agents` hands a model node.
 *
 * Deliberately built from the same fields the real `ChatMessage` exposes —
 * `type`, `role`, `content`, `textContent` — rather than from our own reading of
 * them, so a rename upstream shows up here rather than in production.
 */
function ctx(...turns: ReadonlyArray<{ role: string; text: string }>): ChatContextLike {
  return {
    items: turns.map(({ role, text }) => ({
      type: "message",
      role,
      content: [text],
      textContent: text,
    })),
  };
}

/**
 * A seam that answers whole, exactly like the binary does.
 *
 * **One answer, one call.** There is no token streaming — measured at
 * `28746b5`, the gap between her first assistant text and `result` is 2-15ms
 * and the whole answer arrives as one event — so a fake that emitted deltas
 * would be testing a fiction.
 */
function seam(
  answers: ReadonlyArray<Partial<FaceTurnAnswer> | Error>,
): { run: FaceTurnRunner; requests: FaceTurnRequest[] } {
  const requests: FaceTurnRequest[] = [];
  let index = 0;
  return {
    requests,
    run: async (request) => {
      requests.push(request);
      const answer = answers[Math.min(index, answers.length - 1)];
      index += 1;
      if (answer instanceof Error) throw answer;
      return {
        text: "…",
        sessionId: "session-1",
        apiKeySource: "none",
        ...answer,
      };
    },
  };
}

async function drain(stream: AsyncIterableIterator<ChatChunk>): Promise<ChatChunk[]> {
  const chunks: ChatChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

describe("SylLLMStream — the single chunk", () => {
  it("should yield EXACTLY ONE chunk carrying the whole answer, then close", async () => {
    // THE test this task exists for. LiveKit's model node is an
    // `AsyncIterableIterator<ChatChunk>`, and nothing in that interface
    // requires more than one chunk. Her turn produces one whole answer, so the
    // adapter produces one whole chunk — and if this passed while the stream
    // yielded zero, or hung, it would not be testing the thing.
    const answer = "Good morning, Commander. Two things need you before noon.";
    const { run } = seam([{ text: answer }]);
    const llm = new SylLLM({ runTurn: run });

    const stream = llm.chat({ chatCtx: ctx({ role: "user", text: "What's on today?" }) });
    const chunks = await drain(stream);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.delta?.content).toBe(answer);
    expect(chunks[0]?.delta?.role).toBe("assistant");
    // Closed, not merely empty: a second pull must report done rather than wait.
    await expect(stream.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("should not split a long answer into pieces to imitate streaming", async () => {
    // The plan refuses buffer-and-chunk explicitly: it adds latency to hide a
    // property of the system, and the hiding is the problem. A sentence-shaped
    // answer is the one an over-helpful implementation would slice.
    const answer =
      "First. The roof quote came back. Second. Your 14:00 moved to 15:30. " +
      "Third. Nothing else is urgent, so I'll leave you alone until the evening review.";
    const { run } = seam([{ text: answer }]);
    const llm = new SylLLM({ runTurn: run });

    const chunks = await drain(llm.chat({ chatCtx: ctx({ role: "user", text: "brief me" }) }));

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.delta?.content).toBe(answer);
  });

  it("should complete a turn without ever being asked for a second chunk", async () => {
    // Read the other way round: a consumer that pulls once and stops must still
    // get the whole answer. `AgentSession` is free to do exactly that.
    const { run } = seam([{ text: "Yes." }]);
    const stream = new SylLLM({ runTurn: run }).chat({ chatCtx: ctx({ role: "user", text: "ok?" }) });

    const first = await stream.next();

    expect(first.done).toBe(false);
    expect(first.value?.delta?.content).toBe("Yes.");
  });
});

describe("SylLLMStream — the prompt it asks with", () => {
  it("should ask with the latest thing the Commander said, not the whole history", async () => {
    // Her session already holds the history — that is what `--resume` is for.
    // Replaying the context as a prompt would say everything twice.
    const { run, requests } = seam([{ text: "It's Tuesday." }]);
    const llm = new SylLLM({ runTurn: run });

    await drain(
      llm.chat({
        chatCtx: ctx(
          { role: "user", text: "hello" },
          { role: "assistant", text: "Hello, Commander." },
          { role: "user", text: "what day is it?" },
        ),
      }),
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.prompt).toBe("what day is it?");
  });

  it("should read the utterance out of `content` when `textContent` is absent", async () => {
    const { run, requests } = seam([{ text: "Noted." }]);
    const llm = new SylLLM({ runTurn: run });

    await drain(
      llm.chat({
        chatCtx: { items: [{ type: "message", role: "user", content: ["remind me at six"] }] },
      }),
    );

    expect(requests[0]?.prompt).toBe("remind me at six");
  });

  it("should ignore non-message items rather than mistake one for speech", () => {
    // A tool call sitting after the user's last message must not become the
    // prompt. `lastUserUtterance` is exported so this is a test and not a hope.
    const utterance = lastUserUtterance({
      items: [
        { type: "message", role: "user", content: ["set a reminder"], textContent: "set a reminder" },
        { type: "function_call", name: "remind_me", args: "{}" },
        { type: "function_call_output", output: "ok" },
      ],
    });

    expect(utterance).toBe("set a reminder");
  });
});

describe("SylLLM — session continuity", () => {
  it("should start the first turn with nothing to resume", async () => {
    const { run, requests } = seam([{ text: "Hello." }]);
    const llm = new SylLLM({ runTurn: run });

    await drain(llm.chat({ chatCtx: ctx({ role: "user", text: "hi" }) }));

    expect(requests[0]?.resume).toBeUndefined();
  });

  it("should carry the session id into the second turn so the conversation continues", async () => {
    const { run, requests } = seam([
      { text: "Hello.", sessionId: "sess-a" },
      { text: "Still here.", sessionId: "sess-a" },
    ]);
    const llm = new SylLLM({ runTurn: run });

    await drain(llm.chat({ chatCtx: ctx({ role: "user", text: "hi" }) }));
    await drain(llm.chat({ chatCtx: ctx({ role: "user", text: "still there?" }) }));

    expect(requests[1]?.resume).toBe("sess-a");
    expect(llm.sessionId).toBe("sess-a");
  });

  it("should adopt the session id the turn ACTUALLY ran on, not the one it asked for", async () => {
    // Same call `SylAgent.#remember` makes. If the runner declines the id we
    // offered and reports another, the next turn must follow the real one —
    // otherwise the lane resumes a conversation that is not the one she is in.
    const { run, requests } = seam([
      { text: "one", sessionId: "sess-a" },
      { text: "two", sessionId: "sess-b" },
      { text: "three", sessionId: "sess-b" },
    ]);
    const llm = new SylLLM({ runTurn: run });

    await drain(llm.chat({ chatCtx: ctx({ role: "user", text: "1" }) }));
    await drain(llm.chat({ chatCtx: ctx({ role: "user", text: "2" }) }));
    await drain(llm.chat({ chatCtx: ctx({ role: "user", text: "3" }) }));

    expect(requests[1]?.resume).toBe("sess-a");
    expect(requests[2]?.resume).toBe("sess-b");
  });

  it("should resume a session it was handed at construction", async () => {
    const { run, requests } = seam([{ text: "Back." }]);
    const llm = new SylLLM({ runTurn: run, sessionId: "sess-from-the-broker" });

    await drain(llm.chat({ chatCtx: ctx({ role: "user", text: "hi again" }) }));

    expect(requests[0]?.resume).toBe("sess-from-the-broker");
  });

  it("should keep the session id after a turn that failed", async () => {
    // A failed turn is not a lost conversation. Dropping the id here would
    // silently start a new thread on the next thing he says, and she would have
    // forgotten the last minute of a conversation she is still in.
    const { run, requests } = seam([
      { text: "one", sessionId: "sess-a" },
      new Error("claude exited"),
      { text: "three", sessionId: "sess-a" },
    ]);
    const llm = new SylLLM({ runTurn: run });

    await drain(llm.chat({ chatCtx: ctx({ role: "user", text: "1" }) }));
    await drain(llm.chat({ chatCtx: ctx({ role: "user", text: "2" }) }));
    await drain(llm.chat({ chatCtx: ctx({ role: "user", text: "3" }) }));

    expect(requests[2]?.resume).toBe("sess-a");
  });
});

describe("SylLLMStream — a turn that fails", () => {
  it("should close with something sayable rather than hang", async () => {
    // The worst failure this adapter can have is a face that freezes forever
    // because a turn died. Silence is not an option — she says what happened.
    const { run } = seam([new Error("claude exited with code 1")]);
    const llm = new SylLLM({ runTurn: run });

    const stream = llm.chat({ chatCtx: ctx({ role: "user", text: "hi" }) });
    const chunks = await drain(stream);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.delta?.content).toMatch(/\S/);
    await expect(stream.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("should surface the failure rather than swallow it into a sentence", async () => {
    // Sayable AND observable. A face that apologises while the log says nothing
    // is how a broken turn becomes invisible.
    const boom = new Error("claude exited with code 1");
    const { run } = seam([boom]);
    const onTurnFailed = vi.fn();
    const llm = new SylLLM({ runTurn: run, onTurnFailed });

    const stream = llm.chat({ chatCtx: ctx({ role: "user", text: "hi" }) });
    await drain(stream);

    expect(onTurnFailed).toHaveBeenCalledTimes(1);
    expect(onTurnFailed.mock.calls[0]?.[0]).toBe(boom);
    expect(stream.failure).toBe(boom);
  });

  it("should let the caller choose what she says when a turn fails", async () => {
    // T014 owns the wording. This is the seam it hangs on, so the default here
    // never has to be edited to change what she says.
    const { run } = seam([new Error("nope")]);
    const llm = new SylLLM({ runTurn: run, sayOnFailure: () => "Something broke on my end." });

    const chunks = await drain(llm.chat({ chatCtx: ctx({ role: "user", text: "hi" }) }));

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.delta?.content).toBe("Something broke on my end.");
  });

  it("should close with something sayable when a turn never settles", async () => {
    // The hang, made explicit. A wedged turn is exactly the case where the
    // stream must still end.
    //
    // Drained under a watchdog rather than under vitest's own timeout: remove
    // the ceiling from `SylLLM.take` and this test HANGS, which shows up as a
    // stuck suite rather than as a red line naming the property. Verified by
    // deleting the ceiling and watching this fail in ~1s with the message
    // below.
    const llm = new SylLLM({
      runTurn: () => new Promise<FaceTurnAnswer>(() => {}),
      timeoutMs: 20,
    });

    const stream = llm.chat({ chatCtx: ctx({ role: "user", text: "hi" }) });
    const chunks = await Promise.race([
      drain(stream),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("the stream never ended — the face would have frozen")), 1_000),
      ),
    ]);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.delta?.content).toMatch(/\S/);
    expect(stream.failure).toBeInstanceOf(FaceTurnTimeoutError);
  });

  it("should say something when there is nothing to ask about", async () => {
    // An empty context is not a reason to call the binary, and it is not a
    // reason to stall either.
    const { run, requests } = seam([{ text: "unreachable" }]);
    const llm = new SylLLM({ runTurn: run });

    const chunks = await drain(llm.chat({ chatCtx: { items: [] } }));

    expect(requests).toHaveLength(0);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.delta?.content).toMatch(/\S/);
  });

  it("should stop cleanly when the session closes the stream mid-turn", async () => {
    // An interruption — he starts talking again — must not leave a pull waiting
    // on a turn nobody is listening to.
    let release: (answer: FaceTurnAnswer) => void = () => {};
    const llm = new SylLLM({
      runTurn: () => new Promise<FaceTurnAnswer>((resolve) => (release = resolve)),
    });

    const stream = llm.chat({ chatCtx: ctx({ role: "user", text: "hi" }) });
    const pull = stream.next();
    stream.close();

    await expect(pull).resolves.toEqual({ done: true, value: undefined });
    release({ text: "too late", sessionId: "sess-a", apiKeySource: "none" });
  });
});

describe("SylLLM — the payment rail", () => {
  it("should REFUSE an answer from a turn that resolved an API key", async () => {
    // Constraint 3, checked where this adapter can actually check it. It spawns
    // nothing, so it cannot strip the variable — what it can do is read what
    // the CLI reported it resolved and refuse to speak an answer billed to the
    // metered API. A set key silently outranks the claude.ai login.
    const { run } = seam([{ text: "an answer that cost real money", apiKeySource: "ANTHROPIC_API_KEY" }]);
    const llm = new SylLLM({ runTurn: run });

    const stream = llm.chat({ chatCtx: ctx({ role: "user", text: "hi" }) });
    const chunks = await drain(stream);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.delta?.content).not.toContain("an answer that cost real money");
    expect(stream.failure).toBeInstanceOf(FaceTurnRefusedError);
    expect(String(stream.failure)).toContain("ANTHROPIC_API_KEY");
  });

  it("should still adopt the session id of a turn it refused to speak", async () => {
    // The refusal is about what may be SAID, not about what happened. The turn
    // ran, the conversation exists on Claude Code's side, and an id we never
    // recorded is a conversation nothing can reach again.
    const { run, requests } = seam([
      { text: "billed wrong", sessionId: "sess-a", apiKeySource: "ANTHROPIC_API_KEY" },
      { text: "fine now", sessionId: "sess-a" },
    ]);
    const llm = new SylLLM({ runTurn: run });

    await drain(llm.chat({ chatCtx: ctx({ role: "user", text: "1" }) }));
    await drain(llm.chat({ chatCtx: ctx({ role: "user", text: "2" }) }));

    expect(llm.sessionId).toBe("sess-a");
    expect(requests[1]?.resume).toBe("sess-a");
  });

  it("should refuse anything that is not exactly `none`", async () => {
    // Not a denylist of known-bad values: anything but the claude.ai login is
    // the wrong rail, including a source nobody has seen before.
    const { run } = seam([{ text: "hello", apiKeySource: "apiKeyHelper" }]);
    const llm = new SylLLM({ runTurn: run });

    const stream = llm.chat({ chatCtx: ctx({ role: "user", text: "hi" }) });
    await drain(stream);

    expect(stream.failure).toBeInstanceOf(FaceTurnRefusedError);
  });

  it("should speak an answer from a turn on subscription rails", async () => {
    const { run } = seam([{ text: "Good morning.", apiKeySource: "none" }]);
    const llm = new SylLLM({ runTurn: run });

    const stream = llm.chat({ chatCtx: ctx({ role: "user", text: "hi" }) });
    const chunks = await drain(stream);

    expect(chunks[0]?.delta?.content).toBe("Good morning.");
    expect(stream.failure).toBeUndefined();
  });

  it("should speak the turn's answer byte for byte, adding nothing of its own", async () => {
    // Her identity is not negotiable: SOUL.md, her memory and the fence stay in
    // the loop because the ONLY source of speech on the success path is the
    // injected turn. An adapter that prefixed a greeting, trimmed her markdown
    // or appended a sign-off would be authoring her voice one edit at a time.
    const answer = "  **Two** things.\n\nFirst — the roof.\nSecond — nothing.  ";
    const { run } = seam([{ text: answer }]);
    const llm = new SylLLM({ runTurn: run });

    const chunks = await drain(llm.chat({ chatCtx: ctx({ role: "user", text: "brief me" }) }));

    expect(chunks[0]?.delta?.content).toBe(answer);
  });

  it("should not spawn anything — the harness owns process handling", async () => {
    // A correspondence check against the source rather than against ourselves.
    // The `ANTHROPIC_API_KEY` strip, the session lifecycle and the kill-on-
    // timeout live in `harness/session.ts`; a second copy here would be a
    // quieter set of the same rules, and the quieter one is the one that drifts.
    const source = await readFile(
      fileURLToPath(new URL("../../src/face/turn-node.ts", import.meta.url)),
      "utf8",
    );

    expect(source).not.toMatch(/child_process/);
    expect(source).not.toMatch(/\bspawn\s*\(/);
    expect(source).not.toMatch(/append-system-prompt/);
  });
});

describe("SylLLM — the LiveKit surface", () => {
  it("should present itself as a labelled model node", async () => {
    const llm = new SylLLM({ runTurn: seam([{ text: "hi" }]).run });

    expect(llm.label()).toMatch(/\S/);
    expect(typeof llm.chat).toBe("function");
  });

  it("should be its own async iterator, as `AsyncIterableIterator` requires", async () => {
    const llm = new SylLLM({ runTurn: seam([{ text: "hi" }]).run });
    const stream = llm.chat({ chatCtx: ctx({ role: "user", text: "hi" }) });

    expect(stream[Symbol.asyncIterator]()).toBe(stream);
    await drain(stream);
  });

  it("should give every chunk an id, since the session correlates on it", async () => {
    const llm = new SylLLM({ runTurn: seam([{ text: "hi" }]).run });

    const chunks = await drain(llm.chat({ chatCtx: ctx({ role: "user", text: "hi" }) }));

    expect(chunks[0]?.id).toMatch(/\S/);
  });
});
