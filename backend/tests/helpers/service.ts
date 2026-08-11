import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_QUIET_HOURS, type SylConfig } from "../../src/config.js";
import { IntakeQueue } from "../../src/connections/intake-job.js";
import { IntakeStore } from "../../src/connections/intake-store.js";
import { ArticleIntake } from "../../src/connections/intake.js";
import { SylAgent, memorySessionStore } from "../../src/harness/agent.js";
import type { TurnResult, TurnRunner } from "../../src/harness/session.js";
import { syncResolvers } from "../../src/index.js";
import { DreamLog } from "../../src/memory/dream/log.js";
import { MemoryGraph } from "../../src/memory/graph.js";
import { MemoryMetrics } from "../../src/memory/metrics.js";
import { ExtractionStore } from "../../src/memory/extract-apply.js";
import { HerOwnMemory } from "../../src/memory/remember.js";
import type { Retriever } from "../../src/memory/retrieve.js";
import { EdgeWeights } from "../../src/memory/weights.js";
import { WorkingMemory } from "../../src/memory/working.js";
import { RenderVerdicts } from "../../src/render/verdicts.js";
import { RenderService, type RenderRecord } from "../../src/render/render-service.js";
import { studioAt } from "../../src/render/studio.js";
import type { MemoryViews } from "../../src/routes/memory.js";
import { ApiKeyService, type ApiKeyServiceOptions } from "../../src/services/api-key-service.js";
import { AttachmentStore } from "../../src/services/attachment-store.js";
import { fixedClock, type Clock } from "../../src/services/clock.js";
import { ConversationService } from "../../src/services/conversation-service.js";
import { IN_MEMORY, openDatabase, type SylDatabase } from "../../src/services/database.js";
import { DeviceTokenService } from "../../src/services/device-token-service.js";
import { GoalService } from "../../src/services/goal-service.js";
import type { Entropy } from "../../src/services/id.js";
import { IdempotencyStore } from "../../src/services/idempotency.js";
import { JobStore } from "../../src/services/job-store.js";
import { MemoryRuntime } from "../../src/services/memory-runtime.js";
import { MessageStore } from "../../src/services/message-store.js";
import { Outbox } from "../../src/services/outbox.js";
import { PresenceService } from "../../src/services/presence.js";
import { ReminderService } from "../../src/services/reminder-service.js";
import { SendingService, type RenderSource } from "../../src/services/sending-service.js";
import { SendingStore } from "../../src/services/sending-store.js";
import { RenderWatchStore } from "../../src/services/render-watch-store.js";
import { SyncService } from "../../src/services/sync-service.js";
import { TodoService } from "../../src/services/todo-service.js";

/**
 * The pieces a service-level test needs, assembled the way `bootstrap` does.
 *
 * Every one of these opens a real, migrated SQLite database rather than a
 * double. The store is where the interesting failures are — a CHECK constraint
 * that does not fire, a UNIQUE that does — and a mock cannot have them.
 * `:memory:` makes that free.
 */

/**
 * A migrated, empty database with its seeded rows pinned to the test clock.
 *
 * Migration `0001` seeds the interactive conversation using SQLite's own
 * `strftime('now')` — the REAL wall clock at migration time. That makes the
 * seeded row's timestamps different in every database and, worse, later than
 * anything a fixed-clock test writes once real time passes `TEST_NOW`.
 *
 * It failed exactly that way: `TEST_NOW` is 2026-08-09T07:00Z, so on the day
 * it was written every ordering assertion passed, and from 07:00 UTC the next
 * morning the seeded row sorted first and the suite went red with no change to
 * any code. A time bomb with a one-day fuse, latent from the moment it was
 * committed.
 *
 * Normalising here rather than in the test keeps every future ordering test
 * safe, and keeps the fix in the fixture where the non-determinism enters
 * rather than scattered across the assertions that trip over it.
 *
 * The migration itself is the deeper problem — seeded data should not carry a
 * non-deterministic timestamp — but it has shipped and is checksummed, so that
 * belongs in a follow-up migration rather than an edit. See `syl-1t7`.
 */
export function testDatabase(): SylDatabase {
  const db = openDatabase({ path: IN_MEMORY });
  const seeded = new Date(TEST_NOW - 60_000).toISOString();
  db.handle
    .prepare("UPDATE conversations SET created_at = ?, updated_at = ? WHERE updated_at > ?")
    .run(seeded, seeded, seeded);
  return db;
}

/** A config with every field set, so a new field breaks tests loudly. */
export function testConfig(overrides: Partial<SylConfig> = {}): SylConfig {
  return {
    host: "127.0.0.1",
    // Port 0 asks the kernel for a free one. Tests must never fight over 4201,
    // and never fight each other.
    port: 0,
    nodeEnv: "test",
    version: "0.1.0",
    databasePath: IN_MEMORY,
    // Absolute, because Claude Code discards a relative auto-memory directory
    // without a word. Nothing in a unit test spawns the CLI, so this only has
    // to be a well-formed value.
    autoMemoryDirectory: "/tmp/syl-test-memory",
    credentialSource: "none",
    subscriptionRails: true,
    quietHours: DEFAULT_QUIET_HOURS,
    pushEnvironment: null,
    allowSandboxPush: false,
    // Under the OS temp directory rather than `~/Library/Logs`: a unit test
    // must not write into the place the running service writes, and certainly
    // must not rotate it.
    logDirectory: join(tmpdir(), "syl-test-logs"),
    certStatusPath: join(tmpdir(), "syl-test-cert-status.json"),
    // A path that deliberately does not exist. A test that says nothing about
    // the admin gets a service with no admin bundle, rather than one that
    // quietly serves whatever `frontend/dist` happens to hold on this machine —
    // which would make the suite's answer depend on whether somebody had run a
    // build. Tests about the admin pass their own directory.
    adminDir: join(tmpdir(), "syl-test-no-admin-bundle"),
    // Per-process, under the OS temp directory: a unit test must never write
    // blobs into the repo's `.syl/`, which is where the running service keeps
    // the Commander's own. `testDeps` points the store at its own directory.
    attachmentDir: join(tmpdir(), `syl-test-attachments-${String(process.pid)}`),
    // Off, as it is for every machine that has not asked for it. A test that
    // wants the fleet builds its own `AdjutantClient` with an injected transport.
    adjutant: null,
    ...overrides,
  };
}

/** A fixed moment to hang time-dependent assertions off. */
export const TEST_NOW = Date.UTC(2026, 7, 9, 7, 0, 0, 0);

/** Entropy that is deterministic but not constant, so tokens differ. */
export function countingEntropy(start = 1): Entropy {
  let next = start;
  return (into: Uint8Array): void => {
    for (let i = 0; i < into.length; i += 1) into[i] = (next + i) & 0xff;
    next += 1;
  };
}

export interface TestKeyOptions {
  readonly clock?: Clock;
  readonly entropy?: Entropy;
  readonly tokenTtlMs?: number;
  readonly pairingCodeTtlMs?: number;
}

/**
 * An `AttachmentStore` writing into a fresh temp directory.
 *
 * A real directory, not a double: the blob layer's interesting failures are
 * filesystem failures — a name that escapes, a file that is not there — and a
 * fake filesystem has none of them. The thumbnailer is off by default because
 * `sips` is macOS-only and CI is ubuntu; `attachment-store.test.ts` drives
 * both branches explicitly.
 */
export function testAttachments(
  db: SylDatabase,
  clock: Clock = fixedClock(TEST_NOW),
): AttachmentStore {
  return new AttachmentStore({
    db: db.handle,
    clock,
    blobDir: mkdtempSync(join(tmpdir(), "syl-test-attachments-")),
    thumbnailer: () => false,
  });
}

/**
 * A `MessageStore` on a fixed clock, with attachments wired.
 *
 * `attachments` is a parameter rather than something this builds, because
 * `testDeps` has to hand the SAME object to the store and the router —
 * `bootstrap` does, and two stores over one table would let a test pass
 * against a wiring production does not have.
 */
export function testMessages(
  db: SylDatabase,
  clock: Clock = fixedClock(TEST_NOW),
  attachments: AttachmentStore = testAttachments(db, clock),
): MessageStore {
  return new MessageStore({ db: db.handle, clock, attachments });
}

/**
 * A turn runner that answers nothing, and never spawns anything.
 *
 * "Nothing to say" is a real production outcome — *notice, do not nag*, and
 * `ConversationService` deliberately writes no message for an empty result — so
 * this is Syl choosing silence rather than a hole where the agent should be.
 * It is the right default for a route-level or frame-level test, which is about
 * the transport and not about what Syl thinks: a reply landing asynchronously
 * mid-assertion would make every such test depend on the machine's load.
 *
 * A test that is about her *answering* uses `fake-claude` through
 * `startLiveService`, which drives the real `runTurn` against a real captured
 * transcript.
 */
export const silentRunner: TurnRunner = (_prompt, options) => {
  const sessionId = options.resume ?? options.sessionId ?? "test-session";
  options.onSessionId?.(sessionId);
  return Promise.resolve({
    sessionId,
    text: "",
    // No tool call in a double, so the two are the same string.
    spoken: "",
    costUsd: 0,
    numTurns: 1,
    init: {
      kind: "init",
      sessionId,
      raw: {},
      model: "test",
      apiKeySource: "none",
      mcpServers: [],
      tools: [],
      capabilities: [],
      autoMemoryPath: undefined,
    },
    events: [],
  } satisfies TurnResult);
};

/**
 * A turn runner that answers, in process.
 *
 * The cheap half of the pair: no subprocess, so a suite can have Syl reply
 * without paying a node spawn per message. What it does **not** exercise is
 * `runTurn` — the argv, the stream-json decode, the stdin-EOF turn boundary —
 * so a test that is about any of those uses `answeringClaude` and a real fake
 * binary instead.
 */
export function replyingRunner(text: string, options: { readonly delayMs?: number } = {}): TurnRunner {
  return async (_prompt, turn) => {
    const sessionId = turn.resume ?? turn.sessionId ?? "test-session";
    turn.onSessionId?.(sessionId);
    if (options.delayMs !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }
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
        model: "test",
        apiKeySource: "none",
        mcpServers: [],
        tools: [],
        capabilities: [],
        autoMemoryPath: undefined,
      },
      events: [],
    } satisfies TurnResult;
  };
}

/** A `ConversationService` whose Syl is silent. See {@link silentRunner}. */
export function testChat(messages: MessageStore): ConversationService {
  return new ConversationService({
    messages,
    agent: new SylAgent({ store: memorySessionStore(), runner: silentRunner }),
  });
}

/**
 * The memory surface, on a fixed clock and the real store.
 *
 * A real `MemoryGraph` rather than a double, for the same reason every other
 * helper here opens a real database: the interesting failures in this layer are
 * the CHECK that fires and the UNIQUE that spans the cold partition, and a mock
 * cannot have them.
 */
export function testMemory(
  db: SylDatabase,
  clock: Clock = fixedClock(TEST_NOW),
  options: { readonly recall?: () => Retriever | null } = {},
): MemoryViews {
  const graph = new MemoryGraph({ db: db.handle, clock });
  return {
    graph,
    weights: new EdgeWeights({ graph, clock }),
    metrics: new MemoryMetrics({ db: db.handle, clock }),
    dreams: new DreamLog({ db: db.handle, clock }),
    working: new WorkingMemory({ db: db.handle, graph, clock }),
    // `null` by default, which is the honest offline configuration: the real
    // retriever needs `vec0` and a 300M-parameter model, and `npm test` is not
    // allowed to download one. A test that wants search injects a real
    // `Retriever` over its own store — see `memory-recall.test.ts` — and the
    // default keeps every OTHER test on the degraded path, which is exactly the
    // path a machine without the extension runs.
    recall: options.recall ?? ((): Retriever | null => null),
    hers: new HerOwnMemory({ db: db.handle, graph, clock }),
    provenance: (nodeId: string) =>
      new ExtractionStore({ db: db.handle, graph, clock }).provenanceFor(nodeId),
  };
}

/**
 * A `RenderService` that cannot render, over a studio nothing shares.
 *
 * **`backend: null` is the important half.** Renders are billed to a real
 * Runway account, so the default in a test fixture has to be a service that
 * spends nothing and reaches nothing — and `null` is not a stub, it is the
 * ordinary state of any machine without a grant, which means every suite that
 * does not care about renders is exercising a real configuration rather than a
 * doubled one. A test that wants a render that succeeds builds its own with a
 * fake backend; `renders.test.ts` does.
 *
 * The studio is a fresh temp directory for the same reason `testAttachments`
 * uses one: a unit test must never write into the directory the running
 * service keeps the Commander's own media in.
 */
export function testRenders(clock: Clock = fixedClock(TEST_NOW)): RenderService {
  return new RenderService({
    studio: studioAt(mkdtempSync(join(tmpdir(), "syl-test-studio-"))),
    backend: null,
    clock,
  });
}

/**
 * A render source that always answers with one finished clip.
 *
 * Needed because `compose` refuses a render that is not `ready` — the
 * Commander's ruling of 2026-08-11, so that nothing reaches him about a video
 * that does not exist. Every route test that posts a sending would otherwise be
 * testing the refusal rather than the door it means to test, and the empty
 * studio `testRenders` gives them has nothing in it.
 *
 * The mp4 path is never opened: `testDeps` hands the composer a compressor that
 * refuses, so no test needs ffmpeg or a file that is really a video.
 */
export function testReadyRenders(): RenderSource {
  const record = (name: string): RenderRecord => ({
    name: name === "latest" ? "syl-20260811t090000z-close" : name,
    status: "ready",
    // Unanchored: these fixtures predate the closing-frame anchor.
    anchor: null,
    renderedAt: "2026-08-11T09:02:00.000Z",
    taskId: "task-test",
    model: "seedance2",
    ratio: "720:1280",
    duration: 15,
    reference: "reference.png",
    framing: "close_portrait",
    prompt: "…",
    scene: "…",
    holdsLikeness: true,
    because: "A render the suite can send from.",
    startedAt: "2026-08-11T09:00:00.000Z",
    reason: null,
    credits: 120,
    usd: 1.2,
    video: "/studio/videos/syl-20260811t090000z-close.mp4",
  });
  return { get: (name) => record(name), latest: () => record("latest") };
}

/** Everything `createApp` and `startServer` need, on one in-memory store. */
export function testDeps(db: SylDatabase): {
  readonly keys: ApiKeyService;
  readonly messages: MessageStore;
  readonly chat: ConversationService;
  readonly devices: DeviceTokenService;
  readonly outbox: Outbox;
  readonly reminders: ReminderService;
  readonly todos: TodoService;
  readonly goals: GoalService;
  readonly sync: SyncService;
  readonly jobs: JobStore;
  readonly idempotency: IdempotencyStore;
  readonly intake: ArticleIntake;
  readonly memory: MemoryViews;
  readonly attachments: AttachmentStore;
  readonly renders: RenderService;
  readonly renderVerdicts: RenderVerdicts;
  readonly sendings: SendingStore;
  readonly composer: SendingService;
  readonly renderWatches: RenderWatchStore;
  readonly presence: PresenceService;
  readonly intakeQueue: IntakeQueue;
  readonly memoryRuntime: MemoryRuntime;
} {
  const clock = fixedClock(TEST_NOW);
  const intakeQueue = new IntakeQueue();
  // One object, handed to both the store that reads attachments and the router
  // that writes them — exactly as `bootstrap` does it.
  const attachments = testAttachments(db, clock);
  const messages = testMessages(db, clock, attachments);
  const sendings = new SendingStore({ db: db.handle, clock, attachments });
  const devices = new DeviceTokenService({ db: db.handle, clock });
  // No quiet hours by default: a route test asserting on delivery would
  // otherwise depend on what hour TEST_NOW happens to be in.
  const outbox = new Outbox({ db: db.handle, clock });
  const reminders = new ReminderService({ db: db.handle, clock });
  const todos = new TodoService({ db: db.handle, clock });
  const goals = new GoalService({ db: db.handle, clock });
  const jobs = new JobStore({ db: db.handle, clock });
  const memory = testMemory(db, clock);
  const renders = testRenders(clock);
  // Hoisted rather than inlined below: the composer publishes her words
  // through this same object, exactly as production does.
  const chat = testChat(messages);
  return {
    keys: testKeys(db),
    messages,
    // No sink either. `startServer` points it at the socket; a frame-level test
    // that wants to watch what is published sets its own.
    chat,
    devices,
    outbox,
    reminders,
    todos,
    goals,
    // Built through the same `syncResolvers` the service uses, so a test can
    // never be passing against a wiring production does not have.
    sync: new SyncService({
      db: db.handle,
      clock,
      resolvers: syncResolvers({ messages, reminders, todos, goals, devices, outbox, jobs, sendings }),
    }),
    jobs,
    idempotency: new IdempotencyStore({ db: db.handle, clock }),
    // The default fetcher is `safeFetch`, the SSRF guard, and it stays that
    // way here: a route test never gets as far as a fetch, because `submit`
    // only records the source and the ladder is driven by the job.
    intake: new ArticleIntake({
      store: new IntakeStore({ db: db.handle, clock }),
      clock,
      scheduler: intakeQueue,
    }),
    memory,
    attachments,
    // Cannot render and cannot reach Runway. See `testRenders`.
    renders,
    // Real, against the same database. It is a plain table with no backend to
    // reach, so there is nothing to fake and faking it would only hide the
    // append-only property that is the point of the store (`syl-b0i`).
    renderVerdicts: new RenderVerdicts({ db: db.handle, clock }),
    sendings,
    // Composes for real, against the same stores — but its compressor refuses
    // rather than shelling out, so no test needs ffmpeg and none decodes a file
    // that is not really a video. A test that wants a video attached injects
    // its own `SendingService`; `sending-service.test.ts` is where that lives.
    composer: new SendingService({
      sendings,
      chat,
      attachments,
      outbox,
      // A finished render, always. `renders` above is the real service over an
      // empty studio, which is right for `/renders` and wrong here: `compose`
      // now refuses anything that is not `ready`, so a route test posting a
      // sending would only ever exercise that refusal.
      renders: testReadyRenders(),
      workDir: mkdtempSync(join(tmpdir(), "syl-test-sendings-")),
      compress: async () => ({
        ok: false,
        reason: "There is no ffmpeg in the test environment, so this one goes without a video.",
      }),
      log: () => undefined,
    }),
    // The promises to come back and look at a render. Real, on the same
    // database: nothing in a route test creates one, and a store that refused
    // to exist would make the review job untestable through the seam that
    // actually wires it.
    renderWatches: new RenderWatchStore({ db: db.handle, clock }),
    // No sink. `startServer` attaches one; a test that wants to watch frames
    // hands its own to `PresenceService` directly.
    presence: new PresenceService({ clock }),
    intakeQueue,
    // Constructed for real, and it costs nothing: `MemoryRuntime` builds only
    // the ledger eagerly, and the searchable half — `vec0` and, eventually, a
    // model — is not touched until something asks. That is the same property
    // the service depends on at boot, so a test getting the real object here
    // is a test exercising the real seam.
    memoryRuntime: new MemoryRuntime({ db: db.handle, graph: memory.graph, clock }),
  };
}

/** An `ApiKeyService` on a fixed clock and predictable entropy. */
export function testKeys(db: SylDatabase, options: TestKeyOptions = {}): ApiKeyService {
  const built: ApiKeyServiceOptions = {
    db: db.handle,
    clock: options.clock ?? fixedClock(TEST_NOW),
    entropy: options.entropy ?? countingEntropy(),
    ...(options.tokenTtlMs === undefined ? {} : { tokenTtlMs: options.tokenTtlMs }),
    ...(options.pairingCodeTtlMs === undefined
      ? {}
      : { pairingCodeTtlMs: options.pairingCodeTtlMs }),
  };
  return new ApiKeyService(built);
}
