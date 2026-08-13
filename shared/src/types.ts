/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Rendered from shared/openapi.yaml by shared/src/generate.ts.
 * Regenerate with `npm run contract:generate`; `npm test` fails if this
 * file has drifted from the spec.
 */

/** A successful response body. Every endpoint returns this or `Err`. */
export type Ok<T> = { readonly success: true; readonly data: T };

/** A failed response body. `error.code` is the contract; the status is advisory. */
export type Err = { readonly success: false; readonly error: ApiError };

/** The only two shapes a Syl response body can take. */
export type Envelope<T> = Ok<T> | Err;

/**
 * `syl:<type>:<uuidv7>` — type-prefixed, time-sortable.
 */
export type Id = string;

/**
 * RFC 3339, UTC, millisecond precision. Never a fixed offset.
 */
export type Instant = string;

/**
 * 24-hour local wall-clock time. Stored alongside an IANA `tz`; the
 * instant is a materialisation of the next occurrence, never the source
 * of truth. Storing only the instant is the fixed-offset bug in a
 * different costume.
 */
export type WallTime = string;

/**
 * IANA zone name. Never a fixed UTC offset.
 */
export type Timezone = string;

export type OkEnvelope = { readonly success: true };

export type ErrorEnvelope = {
  readonly success: false;
  readonly error: ApiError;
};

/**
 * The typed code is the contract; the HTTP status is advisory. Clients
 * branch on this, never on the status line.
 *
 * `PAIRING_CODE_EXPIRED` and `PAIRING_CODE_ALREADY_USED` are the only
 * places the service tells one authentication failure from another, and
 * they are safe because **both are reachable only by presenting a code
 * that matches a stored one**. A wrong guess, and an attempt made while
 * no code is live, are the same `UNAUTHORIZED`. So the extra detail
 * reaches the person holding the code and nobody else — which is what
 * lets a pairing screen on a phone say something more useful than "that
 * did not work".
 */
export type ErrorCode = "VALIDATION_FAILED" | "UNAUTHORIZED" | "PAIRING_CODE_EXPIRED" | "PAIRING_CODE_ALREADY_USED" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT" | "IDEMPOTENCY_KEY_REUSE" | "IDEMPOTENCY_KEY_REQUIRED" | "DEFERRAL_NOT_LATER" | "RRULE_UNSUPPORTED" | "UNKNOWN_JOB_KIND" | "DEVICE_TOKEN_INVALID" | "QUIET_HOURS" | "RATE_LIMITED" | "UPSTREAM_UNAVAILABLE" | "INTERNAL";

export type ApiError = {
  readonly code: ErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: { readonly [key: string]: unknown } | null;
  readonly retryAfterMs?: number | null;
};

export type PageInfo = {
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
};

/**
 * Liveness, dependency status, and — the part that is not obvious —
 * **what code is answering**.
 *
 * A stale build is invisible by construction: every check passes, because
 * the old build is perfectly healthy. It has already cost real time here.
 * The service ran from 19:58 while a fix landed at 20:18, so for three
 * hours Syl answered through a tool surface that had been removed, and it
 * was noticed only because the Commander thought something read oddly and
 * asked. `build` is what turns that silent failure into a visible one.
 */
export type HealthStatus = {
  readonly status: "ok" | "degraded" | "down";
  readonly version: string;
  readonly startedAt: Instant;
  readonly now: Instant;
  readonly checks: HealthCheck[];
  readonly build?: BuildInfo | null;
  readonly turnsInFlight?: number;
};

/**
 * Provenance for the artifact that is running, written by
 * `backend/scripts/write-build-info.mjs` at build time into
 * `dist/build-info.json`.
 *
 * **Stamped at build time, never read from git at request time.** Those
 * two answers differ, and the difference is the entire point: the running
 * service must report the commit it was BUILT FROM, not whatever the
 * working tree happens to say now. Because the stamp lives inside `dist/`,
 * it also travels with a rolled-back build automatically.
 */
export type BuildInfo = {
  readonly commit: string | null;
  readonly builtAt: Instant;
  readonly dirty: boolean;
  readonly branch?: string | null;
};

export type HealthCheck = {
  readonly name: string;
  readonly status: "ok" | "degraded" | "down";
  readonly detail?: string | null;
};

/**
 * How a device gets its first credential, and the only unauthenticated
 * write in the contract.
 *
 * The human types the *short-lived* secret and the app keeps the
 * *long-lived* one: eight digits, good for ten minutes and for exactly
 * one device, exchanged for a bearer token the app puts in the Keychain
 * and never shows anyone. Nothing is ever baked into the build.
 *
 * Get a code by running `npm run pair` on the machine Syl runs on. It is
 * also printed at startup while no device is paired.
 */
export type PairRequest = {
  readonly pairingCode: string;
  readonly deviceName: string;
};

export type TokenGrant = {
  readonly token: string;
  readonly tokenType: "Bearer";
  readonly expiresAt: Instant;
  readonly principal: Principal;
};

/**
 * There is exactly one. Syl answers to the Commander and to nobody
 * else — that allowlist is the trust boundary, not a placeholder for a
 * user table.
 */
export type Principal = {
  readonly id: Id;
  readonly name: string;
};

/**
 * `interactive` is the Commander's own durable thread. `job` lanes hold
 * background work — a research run, the nightly consolidation, the
 * heartbeat. They are separated because one session file shared by
 * every job interleaves Syl's inner monologue with talking to him.
 */
export type ConversationLane = "interactive" | "job";

export type Conversation = {
  readonly id: Id;
  readonly lane: ConversationLane;
  readonly title: string | null;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
  readonly lastMessageAt: Instant | null;
  readonly messageCount: number;
};

/**
 * **How `conversationId` is derived.** The interactive lane has a
 * well-known constant id,
 * `syl:conversation:00000000-0000-7000-8000-000000000001`. A client and
 * a server that both use a constant cannot disagree — which is the
 * whole point, because Adjutant reconstructed conversation scope from
 * sender and recipient, shipped messages into the wrong thread, and
 * paid for the fix twice: once in the bug and again in the backfill
 * migration.
 *
 * `job` lane ids are assigned by the server and never derived by a
 * client.
 */
export type ConversationPage = {
  readonly items: Conversation[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
};

export type MessageRole = "user" | "assistant" | "system";

/**
 * `text` has already had the affect hint stripped. The
 * `<!--affect: concerned 0.6-->` marker that a turn may emit is removed
 * by the service before display and before synthesis; it drives the
 * `presence` frame and never crosses the wire as message content.
 */
export type Message = {
  readonly id: Id;
  readonly conversationId: Id;
  readonly clientId: string | null;
  readonly role: MessageRole;
  readonly text: string;
  readonly createdAt: Instant;
  readonly seq: number;
  readonly attachments: Attachment[];
};

export type MessagePage = {
  readonly items: Message[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
};

export type SendMessageRequest = {
  readonly clientId: string;
  readonly text: string;
  readonly conversationId?: Id | null;
  readonly attachmentIds?: Id[];
};

/**
 * The reconciliation pair. Identical in shape to the WebSocket
 * `delivery_confirmation` frame's payload, deliberately: a client that
 * sent over HTTP because the socket was down reconciles with the same
 * code path.
 */
export type DeliveryConfirmation = {
  readonly clientId: string;
  readonly serverId: Id;
  readonly conversationId: Id;
  readonly seq: number;
  readonly acceptedAt: Instant;
};

/**
 * Two kinds, and deliberately no third. `file` is not here: an arbitrary
 * document is a thing the service would have to store, serve and never
 * be able to render, and adding the case later costs nothing while
 * adding it now costs a surface nobody has a use for.
 */
export type AttachmentKind = "image" | "video";

/**
 * A stored image or video. The row is metadata only — the bytes live on
 * the service's own disk and are fetched from
 * `GET /attachments/{attachmentId}`, never from anywhere else.
 *
 * **There is no URL on this object, on purpose.** A remote image in a
 * transcript leaks a read receipt and the Commander's IP to whoever hosts
 * it, and a client that will render whatever URL it is handed is an SSRF
 * surface pointed at the tailnet. The client composes the path from the
 * id against the server it is paired with, so an attachment can only ever
 * come from Syl's own origin.
 */
export type Attachment = {
  readonly id: Id;
  readonly kind: AttachmentKind;
  readonly mimeType: string;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  readonly durationMs: number | null;
  readonly sha256: string;
  readonly createdAt: Instant;
  readonly hasThumbnail: boolean;
};

export type CreateAttachmentRequest = {
  readonly kind: AttachmentKind;
  readonly mimeType: string;
  readonly data: string;
  readonly width?: number;
  readonly height?: number;
  readonly durationMs?: number;
};

/**
 * Where the **video** got to. It says nothing about the words, which
 * were delivered before this field had any value at all.
 *
 * `pending` — a render is being followed, compressed, or poster-framed.
 * `ready`   — `video` is attached and playable.
 * `failed`  — there will be no video, and `reason` says why in a
 *             sentence. The words stand either way.
 *
 * A client renders all three: a row with her words and the date is a
 * complete row. `failed` is not an error state to hide — it is the
 * honest one, and hiding it would be the silence this project refuses.
 */
export type SendingState = "pending" | "ready" | "failed";

/**
 * Something she wanted to say, in her own face.
 *
 * ## The words are never contingent on the video
 *
 * `words` and `messageId` are written before a render is asked about and
 * are never touched again. Whatever happens to the video, he has already
 * received what she wanted to say, and the push notification carried
 * **her sentence** — never *"Syl sent you a video"*, which would be a
 * notification about the app rather than from her.
 *
 * ## Nothing can delete a sending
 *
 * Not a cache eviction, not a cleanup job, not her. The `sendings` table
 * carries `BEFORE DELETE` and `BEFORE UPDATE` triggers that `RAISE(ABORT)`
 * unconditionally, and the message and attachment a sending points at are
 * guarded the same way, so the words and the video cannot be removed out
 * from under it either. There is **no named exception** — unlike the
 * memory tables, which admit one for the Commander's explicit order.
 * A belief the system holds about him is his to correct; a thing she
 * gave him is not the system's to take back.
 *
 * The only writes the triggers permit are filling in what was not known
 * yet: `video`, `state`, `reason`, `updatedAt`.
 *
 * ## The full-quality render is the record
 *
 * `renderName` addresses the original mp4, which is never modified and
 * never compressed in place. `video` is a *derived, regenerable* copy,
 * made small enough to live under the attachment ceiling. Losing the
 * derived copy costs a re-encode; losing the record would cost the thing
 * itself.
 */
export type Sending = {
  readonly id: Id;
  readonly words: string;
  readonly because: string;
  readonly messageId: Id;
  readonly state: SendingState;
  readonly renderName: string | null;
  readonly video: Attachment | null;
  readonly reason: string | null;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
};

export type SendingPage = {
  readonly items: Sending[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
};

export type CreateSendingRequest = {
  readonly words: string;
  readonly because: string;
  readonly renderName: string;
};

/**
 * Drives the catch-up policy, which is why it is stored on the row.
 *
 * A `commitment` never collapses: it fires late and says it is late.
 * A `rhythm` message does the opposite — yesterday's morning agenda is
 * worthless today, so `supersedesPrevious` is set and only the current
 * one fires, with one line saying what was skipped so even the
 * suppression is visible.
 */
export type ReminderKind = "commitment" | "rhythm";

/**
 * `he_asked` — he requested it in the conversation.
 * `she_noticed` — she offered it unprompted.
 *
 * DERIVED rather than claimed wherever it can be: a heartbeat or dream
 * turn has no message from him at all, so "she thought of it" is a fact
 * about that turn rather than a self-report — and those are exactly the
 * 3am ones. Same rule as `urgentBecauseHeSaid`: a conclusion can only be
 * trusted, evidence can be checked.
 */
export type ReminderOrigin = "he_asked" | "she_noticed";

/**
 * `delivered` means APNs accepted the push. `acknowledged` means the
 * device confirmed it. Only the second one satisfies the guarantee.
 */
export type ReminderDeliveryState = "scheduled" | "due" | "delivered" | "acknowledged" | "deferred" | "completed" | "cancelled" | "failed";

export type Reminder = {
  readonly id: Id;
  readonly kind: ReminderKind;
  readonly text: string;
  readonly because: string | null;
  readonly origin: ReminderOrigin | null;
  readonly todoId: Id | null;
  readonly eventId: Id | null;
  readonly wallTime: WallTime;
  readonly tz: Timezone;
  readonly rrule: string | null;
  readonly scheduledFor: Instant;
  readonly nextFireAt: Instant;
  readonly urgent: boolean;
  readonly late: boolean;
  readonly deferredFrom: Instant | null;
  readonly supersedesPrevious: boolean;
  readonly deliveryState: ReminderDeliveryState;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
  readonly completedAt: Instant | null;
};

export type ReminderPage = {
  readonly items: Reminder[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
};

export type CreateReminderRequest = {
  readonly text: string;
  readonly kind?: ReminderKind;
  readonly wallTime: WallTime;
  readonly tz: Timezone;
  readonly date?: string | null;
  readonly rrule?: string | null;
  readonly todoId?: Id | null;
  readonly urgent?: boolean;
};

/**
 * Every field optional; omitted fields are left alone.
 */
export type UpdateReminderRequest = {
  readonly text?: string;
  readonly wallTime?: WallTime;
  readonly tz?: Timezone;
  readonly rrule?: string | null;
  readonly urgent?: boolean;
};

/**
 * Supply exactly one of `until` or `minutes`. Whichever is used, the
 * resulting instant must be strictly later than the current
 * `nextFireAt`, or the call fails with `DEFERRAL_NOT_LATER`.
 */
export type SnoozeReminderRequest = {
  readonly until?: Instant | null;
  readonly minutes?: number | null;
};

/**
 * `proposed` is inferred structure, not an explicit ask — provisional,
 * visible, and it expires if unresolved after roughly a week. An
 * explicit ask is never provisional; it lands as `open`.
 */
export type TodoStatus = "proposed" | "open" | "done" | "dropped";

export type TodoSource = "commander" | "inferred" | "imported";

export type Todo = {
  readonly id: Id;
  readonly text: string;
  readonly goalId: Id | null;
  readonly dueAt: Instant | null;
  readonly pinned: boolean;
  readonly status: TodoStatus;
  readonly source: TodoSource;
  readonly delegatedJobId: Id | null;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
  readonly completedAt: Instant | null;
};

export type TodoPage = {
  readonly items: Todo[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
};

export type CreateTodoRequest = {
  readonly text: string;
  readonly goalId?: Id | null;
  readonly dueAt?: Instant | null;
  readonly pinned?: boolean;
};

export type UpdateTodoRequest = {
  readonly text?: string;
  readonly goalId?: Id | null;
  readonly dueAt?: Instant | null;
  readonly pinned?: boolean;
  readonly status?: TodoStatus;
};

/**
 * `abandoned` is a first-class, non-shameful outcome. `dormant` is a
 * real state and reactivating a dormant goal restores its history
 * intact. The three answers Syl offers — still mine / not now / done
 * with it — map to `active` / `dormant` / `abandoned`.
 */
export type GoalStatus = "proposed" | "active" | "dormant" | "achieved" | "abandoned";

export type Goal = {
  readonly id: Id;
  readonly parentId: Id | null;
  readonly title: string;
  readonly why: string | null;
  readonly targetDate: string | null;
  readonly metricKey: string | null;
  readonly targetValue: number | null;
  readonly cadenceDays: number | null;
  readonly status: GoalStatus;
  readonly statusReason: string | null;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
};

export type GoalPage = {
  readonly items: Goal[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
};

export type CreateGoalRequest = {
  readonly title: string;
  readonly parentId?: Id | null;
  readonly why?: string | null;
  readonly targetDate?: string | null;
  readonly cadenceDays?: number | null;
};

export type UpdateGoalRequest = {
  readonly title?: string;
  readonly why?: string | null;
  readonly targetDate?: string | null;
  readonly cadenceDays?: number | null;
  readonly status?: GoalStatus;
  readonly statusReason?: string | null;
};

/**
 * Carried per token. TestFlight and App Store builds always produce
 * `production` tokens; Xcode-installed builds always produce `sandbox`.
 * Both exist during development, so a global setting breaks one of
 * them, and the only symptom is `BadDeviceToken` on every send.
 */
export type PushEnvironment = "sandbox" | "production";

export type DevicePlatform = "ios";

export type Device = {
  readonly id: Id;
  readonly platform: DevicePlatform;
  readonly environment: PushEnvironment;
  readonly tokenSuffix: string;
  readonly name: string;
  readonly appVersion: string;
  readonly osVersion: string;
  readonly active: boolean;
  readonly registeredAt: Instant;
  readonly lastSeenAt: Instant;
};

export type DevicePage = {
  readonly items: Device[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
};

export type RegisterDeviceRequest = {
  readonly token: string;
  readonly environment: PushEnvironment;
  readonly platform: DevicePlatform;
  readonly name: string;
  readonly appVersion: string;
  readonly osVersion: string;
};

/**
 * `adjutant` is the interim channel — an MCP tool inside the model's
 * subprocess, which is exactly why it is being replaced. A model can
 * decline to call a tool.
 */
export type DeliveryChannel = "apns" | "adjutant" | "websocket";

export type DeliveryState = "pending" | "sending" | "delivered" | "acknowledged" | "failed" | "abandoned";

/**
 * Feeds the interruption ledger. A message class below 20% engagement
 * over 14 days with at least 5 sends is automatically demoted — its
 * frequency halves — and the Commander is told once.
 */
export type DeliveryEngagement = "delivered" | "opened" | "acted_on" | "dismissed" | "ignored";

/**
 * Self-sufficient by design. The reminder text goes in the body, never
 * an id to fetch: push reaches the phone over Apple's network, which
 * does not touch the tailnet, so a notification must still be readable
 * when the tunnel is down and nothing can be fetched.
 */
export type DeliveryPayload = {
  readonly title: string;
  readonly body: string;
  readonly interruptionLevel?: "passive" | "active" | "time-sensitive";
  readonly categoryIdentifier?: string | null;
  readonly threadIdentifier?: string | null;
};

export type Delivery = {
  readonly id: Id;
  readonly channel: DeliveryChannel;
  readonly messageClass: string;
  readonly reminderId: Id | null;
  readonly payload: DeliveryPayload;
  readonly idempotencyKey: string;
  readonly state: DeliveryState;
  readonly attempts: number;
  readonly nextAttemptAt: Instant | null;
  readonly deliveredAt: Instant | null;
  readonly ackedAt: Instant | null;
  readonly engagement: DeliveryEngagement | null;
  readonly late: boolean;
  readonly scheduledFor: Instant | null;
  readonly coalescedReminderIds: Id[];
  readonly apnsUniqueId: string | null;
  readonly lastError: string | null;
  readonly createdAt: Instant;
};

export type DeliveryPage = {
  readonly items: Delivery[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
};

export type AcknowledgeDeliveryRequest = {
  readonly ackedAt: Instant;
  readonly engagement?: DeliveryEngagement;
};

/**
 * A closed catalogue. The model may enqueue a job; it may never invent
 * a kind. This is the trust boundary pushed down one level — if the
 * model could create arbitrary recurring jobs, a prompt injection
 * inside an article becomes a job that speaks to him every morning.
 *
 * Note the shape of the catalogue: `reminder_delivery` is the kind with
 * a hard guarantee attached, and it is the one that uses no turns. That
 * is not a coincidence.
 *
 * **The catalogue is closed in the DATABASE too**, as a `CHECK` on
 * `jobs.kind` (`0007_jobs.sql`), and widening it is not a small change:
 * SQLite cannot alter a `CHECK` in place, and `runs.job_id` carries
 * `ON DELETE CASCADE`, so dropping and recreating `jobs` performs an
 * implicit `DELETE` that takes **every run record with it** — verified
 * against node:sqlite 3.51.3 before this note was written. The run
 * ledger is what the daily reaching-him ceiling is counted from, so a
 * new kind costs the history that bounds her.
 *
 * `maintenance` is therefore the general-purpose scheduled kind, and it
 * carries the **render review**: the deferred self-wake that ends in her
 * decision about a render she started — is it finished, does it look
 * right, does she still want to send it (`jobs/render-review-job.ts`).
 * Most of its passes spend no turn at all; a render that is still going
 * is deferred, not discussed.
 */
export type JobKind = "reminder_delivery" | "morning_agenda" | "evening_review" | "heartbeat" | "nightly_consolidation" | "research_brief" | "content_ingestion" | "maintenance";

export type JobState = "pending" | "leased" | "running" | "done" | "failed" | "abandoned" | "suspended";

/**
 * Background never starts while interactive work is pending.
 */
export type JobPriority = "interactive" | "reminder" | "scheduled" | "background";

/**
 * Four values, not three: the proposal's §2 lists `at_least_once` and
 * §6 splits it into idempotent and resumable, which behave differently
 * after a crash — one is retried from the top, the other resumes from
 * its last recorded step. They are different guarantees and get
 * different names.
 */
export type JobDeliveryClass = "at_least_once" | "at_least_once_resumable" | "at_most_once" | "once_per_window";

/**
 * What to do about an instant that passed while we were down.
 * `never_expires` fires however late and marks it late — reminders.
 * `grace_window` runs if still inside the window, else skips and logs.
 * `skip` collapses three missed heartbeats into none.
 * `once_per_window` uses a marker row so a second attempt is a no-op.
 */
export type CatchUpPolicy = "never_expires" | "grace_window" | "skip" | "once_per_window";

export type JobCatchUp = {
  readonly policy: CatchUpPolicy;
  readonly graceMs?: number | null;
  readonly windowStart?: WallTime;
  readonly windowEnd?: WallTime;
};

export type JobTriggerType = "wall_clock" | "interval" | "event" | "manual";

export type JobTrigger = {
  readonly type: JobTriggerType;
  readonly wallTime?: WallTime;
  readonly tz?: Timezone;
  readonly rrule?: string | null;
  readonly intervalMs?: number | null;
  readonly event?: string | null;
};

/**
 * `allowedTools` is a property of the job kind, which is what bounds
 * what a headless turn can reach. Reminder delivery needs no tools at
 * all — and `maxTurns: 0` is the strongest statement in the catalogue,
 * because a job that cannot spawn a turn cannot be delayed by a rate
 * limit or broken by a model declining to act.
 */
export type JobBudget = {
  readonly maxTurns: number;
  readonly maxWallClockMs: number;
  readonly allowedTools: string[];
};

/**
 * What makes reboot recovery possible. Recovery runs before scheduling.
 */
export type JobLease = {
  readonly owner: string;
  readonly expiresAt: Instant;
};

export type CircuitBreakerState = "closed" | "open" | "half_open";

/**
 * N consecutive failures disables the kind and reports once. Nothing retries forever.
 */
export type CircuitBreaker = {
  readonly state: CircuitBreakerState;
  readonly consecutiveFailures: number;
  readonly openedAt: Instant | null;
};

export type Job = {
  readonly id: Id;
  readonly kind: JobKind;
  readonly state: JobState;
  readonly priority: JobPriority;
  readonly trigger: JobTrigger;
  readonly deliveryClass: JobDeliveryClass;
  readonly catchUp: JobCatchUp;
  readonly budget: JobBudget;
  readonly lease: JobLease | null;
  readonly circuitBreaker: CircuitBreaker;
  readonly nextRunAt: Instant | null;
  readonly lastRunId: Id | null;
  readonly speaks: boolean;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
};

export type JobPage = {
  readonly items: Job[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
};

export type RunOutcome = "success" | "failure" | "skipped" | "suspended" | "abandoned";

/**
 * Persisted after every turn and before the next one starts, because a
 * turn is atomic from the outside: either it completed and we recorded
 * the result, the session id, the turn count and the cost, or it did
 * not. Resume is `--resume` against the stored session id.
 */
export type RunStep = {
  readonly id: Id;
  readonly index: number;
  readonly sessionId: string | null;
  readonly numTurns: number;
  readonly costUsd: number;
  readonly outcome: RunOutcome;
  readonly summary: string | null;
  readonly startedAt: Instant;
  readonly finishedAt: Instant | null;
};

/**
 * Every run records the gap between *scheduled* and *actual*. That gap
 * is the whole point — a reminder that fired late is a nuisance, and
 * one that pretended to be on time is a lie.
 */
export type Run = {
  readonly id: Id;
  readonly jobId: Id;
  readonly kind: JobKind;
  readonly triggerInstant: Instant;
  readonly actualInstant: Instant | null;
  readonly latenessMs: number;
  readonly outcome: RunOutcome;
  readonly spoke: boolean;
  readonly turns: number;
  readonly costUsd: number;
  readonly summary: string | null;
  readonly error: string | null;
  readonly attempts: number;
  readonly startedAt: Instant;
  readonly finishedAt: Instant | null;
  readonly steps: RunStep[];
};

export type RunPage = {
  readonly items: Run[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
};

/**
 * Severity, ordered. `warn` and above is what an operator looks for.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * One line of `syl.log`, as it was written.
 *
 * `event` is a dotted, stable name rather than prose, because a search is
 * built on it and prose is not. The ones worth knowing:
 *
 * | Event | What it means |
 * |---|---|
 * | `service.start` | The process came up. Carries the whole configuration. |
 * | `turn.start` | A turn began, with its Claude Code session id. |
 * | `turn.tool` | **She called a tool.** The record of what she actually did. |
 * | `turn.done` | A turn ended, with its turn count and cost. |
 * | `turn.api_error` | The CLI reported an API failure mid-turn. |
 * | `chat` | The conversation service said something about a message. |
 *
 * `fields` is deliberately **unmodelled**. A log line's fields are
 * whatever the call site passed, and pinning them in the contract would
 * mean a spec change every time somebody adds one — which is the fastest
 * way to train people to stop adding them. Clients render it generically.
 */
export type LogEntry = {
  readonly ts: Instant;
  readonly level: LogLevel;
  readonly event: string;
  readonly pid: number;
  readonly fields: { readonly [key: string]: unknown };
};

/**
 * Newest first, unlike every other page in this contract.
 */
export type LogPage = {
  readonly items: LogEntry[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
};

/**
 * What a star IS. Effectively immutable per node — a person does not
 * become an event — which is why it is a partition key in the store.
 */
export type MemoryNodeKind = "fact" | "memory" | "person" | "source" | "event" | "goal" | "decision";

/**
 * Depth. `hot` is the live region; `cold` is below the relevance floor,
 * fully addressable and never scanned; `suppressed` is something the
 * Commander said was wrong.
 *
 * **None of the three means deleted.** Nodes are superseded and edges are
 * demoted; a client that renders `cold` or `suppressed` as absent has
 * contradicted the store.
 */
export type MemoryTier = "hot" | "cold" | "suppressed";

/**
 * `observed` was asserted by a source — he said it. `inferred` was drawn
 * by reflection — she worked it out. A viewer that renders the two
 * identically cannot answer the question this whole surface exists for.
 */
export type MemoryEdgeSpecies = "observed" | "inferred";

/**
 * Where a star came from, taken from the strongest filament touching it.
 */
export type MemoryStarProvenance = {
  readonly species: "observed" | "inferred" | "unattested";
  readonly assertedBy: string | null;
  readonly reasoning: string | null;
  readonly learnedAt: Instant | null;
};

export type MemoryStar = {
  readonly id: Id;
  readonly kind: MemoryNodeKind;
  readonly tier: MemoryTier;
  readonly label: string;
  readonly body: string | null;
  readonly confidence: number;
  readonly provenance: MemoryStarProvenance;
  readonly anchor: boolean;
  readonly anchorId: Id | null;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
};

/**
 * One connection. Both endpoints are always present in `stars` — a
 * filament into a star that is not drawn is a line into nothing.
 */
export type MemoryFilament = {
  readonly id: Id;
  readonly from: Id;
  readonly to: Id;
  readonly relation: string;
  readonly species: MemoryEdgeSpecies;
  readonly tier: MemoryTier;
  readonly confidence: number;
  readonly inferredConfidence: number | null;
  readonly reasoning: string | null;
  readonly assertedBy: Id | null;
  readonly lastTouchedAt: Instant;
};

/**
 * What this response is NOT, in numbers and in words.
 */
export type MemoryConstellationBound = {
  readonly stars: number;
  readonly starsReturned: number;
  readonly filamentsReturned: number;
  readonly mayHaveMore: boolean;
  readonly explanation: string;
};

export type MemoryConstellation = {
  readonly generatedAt: Instant;
  readonly bound: MemoryConstellationBound;
  readonly stars: MemoryStar[];
  readonly filaments: MemoryFilament[];
};

/**
 * `sending` is on the feed and `attachment` is not, and the difference is
 * the rule: an attachment is never interesting on its own — a device
 * wants it exactly when it wants the message carrying it, and
 * `Message.attachments` is served inline. A sending has its own surface,
 * its own list and its own lifecycle after the message is written, so it
 * is the resource that changes when a video finally lands.
 */
export type SyncResourceType = "conversation" | "message" | "reminder" | "todo" | "goal" | "device" | "delivery" | "sending";

export type SyncChangeOp = "upsert" | "delete";

export type SyncChange = {
  readonly type: SyncResourceType;
  readonly op: SyncChangeOp;
  readonly id: Id;
  readonly at: Instant;
  readonly resource: { readonly [key: string]: unknown } | null;
};

export type SyncResponse = {
  readonly cursor: string;
  readonly hasMore: boolean;
  readonly changes: SyncChange[];
  readonly serverTime: Instant;
};

/**
 * **Treat an unrecognised value as `idle`.** The enum is open on
 * purpose so the service can add a state without shipping an app
 * update. A client that rejects the frame instead is a client that
 * breaks on a server deploy.
 *
 * `absent` is the default, not `idle` — she is not on screen unless
 * something put her there. During quiet hours it is `absent`
 * unconditionally, including for a reminder that was deferred and will
 * be shown in the morning.
 */
export type PresenceState = "absent" | "idle" | "listening" | "thinking" | "speaking" | "alert" | "delighted" | "concerned" | "manifest";

export type WsFrameType = "auth_challenge" | "auth_response" | "connected" | "chat_message" | "delivery_confirmation" | "presence" | "sync" | "sync_response" | "ping" | "pong" | "error";

/**
 * Server → client, first frame on every connection.
 */
export type WsAuthChallenge = {
  readonly type: "auth_challenge";
  readonly nonce: string;
  readonly protocolVersion: number;
};

/**
 * Client → server, in reply to the challenge.
 */
export type WsAuthResponse = {
  readonly type: "auth_response";
  readonly token: string;
  readonly nonce?: string | null;
  readonly lastSeq?: number | null;
};

/**
 * Server → client. `lastSeq` is the newest sequence the server holds.
 * The client compares it with its own high-water mark and, if there is a
 * gap, sends `sync`.
 */
export type WsConnected = {
  readonly type: "connected";
  readonly lastSeq: number;
  readonly serverTime: Instant;
  readonly protocolVersion: number;
  readonly principal: Principal;
};

/**
 * Client → server. Same semantics as `POST
 * /conversations/{id}/messages`, over the socket — the client falls
 * back to HTTP when the socket is down and reconciles identically.
 */
export type WsClientChatMessage = {
  readonly type: "chat_message";
  readonly clientId: string;
  readonly conversationId: Id;
  readonly text: string;
  readonly idempotencyKey: string;
};

/**
 * Server → client. Replayable: this is exactly the frame whose loss the
 * sequence-and-replay machinery exists to make a non-event.
 */
export type WsServerChatMessage = {
  readonly type: "chat_message";
  readonly seq: number;
  readonly ts: Instant;
  readonly message: Message;
};

/**
 * Server → client. The other half of optimistic send: the client
 * matches `clientId` against its pending row and swaps in `serverId`.
 * Replayable.
 */
export type WsDeliveryConfirmation = {
  readonly type: "delivery_confirmation";
  readonly seq: number;
  readonly ts: Instant;
  readonly clientId: string;
  readonly serverId: Id;
  readonly conversationId: Id;
  readonly messageSeq: number;
  readonly acceptedAt: Instant;
};

/**
 * Server → client. **Never replayed on reconnect, and it carries no
 * `seq`.**
 *
 * Every other frame type replays; this one must not. Replaying a
 * message the Commander missed is the whole point of the replay buffer.
 * Replaying "thinking" from four minutes ago is a lie — a character
 * frozen mid-thought is worse than no character, because it is actively
 * misrepresenting what the system is doing.
 *
 * It carries no sequence number for the same reason: numbering it would
 * either force the server to replay it on a `sync` (forbidden) or punch
 * holes in the sequence space (which is how gap detection works). It is
 * out-of-band and unnumbered.
 *
 * Note `ttl_ms`. It is the one snake_case field on the wire, preserved
 * exactly as the character proposal specifies it.
 */
export type WsPresence = {
  readonly type: "presence";
  readonly state: PresenceState;
  readonly intensity: number;
  readonly since: Instant;
  readonly ttl_ms: number;
};

/**
 * Client → server. Gap recovery on this socket, by sequence number.
 *
 * Deliberately **not** named like `GET /sync`, and its parameter is
 * `sinceSeq` rather than `since`, so the two mechanisms cannot be
 * conflated. This one recovers frames dropped in a tunnel; the HTTP one
 * rebuilds a device store that has been offline for a week.
 */
export type WsSync = {
  readonly type: "sync";
  readonly sinceSeq: number;
  readonly limit?: number | null;
};

/**
 * Server → client. `frames` never contains a `presence` frame; the
 * replay buffer holds only replayable types.
 *
 * `complete: false` means the requested range fell off the replay
 * buffer — the client's gap is older than the server remembers, and it
 * must fall back to `GET /sync` and a history fetch rather than assume
 * it is caught up.
 */
export type WsSyncResponse = {
  readonly type: "sync_response";
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly complete: boolean;
  readonly frames: (WsServerChatMessage | WsDeliveryConfirmation)[];
};

/**
 * Client → server. Application-level, above any transport ping.
 */
export type WsPing = {
  readonly type: "ping";
  readonly ts: Instant;
};

/**
 * Server → client.
 */
export type WsPong = {
  readonly type: "pong";
  readonly ts: Instant;
  readonly serverTime: Instant;
};

/**
 * Server → client. Not in the original frame list, and added because
 * without it every squad invents its own shape for "your token expired"
 * and they disagree. Carries the same `ApiError` as HTTP so one error
 * renderer serves both transports.
 *
 * `fatal: true` means the server is about to close the socket.
 */
export type WsError = {
  readonly type: "error";
  readonly error: ApiError;
  readonly fatal: boolean;
};

/**
 * Every frame a client may send.
 */
export type WsClientFrame = WsAuthResponse | WsClientChatMessage | WsSync | WsPing;

/**
 * Every frame a server may send.
 */
export type WsServerFrame = WsAuthChallenge | WsConnected | WsServerChatMessage | WsDeliveryConfirmation | WsPresence | WsSyncResponse | WsPong | WsError;
