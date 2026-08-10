import Foundation
import SylKit

/// Drives the goals screen.
///
/// One job: keep the list current against the disk. There is no network call anywhere on
/// this path — `SyncEngine` puts goals on the device and this reads them, so the screen
/// opens from disk with the server unreachable, which is the epic's whole acceptance
/// criterion.
///
/// ## Why the snapshot starts as nil rather than as an empty list
///
/// NFR1 forbids a spinner on open. An empty `GoalListSnapshot` would render *"No goals
/// yet"* for the frame before the first load lands — which is not a spinner, it is worse:
/// a confident false statement. `nil` means "not asked yet" and renders nothing at all,
/// so the only two things this screen can ever say are true ones.
@MainActor
final class GoalsViewModel: ObservableObject {
    /// Nil until the first load lands. See the note above.
    @Published private(set) var snapshot: GoalListSnapshot?

    private let store: LocalStore
    private let clock: @Sendable () -> Date
    private let calendar: Calendar

    init(
        store: LocalStore,
        calendar: Calendar = .current,
        clock: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.store = store
        self.calendar = calendar
        self.clock = clock
    }

    /// Rebuild the list from disk.
    ///
    /// The read and the projection happen off the main actor and one finished value comes
    /// back — the pattern `ChatSnapshotLoader` established, for the same reason: the main
    /// actor should only ever do the assignment.
    func refresh() async {
        let loader = GoalSnapshotLoader(store: store, now: clock(), calendar: calendar)

        let loaded = await Task.detached(priority: .userInitiated) { () -> GoalListSnapshot? in
            try? loader.load()
        }.value

        // A failed read leaves the previous answer on screen rather than replacing it with
        // an empty one. A list that empties itself because a query threw is a list that
        // says his goals are gone.
        guard let loaded else { return }
        snapshot = loaded
    }
}
