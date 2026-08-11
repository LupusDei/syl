import Foundation
import SylKit

/// Everything the chat view renders, prepared in one go.
struct ChatSnapshot: Equatable, Sendable {
    var groups: [MessageGroup] = []

    /// The transcript as the view renders it: turns, interleaved with day rules.
    ///
    /// Computed here rather than in the view. `ChatView` derived this in a computed
    /// property, which SwiftUI re-evaluates on **every** body pass — including one per
    /// keystroke, because the draft publishes from the same view model. That is an O(n)
    /// walk of the whole transcript per character typed, against an explicit requirement
    /// that 500 messages scroll without dropping frames.
    ///
    /// It is the same argument as the markdown parse, and it belongs in the same place:
    /// the view should only ever assign a finished value.
    var rows: [TranscriptRow] = []
    /// How many messages are still waiting on the server. Shown, not hidden: an
    /// assistant that silently fails to send is worse than one that says so.
    var pendingCount: Int = 0
    /// The highest conversation sequence held on disk. Not the frame-stream sequence.
    var highestSeq: Int = 0

    /// Rendered markdown, keyed by message id.
    ///
    /// **Per message, never per group.** `MessageGroup.text` joins its messages with
    /// `"\n\n"`, and parsing that join would merge blocks across message boundaries —
    /// an unclosed fence in one message would swallow the next one whole.
    var blocks: [SylID: [MarkdownBlock]] = [:]

    /// Whether older messages exist beyond the window.
    ///
    /// Exact, not a guess. The loader asks for one row more than it intends to show and
    /// throws it away; if that row came back, there is more history. "Did the window
    /// fill" would have been cheaper and wrong exactly when the history is a whole
    /// multiple of the window — offering a way back to nothing, which is precisely the
    /// kind of small lie this app spends its comments refusing to tell.
    var mayHaveEarlier: Bool = false

    func blocks(for message: Message) -> [MarkdownBlock] {
        blocks[message.id] ?? [.paragraph(message.text)]
    }

    /// The same parsed blocks, sliced per turn and in message order.
    ///
    /// **This exists because handing every row the whole dictionary is quadratic.**
    /// SwiftUI decides whether to re-render a row by comparing the values stored in it,
    /// so a `ChatTurn` holding `[SylID: [MarkdownBlock]]` makes every update deep-compare
    /// the entire transcript's markdown — once per row. At 200 messages that is 200
    /// comparisons of 200 entries of nested enums, on the main thread, on every state
    /// change including each keystroke.
    ///
    /// It presents as the app freezing and then being killed, because a main thread that
    /// stops answering long enough is a watchdog termination, not a slow screen. Sliced
    /// once here, a row compares only its own handful of blocks.
    var blocksByGroup: [SylID: [[MarkdownBlock]]] = [:]

    func blocks(forGroup id: SylID) -> [[MarkdownBlock]] {
        blocksByGroup[id] ?? []
    }
}

/// Parsed markdown, kept between loads.
///
/// A `refresh()` triggered by one arriving message would otherwise re-parse the other
/// 499. Parsing is not free — it is the reason `ChatSnapshotLoader` runs off the main
/// actor at all — and re-doing it on every socket event is exactly the kind of cost that
/// shows up as stutter rather than as a failing test.
///
/// Lock-guarded rather than an actor: the loader is a `Sendable` struct running on a
/// detached task, and making this an actor would force `load()` to become async and
/// re-suspend per message.
final class MarkdownCache: @unchecked Sendable {
    private let lock = NSLock()
    private var cache: [SylID: [MarkdownBlock]] = [:]

    init() {}

    /// Blocks for every given message, parsing only the ones not already held.
    ///
    /// Entries for messages no longer in the window are dropped, so a long-running
    /// session does not accumulate the parse of every message ever seen.
    func blocks(for messages: [Message]) -> [SylID: [MarkdownBlock]] {
        lock.lock()
        let known = cache
        lock.unlock()

        var result: [SylID: [MarkdownBlock]] = [:]
        result.reserveCapacity(messages.count)

        for message in messages {
            if let hit = known[message.id] {
                result[message.id] = hit
            } else {
                result[message.id] = MarkdownParser.parse(message.text)
            }
        }

        lock.lock()
        cache = result
        lock.unlock()

        return result
    }
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
/// Markdown parsing joined that list for the same reason. Adjutant parses in its
/// renderer's `init`, on the main thread, on every body re-evaluation — and `LazyVStack`
/// re-evaluates a row's body every time it scrolls back on screen.
///
/// `Sendable` and free of any view or view-model reference, so it can genuinely leave
/// the main actor rather than being hopped back by an implicit capture.
struct ChatSnapshotLoader: Sendable {
    let store: LocalStore
    let conversationId: SylID
    var limit: Int = 200
    var markdown = MarkdownCache()

    func load() throws -> ChatSnapshot {
        // One more than we intend to show. Its existence is the exact answer to "is
        // there older history", and it is discarded immediately.
        let window = try store.messages(conversationId: conversationId, limit: limit + 1)
        let mayHaveEarlier = window.count > limit
        let messages = mayHaveEarlier ? Array(window.dropFirst()) : window

        let pendingIds = Set(try store.pendingMessages().map(\.id))
        let groups = MessageGrouping.group(messages, pendingIds: pendingIds)
        let parsed = markdown.blocks(for: messages)

        // Sliced here, off the main actor, so a row never holds the whole transcript's
        // markdown just to render its own two paragraphs.
        var byGroup: [SylID: [[MarkdownBlock]]] = [:]
        byGroup.reserveCapacity(groups.count)
        for group in groups {
            byGroup[group.id] = group.messages.map {
                parsed[$0.id] ?? [.paragraph($0.text)]
            }
        }

        return ChatSnapshot(
            groups: groups,
            rows: TranscriptRhythm.rows(for: groups),
            pendingCount: messages.filter { pendingIds.contains($0.id) }.count,
            highestSeq: messages.map(\.seq).max() ?? 0,
            blocks: parsed,
            mayHaveEarlier: mayHaveEarlier,
            blocksByGroup: byGroup
        )
    }
}
