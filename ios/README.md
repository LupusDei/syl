# ios

Syl's iOS app and its client library. Swift, **not** an npm workspace — nothing here
is reachable from the repo-root `npm test`.

```
Syl.xcodeproj      the app project — iOS 17, SwiftUI, bundle id com.jmm.syl
Syl/               app target sources
SylTests/          app-target unit tests (wiring only; see below)
SylKit/            local SPM package — the client wire layer, ZERO dependencies
scripts/test.sh    runs both halves of the suite
```

## Commands

```sh
swift test --package-path ios/SylKit   # SylKit, on the host — no simulator
ios/scripts/test.sh                    # both halves
```

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

The API client, the WebSocket client, the local store, the app UI and the TestFlight
pipeline are separate beads under `syl-003`, most of them blocked on the API contract
in `shared/`. Model types come from the contract; writing them ahead of it produces
guesses that have to be unwound.
