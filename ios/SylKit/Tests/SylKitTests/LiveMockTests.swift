import XCTest

@testable import SylKit

/// The client against the real mock server, over a real socket.
///
/// **Opt-in.** Every test here skips unless `SYL_MOCK_URL` is set, because a suite
/// that needs a process running is a suite that fails for the wrong reason on
/// somebody else's machine and in CI. The stubbed tests are the gate; this is the
/// answer to "but does it actually talk to it".
///
/// ```sh
/// npm run mock &
/// SYL_MOCK_URL=http://127.0.0.1:4210/api/v1 swift test --package-path ios/SylKit
/// ```
///
/// It earns its place by exercising the parts `MockURLProtocol` cannot: real URL
/// resolution, real headers on the wire, and a real server's idea of the envelope.
final class LiveMockTests: XCTestCase {
    private func makeClient() throws -> APIClient {
        guard let raw = ProcessInfo.processInfo.environment["SYL_MOCK_URL"],
              let url = URL(string: raw)
        else {
            throw XCTSkip("set SYL_MOCK_URL to run the live checks against `npm run mock`")
        }
        return APIClient(
            configuration: ServerConfiguration(baseURL: url),
            tokenProvider: StaticTokenProvider("syl_pat_9f2c41d8b7e04a6f8c1d3e5a7b9c0d2e")
        )
    }

    func testShouldReadHealthFromTheMockServer() async throws {
        let health = try await makeClient().send(SylAPI.health())

        XCTAssertFalse(health.version.isEmpty)
        XCTAssertFalse(health.checks.isEmpty)
    }

    func testShouldReadTheInteractiveConversationAtItsWellKnownId() async throws {
        let conversation = try await makeClient()
            .send(SylAPI.conversation(SylIDs.interactiveConversation))

        XCTAssertEqual(conversation.lane, .interactive)
    }

    func testShouldPageMessageHistory() async throws {
        let page = try await makeClient()
            .send(SylAPI.messages(conversationId: SylIDs.interactiveConversation))

        XCTAssertFalse(page.items.isEmpty)
    }

    func testShouldSendAMessageAndGetBackAReconcilableConfirmation() async throws {
        let clientId = UUID().uuidString

        let confirmation = try await makeClient().send(
            try SylAPI.sendMessage(
                conversationId: SylIDs.interactiveConversation,
                SendMessageRequest(
                    clientId: clientId,
                    text: "Live check from SylKit.",
                    conversationId: SylIDs.interactiveConversation
                ),
                idempotencyKey: IdempotencyKey.generate()
            )
        )

        XCTAssertEqual(
            confirmation.clientId,
            clientId,
            "without the echoed clientId the optimistic bubble can never be reconciled"
        )
        XCTAssertTrue(SylIDs.isWellFormed(confirmation.serverId))
    }

    func testShouldSurfaceATypedErrorRatherThanAStatusCode() async throws {
        let client = try makeClient()

        do {
            _ = try await client.send(
                SylAPI.reminder("syl:reminder:00000000-0000-7000-8000-00000000dead")
            )
            XCTFail("expected the mock to refuse an unknown id")
        } catch let error as APIError {
            XCTAssertEqual(error.code, .notFound)
        }
    }
}
