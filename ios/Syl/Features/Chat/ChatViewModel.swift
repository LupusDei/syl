import Foundation
import SylKit

/// The chat screen's state.
///
/// It never waits on the network to show something. `refresh()` reads disk; sending
/// writes disk and queues an intent; the socket and the sync engine bring disk up to
/// date afterwards. That ordering is the whole of local-first.
@MainActor
final class ChatViewModel: ObservableObject {
    @Published private(set) var snapshot = ChatSnapshot()
    @Published private(set) var connection: SocketConnectionState = .idle
    @Published private(set) var presence: PresenceState = .absent
    /// Non-nil when something is stuck and the Commander should know. Offline is a
    /// state to design, not an error to report — but a message that cannot be sent is
    /// worth saying out loud.
    @Published private(set) var notice: String?
    @Published var draft = ""

    private let store: LocalStore
    private let loader: ChatSnapshotLoader
    private let conversationId: SylID
    private let sendOverSocket: @Sendable (_ text: String, _ clientId: String, _ key: String) async throws -> Void
    private let flush: @Sendable () async -> Void
    private let now: @Sendable () -> Date
    private let makeClientId: @Sendable () -> String
    private let makeIdempotencyKey: @Sendable () -> String

    init(
        store: LocalStore,
        conversationId: SylID = SylIDs.interactiveConversation,
        limit: Int = 200,
        /// Sends over the live socket. Throws when it is not up, which is the cue to
        /// leave the intent in the outbox for the sync engine.
        sendOverSocket: @escaping @Sendable (String, String, String) async throws -> Void = { _, _, _ in
            throw WebSocketClient.NotConnected()
        },
        /// Runs the outbox. Called after a send so a queued message leaves promptly
        /// rather than waiting for the next scheduled sync.
        flush: @escaping @Sendable () async -> Void = {},
        now: @escaping @Sendable () -> Date = { Date() },
        makeClientId: @escaping @Sendable () -> String = { UUID().uuidString },
        makeIdempotencyKey: @escaping @Sendable () -> String = { IdempotencyKey.generate() }
    ) {
        self.store = store
        self.conversationId = conversationId
        self.loader = ChatSnapshotLoader(store: store, conversationId: conversationId, limit: limit)
        self.sendOverSocket = sendOverSocket
        self.flush = flush
        self.now = now
        self.makeClientId = makeClientId
        self.makeIdempotencyKey = makeIdempotencyKey
    }

    // MARK: - Reading

    /// Rebuilds the view's state from disk.
    ///
    /// The read and the grouping happen off the main actor; only the assignment
    /// happens here. On a long history that is the difference between a smooth scroll
    /// and a visible stutter every time a message arrives.
    func refresh() async {
        let loader = loader
        let snapshot = await Task.detached(priority: .userInitiated) {
            try? loader.load()
        }.value

        guard let snapshot else {
            notice = "Could not read the conversation from this device."
            return
        }
        self.snapshot = snapshot
    }

    // MARK: - Sending

    /// Renders the bubble, queues the intent, and tries the socket.
    ///
    /// The order matters and is not negotiable: **disk first**. If the app is killed
    /// between the write and the send, the message is still queued and still on screen.
    /// If it were sent first, a crash would lose both the bubble and the intent.
    func send() async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }

        let clientId = makeClientId()
        let idempotencyKey = makeIdempotencyKey()

        do {
            _ = try store.enqueueSend(
                conversationId: conversationId,
                clientId: clientId,
                idempotencyKey: idempotencyKey,
                text: text,
                now: now()
            )
        } catch {
            notice = "Could not queue that message on this device."
            return
        }

        draft = ""
        notice = nil
        await refresh()

        do {
            try await sendOverSocket(text, clientId, idempotencyKey)
        } catch {
            // Not a failure. The socket being down is expected — the Mac reboots, the
            // tailnet drops on a handoff — and the intent is already durable. The
            // outbox carries the same idempotency key, so whichever path lands first,
            // the message is written once.
            await flush()
        }
    }

    // MARK: - Live events

    /// Applies one socket event.
    ///
    /// Returns whether the on-screen state changed, so a caller can avoid a refresh
    /// that would do nothing.
    @discardableResult
    func apply(_ event: SocketEvent) async -> Bool {
        switch event {
        case .connectionState(let state):
            connection = state
            if state == .unauthenticated {
                notice = "This device needs to be paired again."
            }
            return false

        case .message(let message):
            // Compared case-insensitively: the `Id` pattern permits either hex case,
            // and a bare `==` would drop a message into the wrong thread rather than
            // fail loudly.
            guard SylIDs.areEqual(message.conversationId, conversationId) else { return false }
            try? store.upsert([message])
            await refresh()
            return true

        case .deliveryConfirmation(let confirmation):
            guard SylIDs.areEqual(confirmation.conversationId, conversationId) else { return false }
            let reconciled = (try? store.reconcile(confirmation)) ?? false
            if reconciled { await refresh() }
            return reconciled

        case .presence(let frame):
            presence = frame.state
            return false

        case .needsHTTPSync:
            // The gap is older than the server's replay buffer. Saying nothing here
            // would leave the client believing it is caught up when it is not.
            notice = "Catching up on what was missed."
            return false

        case .error(let error, let fatal):
            notice = fatal ? error.message : nil
            return false
        }
    }

    // MARK: - What the Commander is told

    /// One honest line about the connection. Never "Connected" when it is not, and
    /// never silence when something is queued.
    var connectionSummary: String {
        switch connection {
        case .idle: return "Not connected"
        case .connecting: return "Connecting"
        case .authenticating: return "Signing in"
        case .connected:
            return snapshot.pendingCount > 0
                ? "Sending \(snapshot.pendingCount)…"
                : "Connected"
        case .reconnecting(let attempt): return "Reconnecting (\(attempt))"
        case .offline:
            return snapshot.pendingCount > 0
                ? "Offline — \(snapshot.pendingCount) waiting to send"
                : "Offline"
        case .unauthenticated: return "Needs pairing"
        }
    }

    /// Whether the shell should draw attention to the connection state. Connected with
    /// nothing queued is the only case that needs no comment.
    var isConnectionNoteworthy: Bool {
        if case .connected = connection { return snapshot.pendingCount > 0 }
        return true
    }
}
