import Foundation
import SylKit

/// Drives From Syl.
///
/// ## Why the snapshot starts as nil, and what nil means
///
/// **"I have not asked" is not "she has sent you nothing".** An empty
/// `SendingListSnapshot` renders *"Nothing here yet"*, which is a true sentence about a
/// device that has asked and a confident false one about a device that has not — and the
/// second is exactly the state a first launch on a dead tailnet is in. So nil means not
/// asked, renders as the bare veil, and is only ever replaced by an answer.
///
/// `GoalsViewModel` draws the same distinction for the same reason. It matters more here:
/// a goals list that says "no goals yet" is wrong about something he wrote down, and this
/// one would be wrong about something she gave him.
///
/// ## Disk first, then the network
///
/// The stored rows are drawn before anything is asked of the network, so the surface
/// opens instantly and offline from the last answer the server gave. A failed refresh
/// then costs the refresh and not the screen.
@MainActor
final class FromSylViewModel: ObservableObject {
    /// Nil until something answers. See the note above.
    @Published private(set) var snapshot: SendingListSnapshot?

    private let source: SendingSource
    private let clock: @Sendable () -> Date
    private let calendar: Calendar
    private let timeZone: TimeZone
    private let locale: Locale

    init(
        source: SendingSource,
        calendar: Calendar = .current,
        timeZone: TimeZone = .current,
        locale: Locale = .current,
        clock: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.source = source
        self.calendar = calendar
        self.timeZone = timeZone
        self.locale = locale
        self.clock = clock
    }

    /// Read the disk, then ask the server, publishing whichever answers.
    ///
    /// Both reads and both projections happen off the main actor and one finished value
    /// comes back — the pattern `GoalsViewModel` and `ChatSnapshotLoader` established,
    /// for the same reason: the main actor should only ever do the assignment.
    func refresh() async {
        // What is already here. Drawn first, and skipped when it is empty — an empty
        // disk is not an answer, and publishing it would make the same false statement
        // nil exists to avoid.
        let source = self.source
        if let stored = await project({ try? source.cached() }), !stored.isEmpty {
            snapshot = stored
        }

        // Then the server. A throw leaves whatever is on screen exactly as it is.
        guard let fetched = await project({ try? await source.refresh() }) else { return }
        snapshot = fetched
    }

    /// Run a read off the main actor and project its result there too.
    ///
    /// Returns nil when the read produced nothing, which is how a failure stays
    /// distinguishable from an empty answer all the way up to the assignment.
    private func project(
        _ read: @escaping @Sendable () async -> [Sending]?
    ) async -> SendingListSnapshot? {
        let now = clock()
        let calendar = self.calendar
        let timeZone = self.timeZone
        let locale = self.locale

        return await Task.detached(priority: .userInitiated) { () -> SendingListSnapshot? in
            guard let sendings = await read() else { return nil }
            return SendingListSnapshot.project(
                sendings, now: now, calendar: calendar, timeZone: timeZone, locale: locale)
        }.value
    }
}
