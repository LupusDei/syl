import Foundation
import SylKit

/// Drives the list, and owns the one write on it: capture.
///
/// The split is the same one `HomeViewModel` and `ChatViewModel` make — everything that
/// observes lives here, everything that draws lives one level down — so `TodoListView`
/// stays a pure function of values that a test or a render harness can construct without
/// booting the app's object graph.
@MainActor
final class TodoListViewModel: ObservableObject {
    @Published private(set) var snapshot = TodoListSnapshot()

    private let store: LocalStore
    private let now: @Sendable () -> Date
    private let calendar: Calendar
    private let makeIdempotencyKey: @Sendable () -> String
    private let flush: @Sendable () async -> Void

    init(
        store: LocalStore,
        calendar: Calendar = .current,
        now: @escaping @Sendable () -> Date = { Date() },
        /// Minted once per capture and stored on the outbox row, never regenerated per
        /// attempt. A key regenerated per attempt is the same as having no key at all.
        makeIdempotencyKey: @escaping @Sendable () -> String = { IdempotencyKey.generate() },
        /// Runs the outbox. Called after a capture so a to-do written on a live network
        /// reaches Syl promptly rather than waiting for the next scheduled sync. The
        /// default does nothing, which is correct offline and honest everywhere else: the
        /// row is already durable and the engine will find it.
        flush: @escaping @Sendable () async -> Void = {}
    ) {
        self.store = store
        self.calendar = calendar
        self.now = now
        self.makeIdempotencyKey = makeIdempotencyKey
        self.flush = flush
    }

    /// Rebuild the list from disk.
    ///
    /// The read, the ordering, the banding and the goal resolution all happen off the
    /// main actor and one finished value comes back — the pattern `ChatSnapshotLoader`
    /// established, for the reason it established it: at five hundred rows this is the
    /// difference between a smooth scroll and a visible stutter on every refresh.
    func refresh() async {
        let loader = TodoListLoader(store: store, now: now(), calendar: calendar)

        let loaded = await Task.detached(priority: .userInitiated) { () -> TodoListSnapshot? in
            try? loader.load()
        }.value

        guard let loaded else { return }
        snapshot = loaded
    }

    /// Write one down.
    ///
    /// **No confirmation step and no inbox.** The row exists the moment he commits: the
    /// local to-do and the outbox intent land in one transaction inside
    /// `LocalStore.createTodo`, before anything touches the network, so this works
    /// identically with the server unreachable.
    ///
    /// An empty capture writes nothing and says nothing. It is guarded here *and*
    /// refused inside `createTodo` with `LocalStoreError.emptyCapture`; the store's guard
    /// is the one that cannot be bypassed, and this one exists so the common case never
    /// throws at all. An error message for a stray tap would be the app scolding him for
    /// a gesture that meant nothing.
    ///
    /// A genuine write failure — a database that will not write — is **not** silently
    /// papered over. `createTodo` writes the row and the intent in one transaction, so a
    /// failure means neither exists, and skipping the refresh leaves the to-do he just
    /// typed visibly absent rather than falsely present. That is the loud half. Saying so
    /// in words on the row is `syl-011.4.8`.
    func capture(_ raw: String) async {
        guard let sentence = CaptureField.sentence(from: raw) else { return }

        do {
            _ = try store.createTodo(
                text: sentence,
                idempotencyKey: makeIdempotencyKey(),
                now: now()
            )
        } catch {
            return
        }

        await refresh()
        await flush()
    }
}
