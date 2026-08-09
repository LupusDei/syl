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
/// automatically against a throwaway service, and is itself opt-in behind
/// `SYL_IOS_LIVE=1`.
final class LiveServerTests: XCTestCase {
    private struct Live {
        let url: URL
        let token: String
    }

    private func live() throws -> Live {
        let environment = ProcessInfo.processInfo.environment
        guard let raw = environment["SYL_LIVE_URL"], let url = URL(string: raw) else {
            throw XCTSkip("set SYL_LIVE_URL and SYL_LIVE_TOKEN to run against a real Syl")
        }
        guard let token = environment["SYL_LIVE_TOKEN"], !token.isEmpty else {
            throw XCTSkip("set SYL_LIVE_TOKEN to a bearer token from POST /auth/pair")
        }
        return Live(url: url, token: token)
    }

    private func makeClient() throws -> APIClient {
        let live = try live()
        return APIClient(
            configuration: ServerConfiguration(baseURL: live.url),
            tokenProvider: StaticTokenProvider(live.token)
        )
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

    // MARK: - The endpoints the app calls that the real service does not serve

    /// `syl-c1m` — `GET /sync` is the app's whole offline-catch-up path.
    ///
    /// `SyncEngine.pull` calls it on every foreground reconcile. The mock serves it,
    /// because the mock derives its routes from `openapi.yaml`. Syl has no route for
    /// it, so against the real service every reconcile is a `NOT_FOUND` the engine
    /// treats as a failure.
    func testShouldFindThatSyncIsNotServedByTheRealService() async throws {
        do {
            _ = try await makeClient().send(SylAPI.sync())
            XCTFail("GET /sync now exists — delete this test and the bead with it")
        } catch let error as APIError {
            guard case .api(let api, let status) = error else {
                return XCTFail("expected a typed refusal, got \(error)")
            }
            XCTAssertEqual(api.code, .notFound)
            XCTAssertEqual(status, 404)
            // The terminal handler, not a route saying "no such resource": nothing
            // is mounted at this path at all.
            XCTAssertTrue(
                api.message.contains("No route"),
                "expected the terminal 404; got: \(api.message)"
            )
        }
    }

    /// `syl-c1m` — the same for to-dos and goals.
    func testShouldFindThatTodosAndGoalsAreNotServedByTheRealService() async throws {
        let client = try makeClient()

        for probe in ["todos", "goals"] {
            do {
                if probe == "todos" {
                    _ = try await client.send(SylAPI.todos())
                } else {
                    _ = try await client.send(SylAPI.goals())
                }
                XCTFail("/\(probe) now exists — delete this test and the bead with it")
            } catch let error as APIError {
                guard case .api(let api, _) = error else {
                    return XCTFail("expected a typed refusal for /\(probe), got \(error)")
                }
                XCTAssertEqual(api.code, .notFound, "/\(probe)")
            }
        }
    }

    // MARK: - The socket

    /// The real WebSocket, over the real transport, against the real server.
    ///
    /// Every other socket test in this package injects a fake `WebSocketConnecting`.
    /// This is the only one that exercises `URLSessionWebSocketConnector` — and with
    /// it the fact that `WebSocketClient` builds its URL by appending `ws` to an
    /// `http://` base rather than switching the scheme to `ws://`.
    func testShouldCompleteTheHandshakeAgainstTheRealSocket() async throws {
        let live = try live()
        let client = WebSocketClient(
            configuration: ServerConfiguration(baseURL: live.url),
            tokenProvider: StaticTokenProvider(live.token)
        )

        let events = await client.events()
        await client.start()
        defer { Task { await client.stop() } }

        var states: [SocketConnectionState] = []
        let deadline = Date().addingTimeInterval(10)

        for await event in events {
            if case .connectionState(let state) = event {
                states.append(state)
                if case .connected = state { break }
                if case .unauthenticated = state { break }
            }
            if case .error(let error, let fatal) = event {
                XCTFail("socket refused the app's token: \(error.code) \(error.message) fatal=\(fatal)")
                break
            }
            if Date() > deadline {
                XCTFail("the socket never reached a terminal state; saw \(states)")
                break
            }
        }

        XCTAssertTrue(
            states.contains { if case .connected = $0 { return true } else { return false } },
            "the app's own socket client could not connect to the real service; saw \(states)"
        )
    }
}
