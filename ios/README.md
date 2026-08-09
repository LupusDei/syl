# ios

Syl's iOS app and its client library. Swift, **not** an npm workspace — nothing here
is reachable from the repo-root `npm test`.

```
Syl.xcodeproj            the app project — iOS 17, SwiftUI, bundle id com.jmm.syl
Syl.entitlements         aps-environment, as a build setting rather than a literal
Syl/                     app target sources
  App/AppDelegate.swift       APNs device token; there is no SwiftUI equivalent
  Core/Services/              notifications, push registration, network monitor
  Core/Storage/               server profiles (UserDefaults), token (Keychain)
SylTests/                app-target unit tests (wiring only; see below)
SylKit/                  local SPM package — the client wire layer, ZERO dependencies
  Sources/SylKit/Model/       the wire types, hand-written from shared/openapi.yaml
  Sources/SylKit/Networking/  coding, typed errors, retry, the API client
  Tests/SylKitTests/          behaviour, stubbed through MockURLProtocol
  Tests/ContractTests/        the fixture gate — see below
scripts/test.sh          runs both halves of the suite
```

## Commands

```sh
swift test --package-path ios/SylKit   # SylKit, on the host — no simulator
ios/scripts/test.sh                    # both halves

# Optional: the same client against the real mock server, over a real socket.
npm run mock &
SYL_MOCK_URL=http://127.0.0.1:4210/api/v1 swift test --package-path ios/SylKit
```

## The contract gate

`Tests/ContractTests` decodes **every** file in `shared/fixtures/manifest.json` into
the SylKit type the manifest names, re-encodes it, and compares the result with the
original. Both directions matter: decoding alone never exercises a `CodingKeys` typo
on the write path, and every write here carries an idempotency key, so a wrong key
name is a duplicated reminder rather than a compile error.

The fixtures are **referenced, not copied** — `FixtureLoader` walks up from
`#filePath` to the repository root. A copied fixture is a fixture that drifts, which
is the exact failure the mechanism exists to prevent.

`FourTrapsTests` pins the five ways this contract breaks Swift specifically. Four were
predicted in `shared/contract-tests.md`; the fifth was found by the gate on its first
run. All five compile cleanly and fail silently:

1. **`ttl_ms`** is the only snake_case field on the wire, so a blanket
   `.convertFromSnakeCase` is wrong. `WsPresence` carries the one explicit
   `CodingKeys` case in the package.
2. **`.iso8601` cannot parse fractional seconds**, which every instant here carries.
   `Instant` is the custom codec, and it rejects a fixed UTC offset outright.
3. **Required-and-nullable is not optional.** `T?` tolerates an absent key on the way
   in and drops it on the way out; `decodeRequiredNullable` and
   `encodeRequiredNullable` are what make the difference visible.
4. **Two sequence spaces.** `WsDeliveryConfirmation.seq` is the frame stream;
   `.messageSeq` is the conversation. They are different numbers.
5. **`ISO8601FormatStyle` truncates milliseconds** rather than rounding, so
   `…03.114Z` came back as `…03.113Z` on every round trip. `Instant.format` renders
   the milliseconds itself.

## Where a test belongs

**Anything about the wire — request shapes, headers, decoding, retry, error mapping —
goes in `SylKit/Tests/SylKitTests`.** Those run on the host in tens of milliseconds
with no simulator, which is exactly what the package's zero-dependency rule buys. Stub
the network with `MockURLProtocol`:

```swift
MockURLProtocol.handler = MockURLProtocol.respond(json: ["ok": true])
let (data, response) = try await MockURLProtocol.session().data(from: url)
XCTAssertEqual(MockURLProtocol.recordedRequests.first?.httpBody, expectedBody)
```

`MockURLProtocol` normalises the request body back onto `httpBody` before the stub
sees it. `URLSession` moves a body into `httpBodyStream` before a `URLProtocol` gets
the request, and reading that stream is one-shot — so assertions on request bodies
otherwise fail against a permanently nil `httpBody`. Call `MockURLProtocol.reset()` in
`tearDown`; the state is static because `URLSession` instantiates the protocol class
itself and offers no injection seam.

`SylTests` is for things that genuinely need the app: the SwiftUI shell, the app
delegate, notification handling. Keep it thin — every test there costs a simulator
boot.

## Two things that are not accidents

**`SylKit` has no external dependencies, and must not gain any.** It is what keeps the
wire format testable without an app target or a simulator, the same reasoning as the
backend rule that the protocol codec stays pure.

**`SylKit`'s tests do not run from the app scheme.** A `TestableReference` pointing at
a local package's test target parses fine and is then silently skipped — xcodebuild
reports success having run nothing. Hence two commands, and `scripts/test.sh`.

## The socket

`SocketSession` is the protocol as a **pure state machine** — no I/O, no timers, no
`URLSession`. Everything subtle about this protocol is about sequencing, and none of
it needs a server to be wrong, so none of it needs a server to be tested. Feed it a
server frame, get back the frames to send and the events to emit.

`WebSocketClient` is the thin driver around it: open a socket, read frames, keepalive,
reconnect with backoff capped at 30 seconds and no attempt limit.
`WebSocketConnecting` exists as a seam because `URLSessionWebSocketTask` cannot be
intercepted — `MockURLProtocol` never sees a WebSocket upgrade — and without it, gap
recovery would only be testable against a live server.

The three rules worth knowing before touching it:

- **Presence never advances the high-water mark**, and never triggers a `sync`.
  Numbering it would force either a replay the rules forbid or a hole in the sequence
  space, and holes are exactly how gap detection works.
- **`complete: false` is not "caught up".** The gap is older than the server
  remembers; the client emits `needsHTTPSync` and falls back to `GET /sync`.
- **`sinceSeq` is not `since`.** The frame recovers a socket by sequence number; the
  endpoint rebuilds a device store by opaque cursor. The names differ so they cannot
  be conflated.
- **`complete: false` means the range aged out of the buffer, and nothing else.** A
  page truncated by the server's `limit` is *not* incomplete — nothing was lost, so
  the client re-syncs from `toSeq` rather than falling back to HTTP. The service is
  explicit about this; a client that disagreed would either loop or drop messages.
- **The server speaks first, and this client pulls.** `auth_challenge` arrives the
  instant the socket opens. `URLSessionWebSocketTask` buffers until `receive()` asks,
  so nothing is missed — but an event-subscription rewrite that awaited `open` before
  attaching a listener would lose the challenge, and a lost first frame is
  indistinguishable from a server that never sent one.

## The app shell, and four scars it is shaped around

Each of these cost a real debugging cycle in Adjutant. They are load-bearing, not
stylistic.

- **The base URL comes from `UserDefaults`, never from app state.** Push registration
  runs off whatever launch path iOS chose — a cold start from a notification, a
  background wake — and at that moment there may be no view model and no configured
  client. Adjutant read app state there, found nothing, fell back to a default, and
  registered its device token against `localhost`; every push then failed with no
  symptom but silence. `SylBackend` therefore builds a client *per call* from the
  stored URL. There is no cached base URL to go stale.
- **The notification delegate uses the completion-handler variants.** The `async`
  overloads crash on cold start with a main-thread assertion even when the delegate is
  `@MainActor` — and cold start from a notification is the single most important path
  in this app. Do not "modernise" them.
- **Snooze is server-side.** The category and its actions are Adjutant's, and they are
  most of what Syl needs for free. The *authority* is not: Adjutant reschedules on the
  device, and a phone that is wiped, restored or replaced takes those deferrals with
  it. Every action here is a call to the service, which must return a strictly later
  instant or refuse with `DEFERRAL_NOT_LATER`.
- **`aps-environment` is `$(APS_ENVIRONMENT)`, not a literal** — `development` in
  Debug, `production` in Release — and `PushRegistration.environment` is derived from
  the same `#if DEBUG`. TestFlight builds always produce production tokens and
  Xcode-installed builds always produce sandbox ones; pinning either value makes one
  path wrong, and the only symptom is `BadDeviceToken` on every send.

Deliberately absent: `UIBackgroundModes = remote-notification`. Syl never makes a
reminder depend on a silent push — they are throttled, dropped in Low Power Mode, and
Apple's own guidance is that you may receive none at all.

## The local-first store

`Core/Store` is the one genuinely new build here — Adjutant has no client database and
shows a spinner on every cold start. Defensible for a dashboard on WiFi watching a
server that is usually up; wrong for a phone-first assistant on cellular talking to a
home Mac that reboots. **Something checked a dozen times a day cannot open on a
spinner.**

GRDB, and it is the app target's only external dependency. `SylKit` still has none and
must not gain any.

- **Rows are the contract model as JSON, with the columns queries need beside them.**
  A column per field would duplicate `openapi.yaml` in a third place and make every
  additive contract change a migration. The payload's shape is already pinned by the
  contract gate, so the extra schema would buy no safety.
- **The outbox stores intents, not HTTP requests**, so a queued action survives a
  relaunch and a server that was down when he acted. `idempotencyKey` is `UNIQUE` in
  the schema: queueing the same intent twice is a no-op at the database level rather
  than a rule anyone has to remember, and the key is minted once and reused across
  every retry. A key regenerated per attempt is the same as having none.
- **Optimistic send is one transaction.** A pending bubble with no outbox row is a
  message that will never be sent; an outbox row with no bubble is a message he cannot
  see he sent. The pending row's id *is* the `clientId` — there is no server id yet,
  and inventing one would mean two ids to reconcile instead of one.
- **Sync pushes before it pulls.** Pulling first races: a page fetched before the push
  lands describes a world without his last message in it.
- The engine stops at the first *recoverable* push failure to preserve order, and
  abandons only what can never succeed. An expired token is **not** in that category —
  the intent is fine, the token is not, and discarding his message because a token
  expired would be the worst possible response.
- **`Idempotency-Key` is honoured by every implemented write** (`syl-ux1`). It was in
  the contract long before it was true — for a while only message sends deduplicated —
  so the outbox tracks which intents are safe to replay blind, and a snooze was not: a
  second one defers by another fifteen minutes, and a reminder arriving half an hour
  late is the quiet kind of wrong this project cares most about. That is fixed, and
  every kind is now replayable. The **parking** machinery stays: after a failure that
  *may* have landed, an intent declared unsafe is neither retried nor dropped but held
  visibly. Nothing reaches it today; it is the honest response if a future write
  forgets the ledger.
- **The delivery guarantee has a floor on the device** (`syl-u9e`). `deliveredAt` only
  means APNs accepted the request, and while a phone is offline Apple keeps just the
  most recent notification per app — so a night of reminders arrives as one. On every
  foreground `DeliveryReconciler` asks `GET /deliveries?unacknowledged=true`, re-shows
  anything push never delivered, and only then acknowledges it. It refuses to
  acknowledge a row the server is still sending, and refuses to acknowledge anything it
  could not actually show.
- **Every id column is `COLLATE NOCASE`.** The contract's `Id` pattern permits either
  hex case; comparing bare strings would produce a duplicated row rather than an error.
  Outside SQLite, use `SylIDs.areEqual`.

## Shipping

Two workflows, and the split between them is deliberate.

| | `.github/workflows/ios.yml` | `.github/workflows/testflight.yml` |
|---|---|---|
| Runs on | every push and PR touching `ios/**` | a push to `main` that changes `MARKETING_VERSION` |
| Does | `ios/scripts/test.sh` | tests, then build, sign, upload |
| Runner | `macos-26` | `macos-26` |

**CI runs both test commands, and that is the point of the job.** A scheme's
TestAction cannot run a local SPM package's test target: the reference parses fine and
is then silently skipped, so `xcodebuild test` alone reports SUCCESS having run
NOTHING. Green CI, zero tests executed, and nothing says so. `scripts/test.sh` runs
`swift test` and `xcodebuild test`; CI calls the script rather than reinventing the
invocation.

**The test workflow is deliberately not gated on a version change.** Adjutant gates
its iOS tests that way to save macOS minutes, which bill at 10×, and the effect is
that most iOS commits merge untested. The version gate stays on the *deploy*, because
that is where the cost actually is.

**`macos-26` is required, not preferred.** Older runners build against an SDK App
Store Connect rejects with a 409 — *after* a successful build and a successful sign,
so the failure lands at the end of the slowest step with nothing before it having
complained. Adjutant's own test workflow is still on `macos-15` and disagrees with its
deploy workflow; both of Syl's are on `macos-26`.

**`Gemfile.lock` is committed and must not be regenerated.** Without `arm64-darwin` in
its `PLATFORMS` section, bundler fails about 25 seconds in, before Swift compiles
anything, with an error that says nothing about the architecture.

Nothing new had to be provisioned. The same Apple team, the same App Store Connect
key — one key covers a second app in the same team — the same match repository and
password, and the same six secrets Adjutant already uses:

`APP_STORE_CONNECT_API_KEY_BASE64`, `APP_STORE_CONNECT_API_KEY_ID`,
`APP_STORE_CONNECT_API_ISSUER_ID`, `MATCH_GIT_URL`, `MATCH_PASSWORD`,
`MATCH_DEPLOY_KEY`.

The one manual step is adding `com.jmm.syl` to the match repository, by running
`bundle exec fastlane sync_certs` locally once with `MATCH_READONLY` unset.

### Releasing

```sh
# 1. Prove Release builds locally. Optionals and type shadowing that compile in Debug
#    have failed in Release before, and TestFlight is an expensive place to find out.
xcodebuild build -project ios/Syl.xcodeproj -scheme Syl -configuration Release \
  -sdk iphonesimulator -destination 'platform=iOS Simulator,name=iPhone 17'

# 2. Bump MARKETING_VERSION in ios/Syl.xcodeproj/project.pbxproj. That is the trigger.
#    CFBundleVersion comes from CURRENT_PROJECT_VERSION via GENERATE_INFOPLIST_FILE and
#    is set by fastlane from the newest TestFlight build — never write it by hand, and
#    never make it a literal.

# 3. Push to main. Or run the workflow by hand with a changelog.
```

**Never commit `fastlane/AuthKey.p8` or `fastlane/api_key.json`.** The workflow writes
them from secrets and deletes them on `always()`. Adjutant's repository does contain
real ones; that is a mistake worth not copying.

## Not built yet

The local store, the app UI and the TestFlight pipeline are separate beads under
`syl-003`. Model types come from the contract; writing them ahead of it produces
guesses that have to be unwound.
