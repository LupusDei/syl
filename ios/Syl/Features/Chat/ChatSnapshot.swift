import Foundation
import SylKit

/// Everything the chat view renders, prepared in one go.
struct ChatSnapshot: Equatable, Sendable {
    var groups: [MessageGroup] = []
    /// How many messages are still waiting on the server. Shown, not hidden: an
    /// assistant that silently fails to send is worse than one that says so.
    var pendingCount: Int = 0
    /// The highest conversation sequence held on disk. Not the frame-stream sequence.
    var highestSeq: Int = 0
}

/// Reads the conversation from disk and groups it — **off the main actor**.
///
/// This is the pattern worth mining from Adjutant's chat view model, and the reason it
/// exists is scroll jank. Reading several hundred rows, decoding each payload and
/// grouping them takes long enough to drop frames if it happens on the main actor, and
/// it happens on every message that arrives. Doing the work on a background task and
/// handing the main actor one finished value means the UI only ever does the cheap
/// part: assigning it.
///
/// `Sendable` and free of any view or view-model reference, so it can genuinely leave
/// the main actor rather than being hopped back by an implicit capture.
struct ChatSnapshotLoader: Sendable {
    let store: LocalStore
    let conversationId: SylID
    var limit: Int = 200

    func load() throws -> ChatSnapshot {
        let messages = try store.messages(conversationId: conversationId, limit: limit)
        let pendingIds = Set(try store.pendingMessages().map(\.id))

        return ChatSnapshot(
            groups: MessageGrouping.group(messages, pendingIds: pendingIds),
            pendingCount: messages.filter { pendingIds.contains($0.id) }.count,
            highestSeq: messages.map(\.seq).max() ?? 0
        )
    }
}
