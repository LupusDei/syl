# Tasks — Syl: The Bones

`[P]` = parallelisable with others in the same phase (different files, no ordering dependency).
`[USn]` = serves user story n.

---

## Phase 1 — Setup (BLOCKS EVERYTHING — one agent, no parallelism)

- **T001** Upgrade to Node 22. Update `package.json` engines to `>=22`, `.nvmrc`, and CI runner. Verify `node:sqlite` is importable and FTS5 is compiled in — this removes a native dependency later. *(files: `package.json`, `.nvmrc`, `.github/workflows/ci.yml`)*
- **T002** Restructure to a monorepo. Create `backend/`, `frontend/`, `ios/`, `shared/`. Move `src/**` → `backend/src/harness/**` and `tests/**` → `backend/tests/**`, preserving git history with `git mv`. All 49 tests must still pass. *(files: repo-wide)*
- **T003** Workspace tooling. npm workspaces in root `package.json`, `tsconfig.base.json` with strict + `noUncheckedIndexedAccess`, per-workspace `tsconfig.json`, shared vitest config. *(files: `package.json`, `tsconfig.base.json`, `*/tsconfig.json`, `vitest.config.ts`)*
- **T004** CI skeleton. Typecheck + test across all workspaces on push. Fail the build if any workspace is untested. *(files: `.github/workflows/ci.yml`)*

## Phase 2 — The API contract (BLOCKS P4–P7 — one agent, highest care)

- **T005** Author `shared/openapi.yaml` (OpenAPI 3.1) covering: health; auth; conversation history with cursor pagination; send message with `clientId`; reminders CRUD incl. complete and snooze; to-dos; device register/unregister; job list and detail; sync-since-cursor; delivery acknowledgement. Response envelope `{success, data, error}` with typed error codes. *(files: `shared/openapi.yaml`)*
- **T006** WebSocket frame schema. `auth_challenge`, `auth_response`, `connected{lastSeq}`, `chat_message`, `delivery_confirmation{clientId,serverId}`, `presence{state,intensity,since,ttl_ms}`, `sync`, `sync_response`, `ping`/`pong`. Document that **presence is never replayed** and expires by `ttl_ms`. *(files: `shared/ws-protocol.md`, `shared/schemas/ws.json`)*
- **T007** [P] Generate TypeScript types from the spec into `shared/types/`, exported for `backend/` and `frontend/`. Generation is a build step, not a commit-once. *(files: `shared/types/**`, `shared/package.json`)*
- **T008** [P] Shared fixtures. Realistic JSON per response type in `shared/fixtures/`, captured or hand-built to match the spec exactly. These are the artifact both TS and Swift tests must decode. *(files: `shared/fixtures/**`)*
- **T009** Mock server. Serves the contract from the fixtures over HTTP + WebSocket, with a scripted delay and error mode. `npm run mock`. **This is what unblocks P5 and P6.** *(files: `shared/mock/**`)*

## Phase 3 — Harness hardening (parallel with P2 — existing code only)

- **T010** [P] [US5] Add a turn timeout to `runTurn`. A wedged CLI currently hangs forever; only the auth guard can kill it. Configurable, defaulted, and tested with a fake that never exits. *(files: `backend/src/harness/session.ts`, `backend/tests/session.test.ts`)*
- **T011** [P] Session lanes. `SylAgent` holds one session-id file today, so the heartbeat, the agenda, consolidation and the Commander's own conversation would share one thread. Give each lane its own persisted id. *(files: `backend/src/harness/agent.ts`, `backend/tests/agent.test.ts`)*
- **T012** [P] Generate and persist the session id **before** spawning, using `--session-id`, closing the crash-between-spawn-and-init window. *(files: `backend/src/harness/session.ts`, `backend/src/harness/agent.ts`)*
- **T013** [US4] Reader turn shape. A `runReaderTurn` that spawns with `--tools ""`, `--strict-mcp-config` and no MCP config, a fresh never-resumed session, and schema-validated output. Remove `bypassPermissions` as the default in `runTurn`. Test proves an injected instruction produces no tool call. *(files: `backend/src/harness/reader.ts`, `backend/src/harness/session.ts`, `backend/tests/reader.test.ts`)*

## Phase 4 — Backend core service

- **T014** Service skeleton: Express 5, config from env, `GET /api/health` reporting version and resolved credential source. *(files: `backend/src/index.ts`, `backend/src/config.ts`, `backend/src/routes/health.ts`)*
- **T015** SQLite + migrations. WAL, `synchronous=NORMAL`, `busy_timeout`, foreign keys, sequential file-based migration runner. **Copy `.sql` assets into `dist/` and fail the build if zero files are copied** — `tsc` does not copy them and migrations silently no-op in production otherwise. *(files: `backend/src/services/database.ts`, `backend/scripts/copy-assets.mjs`, `backend/migrations/001-initial.sql`)*
- **T016** [P] Auth. Bearer API key, SHA-256 hashed at rest, middleware. Single user. *(files: `backend/src/services/api-key-service.ts`, `backend/src/middleware/auth.ts`)*
- **T017** Message + conversation store. **Stamp `conversation_id` on every message from message number one** — Adjutant paid for this twice. FTS5 external-content table with triggers. *(files: `backend/src/services/message-store.ts`, `backend/migrations/002-messages.sql`)*
- **T018** WebSocket server at `/ws`. Auth handshake with the key in a message not the URL, monotonic `seq`, replay buffer, `sync`/`sync_response` gap recovery, ping-pong. *(files: `backend/src/services/ws-server.ts`)*
- **T019** [P] Device tokens + APNs sender. Token-based `.p8` JWT regenerated every ~30 min, one persistent HTTP/2 session, **per-token environment routing** (TestFlight is production, Xcode is sandbox), reactive unregister on `410`/`BadDeviceToken`. *(files: `backend/src/services/apns-service.ts`, `backend/src/services/device-token-service.ts`, `backend/src/routes/devices.ts`, `backend/migrations/003-devices.sql`)*
- **T020** [US1] Delivery outbox. Persisted row per outbound notification, bounded retry with backoff, `interruption-level: time-sensitive`, self-sufficient payload, marked delivered only on client acknowledgement. *(files: `backend/src/services/outbox.ts`, `backend/migrations/004-outbox.sql`)*
- **T021** [US1] Reminder store and the **zero-turn delivery job** — read due row, write outbox row, push. No subprocess anywhere in this path. Quiet-hours gating happens on the outbox, not the scheduler. Deferred items **coalesce** into one notification. *(files: `backend/src/services/reminder-service.ts`, `backend/src/jobs/deliver-reminders.ts`)*
- **T022** [US5] Job runner. Job table, one timer armed for `min(next instant, 60s)` recomputed from now each tick so sleep/wake/DST self-heal, recovery pass on start, per-kind catch-up policy (commitments fire late and are *marked* late; rhythm messages supersede). Concurrency 1. *(files: `backend/src/services/job-runner.ts`, `backend/migrations/005-jobs.sql`)*
- **T023** [US5] [P] launchd agents: `com.jmm.syl.core` (RunAtLoad, KeepAlive, ThrottleInterval) and `com.jmm.syl.watchdog` (StartInterval) — KeepAlive restarts a dead process, nothing notices a wedged one. *(files: `backend/launchd/*.plist`, `backend/scripts/install-agents.sh`)*
- **T024** [P] Presence emitter. Derive `{state, intensity, since, ttl_ms}` from service facts — turn started, first audio, result, reminder due, quiet hours — and broadcast. The model does not emit this. *(files: `backend/src/services/presence.ts`)*

## Phase 5 — Web admin (builds against the mock from day one)

- **T025** Vite + React + TypeScript shell, auth against the API key, layout. *(files: `frontend/**`)*
- **T026** [P] API client generated from `shared/types`, with the same retry policy the mobile client uses. *(files: `frontend/src/api/**`)*
- **T027** [P] [US3] Job and run viewer — every run with outcome, duration, failure detail. The primary debugging surface. *(files: `frontend/src/features/jobs/**`)*
- **T028** [P] [US3] Delivery viewer — the outbox, what was retried, what is unconfirmed. *(files: `frontend/src/features/delivery/**`)*
- **T029** [P] [US3] Conversation viewer with search, and device/push status. *(files: `frontend/src/features/conversations/**`, `frontend/src/features/devices/**`)*

## Phase 6 — Mobile app (builds against the mock from day one)

- **T030** Xcode project + `SylKit` SPM package skeleton, **zero external dependencies**, iOS 17 target, `MockURLProtocol` test harness. *(files: `ios/Syl.xcodeproj`, `ios/SylKit/**`)*
- **T031** [P] `SylKit` networking: actor-based `APIClient`, `RetryPolicy` with backoff (**required** — the tailnet extension is torn down when idle and the first request after wake can fail), typed `APIError`, response envelope. *(files: `ios/SylKit/Sources/SylKit/Networking/**`)*
- **T032** [P] `SylKit` `WebSocketClient` with sequence tracking and gap recovery. *(files: `ios/SylKit/Sources/SylKit/Networking/WebSocketClient.swift`)*
- **T033** [US2] Local-first store. GRDB, conversation/reminders/todos as the UI's source of truth, **outbox table with idempotency keys**, sync state machine: push outbox → pull since cursor → reconcile → ack. The one genuinely new build. *(files: `ios/Syl/Core/Store/**`)*
- **T034** [US1] App shell: push registration (**read the base URL from `UserDefaults`, not app state** — otherwise it registers against localhost), notification categories with a server-authoritative snooze, keychain, server profiles, network monitor. Use the **completion-handler** delegate variants — the async ones crash on cold start. *(files: `ios/Syl/App/AppDelegate.swift`, `ios/Syl/Core/Services/NotificationService.swift`)*
- **T035** [US2] Chat UI: message list with grouping, optimistic send with client-id reconciliation, off-main-actor merge, composer, honest connection-state indicators. *(files: `ios/Syl/Features/Chat/**`)*
- **T036** [P] TestFlight pipeline. Copy Adjutant's workflow and fastlane lanes; change bundle id and paths; add Syl's bundle id to the existing match array; reuse the existing six secrets and the existing APNs key. **Runner must be `macos-26`** — older runners build against an SDK App Store Connect rejects after a successful build. **Copy `Gemfile.lock`, do not regenerate it.** *(files: `.github/workflows/testflight.yml`, `ios/fastlane/**`, `ios/Gemfile*`)*

## Phase 7 — Connections bones

- **T037** [US4] Fetcher with the SSRF guard: block private ranges **including `100.64.0.0/10`** — a hostile article redirecting into the tailnet reaches Syl's own API from inside her trust zone. Refuse redirects across hosts. *(files: `backend/src/connections/fetch.ts`, `backend/tests/fetch.test.ts`)*
- **T038** [US4] Article intake, end to end: fetch → quarantine → Reader turn → schema-validated extract → stored with provenance and a retention class. One vertical slice, no calendar or mail yet. *(files: `backend/src/connections/intake.ts`, `backend/migrations/006-sources.sql`)*
- **T039** [P] Plus-addressed intake mailbox so he can send her links today, before the Share Extension exists. *(files: `backend/src/connections/intake-email.ts`)*

## Phase 8 — Integration

- **T040** Contract tests wired into CI: the shared fixtures decoded by both the TypeScript suite and the Swift suite. A drift on either side fails the build. *(files: `shared/fixtures/**`, `backend/tests/contract.test.ts`, `ios/SylKit/Tests/ContractTests.swift`)*
- **T041** [US1] End-to-end proof: a reminder set on the device fires at the correct wall-clock instant, arrives as a time-sensitive push, is acknowledged, and is marked delivered — with the machine having slept in between.
