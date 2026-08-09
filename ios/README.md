# ios

Syl's iOS app and its client library. Swift, **not** an npm workspace — nothing here
is reachable from the repo-root `npm test`.

```
Syl.xcodeproj            the app project — iOS 17, SwiftUI, bundle id com.jmm.syl
Syl/                     app target sources
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

## Not built yet

The WebSocket client, the local store, the app UI and the TestFlight pipeline are
separate beads under `syl-003`. Model types come from the contract; writing them
ahead of it produces guesses that have to be unwound.
