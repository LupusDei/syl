import Foundation
import SylKit
import XCTest

@testable import Syl

/// What one arriving message costs the parse cache (`syl-025.2.5`).
///
/// ## The defect these describe
///
/// `MarkdownCache` was already avoiding the re-parse, and every test it had said so —
/// so it read as a cache that worked. It rebuilt the entire dictionary around that
/// avoided parse: a fresh N-entry allocation, N lookups and N inserts, on every call,
/// with every single entry a hit. `ChatSnapshotLoader.load()` runs inside `refresh()`,
/// which fires on every arriving message, every send, every foreground and every
/// return to the Chat tab. At a window that has grown to two thousand, every message
/// she sends him rewrote two thousand entries to add one.
///
/// **A parse counter cannot see this.** That is the whole reason these tests count
/// WRITES. The parse count was already correct and already zero on a reload; the cost
/// was in the structure being rebuilt around it, which is invisible to the only
/// question the previous tests knew how to ask.
///
/// ## Why the fixtures are big
///
/// Every fixture in the chat suite was smaller than the window, and that is precisely
/// the condition under which an O(window) cost is invisible — the same condition that
/// hid the paging defect for months. A cost that is linear in N cannot be told from a
/// constant one at N = 3. These seed two thousand.
final class MarkdownCacheCostTests: XCTestCase {
    /// Larger than any window the app should ever open, and the size the epic's other
    /// fixtures use, so the numbers here are comparable to theirs.
    private static let transcript = 2_000

    // MARK: - The cache itself

    func testShouldWriteNothingWhenNothingHasChanged() {
        let cache = MarkdownCache()
        let messages = conversation(Self.transcript)

        _ = cache.blocks(for: messages)
        let afterFirstLoad = cache.entriesWritten
        cache.resetCensus()

        _ = cache.blocks(for: messages)

        // The floor first. A probe that can read zero because nothing happened at all
        // would pass this file while proving nothing, so the first load has to be seen
        // doing the work before the second is allowed to be free.
        XCTAssertEqual(
            afterFirstLoad,
            Self.transcript,
            "the first load must genuinely populate the cache, or the assertion below is vacuous"
        )
        XCTAssertEqual(
            cache.entriesWritten,
            0,
            """
            Reloading an unchanged window wrote \(cache.entriesWritten) entries. Every one \
            of them was a cache hit. This is the cost that recurs on every arriving \
            message, every foreground and every return to the tab.
            """
        )
        XCTAssertEqual(cache.parses, 0, "and it must still not re-parse")
    }

    func testShouldCostOneWriteWhenOneMessageArrives() {
        // The common case, and the one that matters: she answers, one message is
        // appended at the tail, and the window is otherwise identical. The key set has
        // changed — by one — so a naive "identical or rebuild" check does nothing here.
        // This is the assertion that forces the fix to be incremental rather than
        // merely short-circuited.
        let cache = MarkdownCache()
        let messages = conversation(Self.transcript)
        _ = cache.blocks(for: messages)
        cache.resetCensus()

        let arrived = messages + [message(index: Self.transcript + 1)]
        _ = cache.blocks(for: arrived)

        XCTAssertEqual(
            cache.parses,
            1,
            "exactly the message that arrived, and none of the two thousand behind it"
        )
        XCTAssertEqual(
            cache.entriesWritten,
            1,
            """
            One message arrived and the cache wrote \(cache.entriesWritten) entries. \
            One arrival is one insert; anything proportional to the window is the defect.
            """
        )
    }

    func testShouldStillReturnEveryMessageInTheWindow() {
        // Correctness beside the cost. A cache that writes nothing and also returns
        // nothing would satisfy every count above.
        let cache = MarkdownCache()
        let messages = conversation(Self.transcript)

        _ = cache.blocks(for: messages)
        let second = cache.blocks(for: messages)

        XCTAssertEqual(second.count, Self.transcript)
        for message in [messages[0], messages[Self.transcript / 2], messages[Self.transcript - 1]] {
            XCTAssertEqual(
                second[message.id],
                [.paragraph(message.text)],
                "the blocks for \(message.id) survived the load that wrote nothing"
            )
        }
    }

    func testShouldStillForgetAMessageThatLeftTheWindowEvenAtScale() {
        // The eviction has to keep working, and at two thousand it is the one operation
        // that legitimately touches every entry. It must therefore run only when
        // something has actually left — never as a matter of course.
        let cache = MarkdownCache()
        let messages = conversation(Self.transcript)
        _ = cache.blocks(for: messages)

        let narrowed = Array(messages.dropFirst())
        let after = cache.blocks(for: narrowed)

        XCTAssertNil(after[messages[0].id], "the message that left the window is gone")
        XCTAssertEqual(after.count, Self.transcript - 1)
    }

    func testShouldNotRewriteTheWindowWhenAMessageIsReconciled() {
        // The optimistic bubble becoming a real one: `LocalStore.reconcile` mints a NEW
        // id for the same text and deletes the old row, so one key leaves and one
        // arrives in the same load. That is one parse and one insert plus the eviction
        // — never a rewrite of the whole transcript.
        let cache = MarkdownCache()
        let messages = conversation(Self.transcript)
        _ = cache.blocks(for: messages)
        cache.resetCensus()

        var reconciled = messages
        reconciled[Self.transcript - 1] = Message(
            id: "syl:message:0198f2c0-0002-7000-8000-\(String(format: "%012d", Self.transcript))",
            conversationId: SylIDs.interactiveConversation,
            clientId: "c-1",
            role: .user,
            text: messages[Self.transcript - 1].text,
            createdAt: messages[Self.transcript - 1].createdAt,
            seq: Self.transcript
        )
        let after = cache.blocks(for: reconciled)

        XCTAssertEqual(cache.parses, 1, "only the row that changed identity")
        XCTAssertEqual(
            cache.entriesWritten,
            2,
            """
            A reconciliation wrote \(cache.entriesWritten) entries: it is one id arriving \
            and one leaving, so it is one insert and one removal. This runs every time he \
            sends a message, so a rewrite of the window here would put the O(window) cost \
            straight back on the path he touches most.
            """
        )
        XCTAssertEqual(after.count, Self.transcript)
        XCTAssertNil(after[messages[Self.transcript - 1].id], "the local id is gone")
    }

    // MARK: - Through the real loader

    func testShouldNotRewriteTheWindowOnASecondLoad() throws {
        // The same property where it actually costs something: `ChatSnapshotLoader` is
        // what `refresh()` drives, and a window of two thousand is the state T016 exists
        // to prevent and this exists to survive.
        let database = try SylDatabase.inMemory()
        let store = LocalStore(database: database)
        try store.upsert(conversation(Self.transcript + 500))

        let loader = ChatSnapshotLoader(
            store: store,
            conversationId: SylIDs.interactiveConversation,
            limit: Self.transcript
        )

        let first = try loader.load()
        let afterFirstLoad = loader.markdown.entriesWritten
        loader.markdown.resetCensus()

        let second = try loader.load()

        XCTAssertEqual(first.groups.flatMap(\.messages).count, Self.transcript)
        XCTAssertTrue(first.mayHaveEarlier, "the limit has to bite, or this proves nothing")
        XCTAssertEqual(afterFirstLoad, Self.transcript, "the first load populates")
        XCTAssertEqual(
            loader.markdown.entriesWritten,
            0,
            """
            A second load of an unchanged window wrote \(loader.markdown.entriesWritten) \
            cache entries. This runs on every message that arrives.
            """
        )
        XCTAssertEqual(
            second.groups.flatMap(\.messages).count,
            Self.transcript,
            "and it still returns the whole window"
        )
    }

    // MARK: - Fixtures

    /// A transcript of `count` messages, far enough apart that grouping never merges
    /// them — these are counted per MESSAGE, and a merged group would move the numbers
    /// for a reason that has nothing to do with the cache.
    private func conversation(_ count: Int) -> [Message] {
        (1...count).map { message(index: $0) }
    }

    private func message(index: Int) -> Message {
        Message(
            id: "syl:message:0198f2c0-0001-7000-8000-\(String(format: "%012d", index))",
            conversationId: SylIDs.interactiveConversation,
            clientId: nil,
            role: index.isMultiple(of: 2) ? .assistant : .user,
            // Distinct per message so a cache that returned the wrong entry is visible
            // rather than accidentally correct.
            text: "Message \(index).",
            createdAt: base.addingTimeInterval(Double(index) * (MessageGrouping.maximumGap + 1)),
            seq: index
        )
    }

    private let base = try! Instant.parse("2026-08-09T07:00:03.114Z")
}
