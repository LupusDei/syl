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

    /// Whether older messages exist beyond the window.
    ///
    /// Exact, not a guess. The loader asks for one row more than it intends to show and
    /// throws it away; if that row came back, there is more history. "Did the window
    /// fill" would have been cheaper and wrong exactly when the history is a whole
    /// multiple of the window — offering a way back to nothing, which is precisely the
    /// kind of small lie this app spends its comments refusing to tell.
    var mayHaveEarlier: Bool = false

    /// The parsed blocks, sliced per turn and in message order.
    ///
    /// **The only form the transcript is kept in.** The snapshot used to carry the
    /// whole `[SylID: [MarkdownBlock]]` map beside this, with a `blocks(for:)` accessor
    /// that no caller ever used — `ChatView` reads `blocks(forGroup:)` and nothing else.
    ///
    /// It was not merely dead weight. A Swift dictionary is copy-on-write, so a snapshot
    /// holding the map kept `MarkdownCache`'s storage referenced twice, and the next
    /// insert into the cache therefore had to copy the entire spine before it could
    /// write one entry. Keeping it would have left the O(window) cost of `syl-025.2.5`
    /// exactly where it was for the case that matters most — one message arriving —
    /// while every count in `MarkdownCacheCostTests` reported success.
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

    #if DEBUG
        /// How many messages were handed to `MarkdownParser`.
        private var _parses = 0
        /// How many entries were WRITTEN into the cache's storage — inserts and
        /// removals alike, since both mutate it.
        ///
        /// The quantity the defect is about, and it is deliberately not the same
        /// question as `_parses`. The cache was already avoiding the re-parse and
        /// still rebuilding the whole dictionary around it, so a parse counter alone
        /// reported a cache working perfectly while it did N inserts per arriving
        /// message. Counted at each place an entry is written, never as a bookkeeping
        /// line beside the loop — a count derived from `messages.count` would agree
        /// with any implementation, including a wrong one.
        private var _entriesWritten = 0

        var parses: Int {
            lock.lock()
            defer { lock.unlock() }
            return _parses
        }

        var entriesWritten: Int {
            lock.lock()
            defer { lock.unlock() }
            return _entriesWritten
        }

        func resetCensus() {
            lock.lock()
            defer { lock.unlock() }
            _parses = 0
            _entriesWritten = 0
        }
    #endif

    init() {}

    /// Blocks for every given message, parsing only the ones not already held.
    ///
    /// Entries for messages no longer in the window are dropped, so a long-running
    /// session does not accumulate the parse of every message ever seen.
    ///
    /// ## Why this mutates in place rather than building a result (`syl-025.2.5`)
    ///
    /// It used to allocate a fresh N-entry dictionary on every call, copy every hit
    /// into it, and swap it in — so a window that had grown to two thousand paid two
    /// thousand hashed inserts to add the one message that had just arrived. **Every
    /// test it had was about the parse**, and the parse was already being avoided
    /// correctly, so the cost was invisible to the only question anyone was asking.
    /// `refresh()` drives this on every arriving message, every send, every foreground
    /// and every return to the tab, which is what made it O(window) per event.
    ///
    /// Now the work is proportional to what actually CHANGED: a missing key is parsed
    /// and inserted, a departed key is removed, and a window nobody touched writes
    /// nothing at all. What remains linear is the membership scan — N dictionary
    /// lookups to find the missing keys — and that is a hash per message against N
    /// allocations plus N inserts before.
    ///
    /// **The lock is now held across the parse**, where it used to be released. That is
    /// deliberate and it is affordable precisely because of the change: the critical
    /// section used to contain the whole rebuild and now contains only the delta.
    /// Concurrent loads happen — the socket refreshes while a widen is in flight — and
    /// the old release-and-swap let both parse the same new message and then let one
    /// clobber the other's cache wholesale.
    func blocks(for messages: [Message]) -> [SylID: [MarkdownBlock]] {
        lock.lock()
        defer { lock.unlock() }

        for message in messages where cache[message.id] == nil {
            // The one write site for an arriving message.
            cache[message.id] = MarkdownParser.parse(message.text)
            #if DEBUG
                _parses += 1
                _entriesWritten += 1
            #endif
        }

        // Exact, not a heuristic: every id in `messages` is now present, so a cache
        // larger than the window is larger by precisely the entries that have left it.
        // When nothing has left — the overwhelmingly common case, since the window only
        // ever grows — this costs one integer comparison and touches nothing.
        if cache.count > messages.count {
            var live = Set<SylID>(minimumCapacity: messages.count)
            for message in messages { live.insert(message.id) }
            // Collected before removing: mutating a dictionary while iterating its own
            // `keys` view is not allowed.
            let departed = cache.keys.filter { !live.contains($0) }
            for key in departed {
                cache.removeValue(forKey: key)
                #if DEBUG
                    _entriesWritten += 1
                #endif
            }
        }

        return cache
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
    /// The same page as `ChatViewModel`'s, from the same place. `LocalStore.messages`
    /// keeps its own default for its other callers; this read always passes one
    /// explicitly.
    var limit: Int = ChatPaging.pageSize
    var markdown = MarkdownCache()

    /// Rebuild the screen's state, reusing what a previous snapshot already decoded.
    ///
    /// ## Why this exists, with the number that decided it (`syl-025.2.6`)
    ///
    /// Measured on iPhone 17 / iOS 26.2 at a window of 2,000, warm cache, one arriving
    /// message — `LoadPassCostMeasurement`:
    ///
    ///     read+decode    93.25ms   73%
    ///     rows           21.21ms   17%
    ///     group           6.23ms    5%
    ///     byGroup         4.31ms    3%
    ///     parse-lookup    2.00ms    2%
    ///
    /// The SQL read and the per-row JSON payload decode were three quarters of the cost
    /// of learning about ONE new message, and `refresh()` runs on every arriving message,
    /// every send, every foreground and every return to the tab. The other four passes
    /// were the obvious target and are worth 27% between them; this is the 73%.
    ///
    /// **`reusing` is opt-in by the caller, and only the caller can know it is safe.**
    /// The window has to be the same one that produced `previous` — so `refresh()` passes
    /// the current snapshot, while `loadEarlier` and `collapseTheWindow`, which change the
    /// window on purpose, pass nothing and get the full read they need.
    ///
    /// ## What makes it exact rather than nearly right
    ///
    /// Confirmed rows are reused **without re-reading them**, which rests on the same
    /// assumption the markdown cache already rests on and which `ChatTests` already pins:
    /// a message's text is immutable once written, so its id is a safe key. This adds no
    /// second assumption of its own.
    ///
    /// Pending rows are never reused. They are re-read wholesale every load, exactly as
    /// before, because an optimistic row is the one thing here that DOES change identity:
    /// reconciliation gives it a server id and a real seq. So it leaves through the
    /// pending set and returns through the arrivals read, and the two halves cannot
    /// disagree about it.
    ///
    /// Any answer this cannot give exactly, it declines to give: more arrivals than a
    /// whole window means the window turned over, and it falls back to the full read
    /// rather than reasoning about a prefix it can no longer vouch for.
    func load(reusing previous: ChatSnapshot? = nil) throws -> ChatSnapshot {
        if let previous, let reused = try incremental(from: previous) { return reused }
        return try full()
    }

    /// The delta path. `nil` when it cannot answer exactly, which is never an error.
    private func incremental(from previous: ChatSnapshot) throws -> ChatSnapshot? {
        let held = previous.groups.flatMap(\.messages)
        // Nothing to build on, and a first load has nothing to save anyway.
        guard !held.isEmpty else { return nil }

        // **The snapshot has to have come from THIS window.**
        //
        // A previous snapshot that was trimmed held exactly its own limit, so if that
        // count is not this limit it was taken at a different width and its prefix says
        // nothing about what belongs here. Reusing one taken narrower would hand back a
        // short window — a widen that silently did not widen — which is what the caller
        // contract is meant to prevent and what this catches when it does not.
        //
        // A snapshot that was NOT trimmed held everything there was, so there is nothing
        // older for a wider window to add and it is safe at any limit.
        guard !previous.mayHaveEarlier || held.count == limit else { return nil }

        // Confirmed rows only. The pending ones are re-read below, because they are the
        // rows whose identity can change underneath this.
        let settled = held.filter { $0.seq > 0 }
        guard let mark = settled.last?.seq else { return nil }

        // One more than a whole window: past that the window has turned over and there is
        // no prefix left worth reusing.
        let arrived = try store.messages(
            conversationId: conversationId, newerThan: mark, limit: limit + 1
        )
        guard arrived.count <= limit else { return nil }

        let pending = try store.pendingMessages()

        // **Sorted, rather than assumed to be in order.**
        //
        // The first version of this concatenated the three and relied on an optimistic
        // row being the newest thing in the transcript because it is created locally,
        // now. That is true of the app and was not true of a test fixture that timestamped
        // a send mid-transcript — and the delta silently disagreed with the full read,
        // which is exactly the shape of bug this whole path must not have. The store
        // orders `createdAt` then `seq`; matching it explicitly costs one sort of an
        // already-decoded array against the ninety-three milliseconds of decoding this
        // avoids, and it removes an unstated assumption rather than adding one.
        let joined = (settled + arrived + pending).sorted {
            ($0.createdAt, $0.seq) < ($1.createdAt, $1.seq)
        }

        // Trimming can only ever reveal that there is more, never that there is less.
        let overflowed = joined.count > limit
        let messages = overflowed ? Array(joined.suffix(limit)) : joined

        return try assemble(
            messages: messages,
            pending: pending,
            mayHaveEarlier: previous.mayHaveEarlier || overflowed
        )
    }

    private func full() throws -> ChatSnapshot {
        // One more than we intend to show. Its existence is the exact answer to "is
        // there older history", and it is discarded immediately.
        let window = try store.messages(conversationId: conversationId, limit: limit + 1)
        let mayHaveEarlier = window.count > limit
        let messages = mayHaveEarlier ? Array(window.dropFirst()) : window

        return try assemble(
            messages: messages,
            pending: try store.pendingMessages(),
            mayHaveEarlier: mayHaveEarlier
        )
    }

    /// Everything downstream of "which messages", shared by both paths so they cannot
    /// drift into producing differently-shaped snapshots from the same rows.
    private func assemble(
        messages: [Message],
        pending: [Message],
        mayHaveEarlier: Bool
    ) throws -> ChatSnapshot {
        let pendingIds = Set(pending.map(\.id))
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
            mayHaveEarlier: mayHaveEarlier,
            blocksByGroup: byGroup
        )
    }
}
