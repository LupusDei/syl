import XCTest

@testable import SylKit

/// The client against **Syl herself**, not against the mock.
///
/// Everything else in this suite — including `LiveMockTests` — measures SylKit
/// against `shared/openapi.yaml` or against a server generated from it. That is a
/// strong check on the contract and no check at all on the service, because the two
/// clients and the mock were all written from the same document while the backend was
/// written separately. Until this file existed, the app and the real backend had
/// never exchanged a byte.
///
/// **Opt-in**, for the same reason `LiveMockTests` is: a suite that needs a process
/// running fails for the wrong reason on somebody else's machine. Two variables are
/// required, and the token has to be a real one — pairing is single-use, so it cannot
/// be minted here.
///
/// ```sh
/// # from the repo root
/// npm run -w backend start &            # or any running Syl
/// # take the pairing code the service prints, then:
/// SYL_LIVE_URL=http://127.0.0.1:4201/api/v1 \
/// SYL_LIVE_TOKEN=<bearer token from POST /auth/pair> \
///   swift test --package-path ios/SylKit --filter LiveServerTests
/// ```
///
/// `backend/tests/integration/ios-live-server.test.ts` does that assembly
/// automatically against a throwaway service, and **that** is what runs in anger:
/// `ios/scripts/test.sh` invokes it, `ios.yml` runs the script, and `ios-live.yml`
/// runs it again for backend and shared changes. Until `syl-e4f` it ran in none of
/// them and the whole client/service boundary was verified by a command nobody
/// issued — this file self-skips without `SYL_LIVE_URL`, so it looked identical to
/// passing.
///
/// **A skip here is not a pass.** If this suite reports "skipped" inside an
/// automated run, the run checked nothing that matters and the harness is broken.
/// The socket half lives in `LiveSocketTests`, and is run separately by the harness:
/// a socket failure used to be an abort rather than a failure (`syl-w40`), which took
/// every case in this file down with it and reported nothing about any of them.
final class LiveServerTests: XCTestCase {
    private func live() throws -> LiveSyl {
        try LiveSyl.fromEnvironment()
    }

    private func makeClient() throws -> APIClient {
        let live = try live()
        return APIClient(
            configuration: ServerConfiguration(baseURL: live.url),
            tokenProvider: StaticTokenProvider(live.token)
        )
    }

    // MARK: - Pairing, against the real service

    /// `syl-q1f` — the app's own pairing call, at the real backend.
    ///
    /// Everything else about pairing is checked against the mock or in isolation,
    /// which is a strong check on the contract and no check at all on the service: the
    /// client, the mock and the backend were all written from the same document and
    /// all three can agree on paper while disagreeing on the wire. This is the one
    /// place `SylAPI.pair` and `POST /auth/pair` actually meet.
    ///
    /// **One test, deliberately, because there is only one code.** Two cases would
    /// have to run in a particular order against a credential that survives being
    /// spent exactly once, and XCTest orders by name rather than by declaration —
    /// which is how an order-dependent suite quietly becomes an order-dependent suite
    /// that only fails when somebody renames a method.
    func testShouldPairWithARealCodeAndThenRefuseToPairAgain() async throws {
        let live = try live()
        let anonymous = APIClient(configuration: ServerConfiguration(baseURL: live.url))
        let code = try live.code()

        let grant = try await anonymous.send(
            try SylAPI.pair(
                PairRequest(pairingCode: code, deviceName: "SylKit pairing check"),
                idempotencyKey: IdempotencyKey.generate()
            )
        )

        XCTAssertEqual(grant.tokenType, "Bearer")
        XCTAssertTrue(grant.token.hasPrefix("syl_pat_"))
        XCTAssertTrue(SylIDs.isWellFormed(grant.principal.id))

        // The thing that actually matters: the token it just minted is accepted by
        // the header `APIClient` puts it in.
        let paired = APIClient(
            configuration: ServerConfiguration(baseURL: live.url),
            tokenProvider: StaticTokenProvider(grant.token)
        )
        _ = try await paired.send(SylAPI.whoami())

        // And the refusal a phone has to render as "stop retyping that one". A new
        // `ErrorCode` the service emits and the client cannot decode arrives as
        // `.decoding` rather than as a typed failure, and this is the only test
        // anywhere that would catch it.
        do {
            _ = try await anonymous.send(
                try SylAPI.pair(
                    PairRequest(pairingCode: code, deviceName: "A second device"),
                    idempotencyKey: IdempotencyKey.generate()
                )
            )
            XCTFail("the real service must not pair twice from one code")
        } catch let error as APIError {
            guard case .api(let api, let status) = error else {
                return XCTFail("expected a typed refusal, got \(error)")
            }
            XCTAssertEqual(api.code, .pairingCodeAlreadyUsed)
            XCTAssertEqual(status, 401)
            XCTAssertFalse(api.retryable)
        }
    }

    /// A wrong guess must stay indistinguishable, and it must stay decodable.
    func testShouldRefuseAWrongCodeWithTheOrdinaryUnauthorized() async throws {
        let live = try live()
        let anonymous = APIClient(configuration: ServerConfiguration(baseURL: live.url))

        do {
            _ = try await anonymous.send(
                try SylAPI.pair(
                    PairRequest(pairingCode: "0000-0000", deviceName: "Attacker"),
                    idempotencyKey: IdempotencyKey.generate()
                )
            )
            XCTFail("the real service must not accept a guessed code")
        } catch let error as APIError {
            guard case .api(let api, _) = error else {
                return XCTFail("expected a typed refusal, got \(error)")
            }
            // Not "expired", not "already used". Those two require holding the code,
            // which is the whole reason they are safe to distinguish.
            XCTAssertEqual(api.code, .unauthorized)
        }
    }

    // MARK: - The surfaces the app actually uses

    func testShouldReadHealthWithoutATokenFromTheRealService() async throws {
        let live = try live()
        let anonymous = APIClient(configuration: ServerConfiguration(baseURL: live.url))

        let health = try await anonymous.send(SylAPI.health())

        XCTAssertFalse(health.version.isEmpty)
        XCTAssertFalse(health.checks.isEmpty)
    }

    func testShouldAuthenticateWithTheBearerTokenTheServerIssued() async throws {
        // The single most important thing this file proves: the token minted by
        // `POST /auth/pair` is accepted by the header `APIClient` puts it in.
        let principal = try await makeClient().send(SylAPI.whoami())

        XCTAssertTrue(SylIDs.isWellFormed(principal.id))
        XCTAssertFalse(principal.name.isEmpty)
    }

    func testShouldRefuseAnUnauthenticatedReadWithATypedError() async throws {
        let live = try live()
        let anonymous = APIClient(configuration: ServerConfiguration(baseURL: live.url))

        do {
            _ = try await anonymous.send(SylAPI.whoami())
            XCTFail("the real service must not serve whoami without a token")
        } catch let error as APIError {
            guard case .api(let api, _) = error else {
                return XCTFail("expected a typed refusal, got \(error)")
            }
            XCTAssertEqual(api.code, .unauthorized)
            XCTAssertTrue(error.requiresReauthentication)
        }
    }

    func testShouldDecodeTheInteractiveConversationTheServerSeeds() async throws {
        // The well-known id is a constant on both sides. Two constants that disagree
        // would put the Commander's messages in a thread the app never reads.
        let conversation = try await makeClient()
            .send(SylAPI.conversation(SylIDs.interactiveConversation))

        XCTAssertEqual(conversation.lane, .interactive)
        XCTAssertTrue(SylIDs.areEqual(conversation.id, SylIDs.interactiveConversation))
    }

    func testShouldSendAMessageAndReconcileItByClientId() async throws {
        let client = try makeClient()
        let clientId = "syl:message:\(UUID().uuidString.lowercased())"

        let confirmation = try await client.send(
            try SylAPI.sendMessage(
                conversationId: SylIDs.interactiveConversation,
                SendMessageRequest(
                    clientId: clientId,
                    text: "Live check from SylKit against the real service.",
                    conversationId: SylIDs.interactiveConversation
                ),
                idempotencyKey: IdempotencyKey.generate()
            )
        )

        XCTAssertEqual(confirmation.clientId, clientId)
        XCTAssertTrue(SylIDs.isWellFormed(confirmation.serverId))

        // And it comes back in history, decoded by the same models.
        let page = try await client.send(
            SylAPI.messages(conversationId: SylIDs.interactiveConversation)
        )
        XCTAssertTrue(page.items.contains { $0.clientId == clientId })
    }

    func testShouldRegisterAPushTokenTheWayTheAppDoes() async throws {
        // Exactly the request `PushRegistrationService` builds, including the derived
        // idempotency key, so a re-registration replays rather than accumulating.
        let client = try makeClient()
        let token = String(repeating: "a1b2c3d4", count: 8)

        let device = try await client.send(
            try SylAPI.registerDevice(
                RegisterDeviceRequest(
                    token: token,
                    environment: .production,
                    platform: .ios,
                    name: "SylKit live check",
                    appVersion: "0.1.0 (1)",
                    osVersion: "26.1"
                ),
                idempotencyKey: "device-production-\(token.suffix(32))"
            )
        )

        XCTAssertTrue(device.active)
        XCTAssertTrue(SylIDs.isWellFormed(device.id))
    }

    func testShouldCreateAReminderInAnIANAZoneRatherThanAnOffset() async throws {
        let reminder = try await makeClient().send(
            try SylAPI.createReminder(
                CreateReminderRequest(
                    text: "Live check from SylKit.",
                    wallTime: "16:00",
                    tz: "America/Chicago",
                    date: "2099-08-10"
                ),
                idempotencyKey: IdempotencyKey.generate()
            )
        )

        XCTAssertEqual(reminder.tz, "America/Chicago")
        // Decoded through `Instant`, which is the codec the four traps are about.
        XCTAssertNotNil(reminder.nextFireAt)
    }

    // MARK: - The endpoints that used to be missing, and now are not

    // These two tests asserted the ABSENCE of /sync, /todos and /goals, and each
    // failed with a message its author had written for exactly this moment:
    // "GET /sync now exists — delete this test". `syl-c1m` implemented them.
    //
    // Inverted rather than deleted, because deleting would throw away the only
    // place the SWIFT CLIENT meets those endpoints on a REAL server. The models
    // already existed in SylKit and had never once been decoded from anything
    // but a fixture — which is how a client ships confidently against a shape
    // the server does not actually produce.

    /// `syl-c1m` — `GET /sync` is the app's whole offline-catch-up path.
    ///
    /// `SyncEngine.pull` calls it on every foreground reconcile, so a mismatch
    /// here is not a missing feature but a reconcile loop that fails forever.
    func testShouldServeSyncDecodedByTheAppsOwnModel() async throws {
        let page = try await makeClient().send(SylAPI.sync())

        // A cursor must come back even when nothing has changed, or the client
        // has nothing to send next time and starts from zero on every pull.
        XCTAssertNotNil(page.cursor, "a pull must always return a cursor to resume from")
    }

    /// `syl-c1m` — to-dos and goals are the substance of the product.
    func testShouldServeTodosAndGoalsDecodedByTheAppsOwnModels() async throws {
        let client = try makeClient()

        // Decoding is the assertion. If the server's shape and the app's model
        // disagree, `send` throws a decoding failure rather than returning.
        _ = try await client.send(SylAPI.todos())
        _ = try await client.send(SylAPI.goals())
    }
}
