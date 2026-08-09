import SylKit
import XCTest

@testable import Syl

/// A grant, at file scope.
///
/// Not an instance property: an `XCTestCase` is not `Sendable`, so a scripted
/// exchange that reached for `self.grant` would capture the test case in a
/// `@Sendable` closure and fail to compile under Swift 6.
private let testGrant = TokenGrant(
    token: "syl_pat_0123456789abcdef0123456789abcdef",
    expiresAt: Date(timeIntervalSince1970: 2_000_000_000),
    principal: Principal(
        id: "syl:principal:0198f100-0000-7000-8000-000000000001",
        name: "The Commander"
    )
)

/// A typed refusal from the service, for the same reason.
private func refusal(_ code: ErrorCode) -> APIError {
    .api(ApiError(code: code, message: "no", retryable: false), status: 401)
}

/// `syl-q1f` — the flow that takes a freshly installed app to a working credential.
///
/// The bug was not a broken pairing screen. It was the absence of one: `SylAPI.pair`
/// had no callers, `TokenStore.write` was reached only from a test, and every request
/// the app made went out with no `Authorization` header against a server that
/// requires one. The app looked healthy and did nothing.
///
/// So most of what is checked here is *behaviour that had no code at all*, and the
/// half worth reading twice is the failure classification. Four situations reach this
/// screen — wrong code, expired code, spent code, and a Mac that is simply not
/// answering — and they have four different next actions. Rendering them as one
/// generic failure is the thing that makes an evening disappear, on a phone, with no
/// debugger.
final class PairingTests: XCTestCase {
    /// A model whose exchange is scripted, so every branch is reachable without a Mac.
    @MainActor
    private func model(
        entry: String = "bastion.tail0000.ts.net",
        code: String = "4821-9930",
        result: @escaping @Sendable (URL, PairRequest) async throws -> TokenGrant,
        onPaired: @escaping (ServerProfile, TokenGrant) -> Void = { _, _ in }
    ) -> PairingViewModel {
        let model = PairingViewModel(
            serverEntry: entry,
            deviceName: "Commander's iPhone",
            pairer: result,
            onPaired: onPaired
        )
        model.code = code
        return model
    }

    // MARK: - The happy path, which did not exist

    @MainActor
    func testShouldHandTheGrantAndTheProfileToTheAppOnSuccess() async throws {
        var paired: (ServerProfile, TokenGrant)?
        let model = model(result: { _, _ in testGrant }, onPaired: { paired = ($0, $1) })

        await model.pair()

        let received = try XCTUnwrap(paired)
        XCTAssertEqual(received.1.token, testGrant.token)
        XCTAssertEqual(received.0.baseURL.absoluteString, "https://bastion.tail0000.ts.net/api/v1")
        XCTAssertEqual(model.state, .paired(principalName: "The Commander"))
        XCTAssertNil(model.failure)
    }

    @MainActor
    func testShouldSendTheCodeAndTheDeviceNameTheServerWillShow() async throws {
        let sent = Captured<PairRequest>()
        let model = model(result: { _, request in
            await sent.set(request)
            return testGrant
        })

        await model.pair()

        let captured = await sent.value
        let request = try XCTUnwrap(captured)
        XCTAssertEqual(request.pairingCode, "4821-9930")
        XCTAssertEqual(request.deviceName, "Commander's iPhone")
    }

    @MainActor
    func testShouldPairAgainstTheURLTypedInAndNotAStoredOne() async throws {
        // Nothing has been selected yet — there is no profile, because pairing is what
        // creates one. A client built from `UserDefaults` here would talk to the mock.
        let used = Captured<URL>()
        let model = model(entry: "https://elsewhere.ts.net/api/v1", result: { url, _ in
            await used.set(url)
            return testGrant
        })

        await model.pair()

        let target = await used.value
        XCTAssertEqual(target?.absoluteString, "https://elsewhere.ts.net/api/v1")
    }

    // MARK: - The four states

    @MainActor
    func testShouldTellAnExpiredCodeFromAWrongOne() async {
        let expired = model(result: { _, _ in throw refusal(.pairingCodeExpired) })
        let wrong = model(result: { _, _ in throw refusal(.unauthorized) })

        await expired.pair()
        await wrong.pair()

        XCTAssertEqual(expired.failure, .expiredCode)
        XCTAssertEqual(wrong.failure, .incorrectCode)
        // And they say different things, because the next action is different: one is
        // "check the digits", the other is "that one is dead, go get another".
        XCTAssertNotEqual(expired.failure?.title, wrong.failure?.title)
        XCTAssertNotEqual(expired.failure?.recovery, wrong.failure?.recovery)
    }

    @MainActor
    func testShouldTellASpentCodeFromAWrongOne() async {
        let spent = model(result: { _, _ in throw refusal(.pairingCodeAlreadyUsed) })

        await spent.pair()

        XCTAssertEqual(spent.failure, .alreadyUsedCode)
        // The one message that has to stop him retyping: this code will never work
        // again, no matter how carefully it is entered.
        XCTAssertTrue(spent.failure?.recovery.contains("npm run pair") == true)
    }

    @MainActor
    func testShouldNeverRenderAnUnreachableMacAsABadCode() async {
        // The state that would waste the most time if it were confused with the
        // others: under Tailscale the first request after a wake genuinely fails while
        // the tunnel establishes, and telling him his code is wrong would send him
        // back to the Mac for a new one he does not need.
        let model = model(result: { _, _ in
            throw APIError.transport(code: .cannotConnectToHost, description: "Could not connect")
        })

        await model.pair()

        guard case .unreachable = model.failure else {
            return XCTFail("expected an unreachable failure, got \(String(describing: model.failure))")
        }
        XCTAssertFalse(model.failure?.isAboutTheCode ?? true)
        XCTAssertTrue(model.failure?.recovery.contains("Tailscale") == true)
    }

    @MainActor
    func testShouldSayWhenSomethingOtherThanSylAnswered() async {
        // A captive portal or a Tailscale error page. Envelope-shaped is Syl; anything
        // else has not come from Syl at all, and blaming the code would be a lie.
        let model = model(result: { _, _ in
            throw APIError.malformedResponse(status: 407, preview: "<html>Sign in</html>")
        })

        await model.pair()

        guard case .somethingElseAnswered = model.failure else {
            return XCTFail("expected a malformed-response failure")
        }
        XCTAssertFalse(model.failure?.isAboutTheCode ?? true)
    }

    @MainActor
    func testShouldGiveEveryFailureItsOwnHeadlineAndItsOwnNextAction() {
        // The regression guard on the whole idea. A refactor that collapses two of
        // these into one message is exactly the change this bead was filed about.
        let all: [PairingViewModel.Failure] = [
            .malformedCode,
            .unusableServer,
            .incorrectCode,
            .expiredCode,
            .alreadyUsedCode,
            .unreachable(detail: "timed out"),
            .somethingElseAnswered(detail: "HTTP 407"),
        ]

        XCTAssertEqual(Set(all.map(\.title)).count, all.count)
        XCTAssertEqual(Set(all.map(\.recovery)).count, all.count)
    }

    // MARK: - What never leaves the phone

    @MainActor
    func testShouldRefuseACodeOfTheWrongShapeWithoutASingleRequest() async {
        // A round trip to be told "that is not eight digits" is a round trip that can
        // also time out, and then the answer he gets is about the network.
        let reached = Captured<Bool>()
        let model = model(code: "12", result: { _, _ in
            await reached.set(true)
            return testGrant
        })

        await model.pair()

        XCTAssertEqual(model.failure, .malformedCode)
        let everReached = await reached.value
        XCTAssertNil(everReached)
    }

    @MainActor
    func testShouldRefuseAServerEntryThatIsNotAnAddress() async {
        let model = model(entry: "not a host", result: { _, _ in testGrant })

        await model.pair()

        XCTAssertEqual(model.failure, .unusableServer)
    }

    @MainActor
    func testShouldAcceptTheCodeHoweverItWasTyped() {
        // He is reading eight digits off a terminal. Rejecting a space is not a
        // security property, it is a way to make a person feel stupid.
        XCTAssertEqual(PairingViewModel.normalise("4821-9930"), "4821-9930")
        XCTAssertEqual(PairingViewModel.normalise("48219930"), "4821-9930")
        XCTAssertEqual(PairingViewModel.normalise(" 4821 9930 "), "4821-9930")
        XCTAssertNil(PairingViewModel.normalise("4821-993"))
        XCTAssertNil(PairingViewModel.normalise("abcd-efgh"))
    }

    // MARK: - Retry safety

    @MainActor
    func testShouldDeriveOneIdempotencyKeyPerPairingRatherThanOnePerAttempt() {
        // `syl-ux1`, which happened to this exact write. The code is consumed on use,
        // so a response lost in flight — routine under Tailscale — with a fresh key
        // per attempt leaves the code spent and the device permanently unpairable.
        // The same key replays the stored grant instead.
        let request = PairRequest(pairingCode: "4821-9930", deviceName: "Commander's iPhone")

        XCTAssertEqual(
            PairingViewModel.idempotencyKey(for: request),
            PairingViewModel.idempotencyKey(for: request)
        )
        XCTAssertNotEqual(
            PairingViewModel.idempotencyKey(for: request),
            PairingViewModel.idempotencyKey(
                for: PairRequest(pairingCode: "0000-0000", deviceName: "Commander's iPhone")
            )
        )
    }

    @MainActor
    func testShouldKeepThePairingCodeOutOfTheIdempotencyKey() {
        // The key reaches the server's idempotency ledger, which is a table on disk.
        // The service takes real trouble to keep the code out of its own store; a key
        // built from the code plainly would put it there anyway.
        let key = PairingViewModel.idempotencyKey(
            for: PairRequest(pairingCode: "4821-9930", deviceName: "Commander's iPhone")
        )

        XCTAssertFalse(key.contains("4821"))
        XCTAssertFalse(key.contains("9930"))
        XCTAssertFalse(key.contains("48219930"))
    }
}

/// A `Sendable` box, so a scripted exchange can record what it was handed.
private actor Captured<Value: Sendable> {
    private(set) var value: Value?

    func set(_ value: Value) {
        self.value = value
    }
}

/// What the Commander is allowed to type into the server field.
///
/// `ServerProfile.tailnet(host:)` had no callers outside a test, which is another way
/// of saying the app could only ever talk to the mock — the base URL was hardcoded in
/// two places and there was no screen to change it. This is the parser that fixes
/// that, and its whole job is to accept the several *correct* answers a person
/// produces for the same question.
final class ServerEntryTests: XCTestCase {
    func testShouldAcceptTheURLThePairingCommandPrints() throws {
        let profile = try XCTUnwrap(
            ServerProfile.from(entry: "https://bastion.tail0000.ts.net/api/v1")
        )

        XCTAssertEqual(profile.baseURL.absoluteString, "https://bastion.tail0000.ts.net/api/v1")
    }

    func testShouldAcceptABareHostAndAddTheContractsBasePath() throws {
        let profile = try XCTUnwrap(ServerProfile.from(entry: "bastion.tail0000.ts.net"))

        XCTAssertEqual(profile.baseURL.absoluteString, "https://bastion.tail0000.ts.net/api/v1")
    }

    func testShouldNotDoubleTheBasePathOrTripOverATrailingSlash() throws {
        for entry in [
            "bastion.tail0000.ts.net/",
            "https://bastion.tail0000.ts.net/",
            "https://bastion.tail0000.ts.net/api/v1/",
            "  bastion.tail0000.ts.net  ",
        ] {
            let profile = try XCTUnwrap(ServerProfile.from(entry: entry), entry)
            XCTAssertEqual(
                profile.baseURL.absoluteString,
                "https://bastion.tail0000.ts.net/api/v1",
                entry
            )
        }
    }

    func testShouldDefaultToHTTPSAndNeverDowngradeATypo() throws {
        // The tailnet certificate is real and publicly trusted. Quietly sending a
        // bearer token in cleartext because a host was mistyped is not a favour.
        let profile = try XCTUnwrap(ServerProfile.from(entry: "bastion.tail0000.ts.net"))

        XCTAssertEqual(profile.baseURL.scheme, "https")
    }

    func testShouldStillAllowTheMockWhenTheWholeURLIsGiven() throws {
        // Deliberate, and only reachable by typing the scheme out.
        let profile = try XCTUnwrap(ServerProfile.from(entry: "http://127.0.0.1:4210/api/v1"))

        XCTAssertEqual(profile.baseURL, ServerProfile.mock.baseURL)
    }

    func testShouldRefuseEntriesThatCannotBeAHost() {
        for entry in ["", "   ", "not a host", "localhost", "https://"] {
            XCTAssertNil(ServerProfile.from(entry: entry), entry)
        }
    }
}

/// The gate: whether the app shows itself or the pairing screen.
final class PairedStateTests: XCTestCase {
    @MainActor
    func testShouldStartUnpairedWhenNothingIsInTheKeychain() {
        // This was the shipped state, permanently, for every install: no token, every
        // request unauthenticated, and no screen that said so.
        XCTAssertFalse(AppDelegate(tokens: InMemoryTokenStore()).isPaired)
    }

    @MainActor
    func testShouldStartPairedWhenATokenSurvived() {
        // A Keychain item survives deleting the app, so a TestFlight reinstall
        // normally comes back already paired. That is the good outcome.
        let delegate = AppDelegate(tokens: InMemoryTokenStore(token: "syl_pat_x"))

        XCTAssertTrue(delegate.isPaired)
    }

    @MainActor
    func testShouldStoreTheTokenAndSelectTheServerTogether() throws {
        let suite = "syl.tests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }

        let tokens = InMemoryTokenStore()
        let delegate = AppDelegate(tokens: tokens)
        let profiles = ServerProfileStore(defaults: defaults, fallback: .mock)
        let profile = try XCTUnwrap(ServerProfile.from(entry: "bastion.tail0000.ts.net"))
        let grant = TokenGrant(
            token: "syl_pat_0123456789abcdef0123456789abcdef",
            expiresAt: Date(timeIntervalSince1970: 2_000_000_000),
            principal: Principal(id: "syl:principal:0198f100-0000-7000-8000-000000000001", name: "The Commander")
        )

        delegate.completePairing(grant: grant, profile: profile, profiles: profiles)

        XCTAssertTrue(delegate.isPaired)
        XCTAssertEqual(tokens.read(), testGrant.token)
        // Both, or neither is useful: `SylBackend` reads the base URL from
        // `UserDefaults` per call, so a token stored without the profile selected
        // would be the new credential pointed at the old server.
        XCTAssertEqual(ServerProfileStore.storedBaseURL(defaults: defaults), profile.baseURL)
        XCTAssertEqual(profiles.selected, profile)
    }
}
