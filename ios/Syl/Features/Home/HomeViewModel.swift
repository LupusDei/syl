import Foundation
import SylKit

/// Drives the home screen.
///
/// Two jobs, and they are on different clocks: keep the day's spine current against the
/// disk, and keep Syl's presence honest against the TTL rules.
@MainActor
final class HomeViewModel: ObservableObject {
    @Published private(set) var snapshot = HomeSnapshot()
    @Published private(set) var presence: PresenceState = .absent
    @Published private(set) var intensity: Double = 0
    @Published private(set) var now: Date = Date()

    /// The device's copy of everything, readable by the screen that owns this model.
    ///
    /// Internal rather than private since `syl-011.5.3`: the Goals orb is a door, and the
    /// screen behind it reads from the same store this one does. Passing it down from
    /// `SylApp` instead would mean a second route to the same object and one more place
    /// for the two to disagree about which database is open.
    let store: LocalStore
    private let clock: @Sendable () -> Date
    /// Runs the outbox now. Called after every write he made with his own finger, so a
    /// completion leaves the device promptly rather than waiting for the next scheduled
    /// sync — the same rule `ChatViewModel` applies to a send.
    private let flush: @Sendable () async -> Void
    private let makeIdempotencyKey: @Sendable () -> String
    /// How long a finished row is held on screen before it is allowed to leave.
    private let settle: Duration

    /// What Syl refused, per row, until he acts on that row again or dismisses it.
    ///
    /// Kept here rather than in the snapshot because it is not on disk and must not be:
    /// it is the answer to a tap, and it has to survive the minute refresh that would
    /// otherwise wipe it before he had read it. Re-applied on every rebuild.
    private var refusals: [SylID: String] = [:]

    /// The finished row's departure, held so a second completion cannot leave two of
    /// these racing to refresh the same screen.
    private var departure: Task<Void, Never>?

    /// The decayed view of presence. **Not** the last frame's raw state.
    ///
    /// `ChatViewModel` keeps the raw state, which means a dropped connection leaves it
    /// asserting `thinking` forever — the exact "frozen mid-thought" failure
    /// `PresenceTimeline` exists to prevent. Home cannot inherit that: it is the screen
    /// the character actually lives on, so a lie here is a lie about the whole system.
    /// Filed separately as the same defect in chat.
    private var timeline = PresenceTimeline()

    /// One timer, armed for the next boundary — not a poll.
    private var decay: Task<Void, Never>?
    private var refreshLoop: Task<Void, Never>?

    init(
        store: LocalStore,
        clock: @escaping @Sendable () -> Date = { Date() },
        /// Drains the outbox. Defaults to doing nothing, which is honest for a model
        /// nobody wired a sync engine to: the intent is still durable on disk.
        flush: @escaping @Sendable () async -> Void = {},
        makeIdempotencyKey: @escaping @Sendable () -> String = { IdempotencyKey.generate() },
        /// The beat a finished row is held for. Long enough to be read as confirmation,
        /// short enough that the day does not feel stuck.
        settle: Duration = .milliseconds(1100)
    ) {
        self.store = store
        self.clock = clock
        self.flush = flush
        self.makeIdempotencyKey = makeIdempotencyKey
        self.settle = settle
    }

    deinit {
        decay?.cancel()
        refreshLoop?.cancel()
        departure?.cancel()
    }

    // MARK: - Lifecycle

    /// Load once, then keep the day current.
    ///
    /// The minute cadence is what moves an item from `upcoming` to `due` as its time
    /// arrives. Anything faster is wasted — nothing on this screen changes faster than
    /// a minute except presence, which is event-driven and does not go through here.
    func start() {
        refreshLoop?.cancel()
        refreshLoop = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                try? await Task.sleep(for: .seconds(60))
            }
        }
    }

    func stop() {
        refreshLoop?.cancel()
        refreshLoop = nil
    }

    /// Rebuild the spine from disk.
    ///
    /// The read and the grouping happen off the main actor and one finished value comes
    /// back — the pattern `ChatSnapshotLoader` established, for the same reason: the
    /// main actor should only ever do the assignment.
    func refresh() async {
        let instant = clock()
        let loader = HomeSnapshotLoader(store: store, now: instant)

        let loaded = await Task.detached(priority: .userInitiated) { () -> HomeSnapshot? in
            try? loader.load()
        }.value

        guard let loaded else { return }

        now = instant
        // Refusals are re-applied rather than dropped. The spine rebuilds itself every
        // minute; a refusal a scheduled refresh erased would be a message he might never
        // have seen at all.
        snapshot = loaded.applying(refusals: refusals)
    }

    // MARK: - Finishing a thing

    /// Marks a moment finished: disk first, then the screen, then away.
    ///
    /// The order is the same one `ChatViewModel.send` states and is not negotiable.
    /// **Disk first**, because `LocalStore` writes the row and the outbox intent in one
    /// transaction and is the only thing that can refuse: an already-finished item, one
    /// this device has never seen, a capture Syl has not acknowledged yet. Rendering the
    /// row done and *then* asking would mean showing him work nobody did.
    ///
    /// Once it lands the row settles rather than disappearing — see
    /// ``HomeSnapshot/marking(_:as:)`` for why that matters — and the departure is a
    /// task of its own so this call returns with the confirmation already on screen.
    func complete(_ moment: DayMoment) async {
        let id = SylIDs.canonical(moment.id)
        // Acting on a row is what clears whatever she last said about it. Anything else
        // leaves a stale refusal sitting under a row that has since worked.
        refusals[id] = nil

        do {
            switch moment.origin {
            case .todo:
                _ = try store.completeTodo(
                    id: moment.id, idempotencyKey: makeIdempotencyKey(), now: clock())
            case .reminder:
                _ = try store.completeReminder(
                    id: moment.id, idempotencyKey: makeIdempotencyKey(), now: clock())
            }
        } catch {
            refuse(error, on: id)
            return
        }

        snapshot = snapshot.marking(id, as: .done).applying(refusals: refusals)

        departure?.cancel()
        departure = Task { [weak self] in
            guard let self else { return }
            try? await Task.sleep(for: self.settle)
            guard !Task.isCancelled else { return }
            await self.refresh()
            await self.push()
        }
    }

    /// Asks Syl to move a reminder. **It does not move it.**
    ///
    /// The device may not compute the new instant — the server owns it (plan D2,
    /// constraint 4) — so nothing here touches `nextFireAt` and nothing renders a new
    /// time. `LocalStore.snoozeReminder` records only *that he asked and when*, the row
    /// says so beside the time the server last stated, and it settles when the server's
    /// copy arrives or when a refusal clears the marker.
    ///
    /// The duration is `ReminderNotification.snoozeMinutes` rather than a number of its
    /// own, so Later on the row and Snooze on the notification mean the same thing.
    func postpone(_ moment: DayMoment, minutes: Int = ReminderNotification.snoozeMinutes) async {
        // The row hides Later when it cannot be honoured — a to-do, a finished item, or a
        // deferral already in flight. This is the second lock, so a stale row or a future
        // caller cannot queue the second ask that would land the reminder half an hour
        // late instead of fifteen minutes.
        guard moment.mayBeDeferred else { return }

        let id = SylIDs.canonical(moment.id)
        refusals[id] = nil

        do {
            try store.snoozeReminder(
                id: moment.id, minutes: minutes,
                idempotencyKey: makeIdempotencyKey(), now: clock())
        } catch {
            refuse(error, on: id)
            return
        }

        // The ask is on disk, so a plain rebuild is what puts it on the row — there is
        // nothing to render optimistically, which is the entire point.
        await refresh()
        await push()
    }

    /// Takes Syl's refusal off a row. The only thing that clears one, besides acting on
    /// that row again.
    func dismissRefusal(_ id: SylID) {
        refusals[SylIDs.canonical(id)] = nil
        snapshot = snapshot.applying(refusals: refusals)
    }

    /// Waits for a settling row to actually leave.
    ///
    /// A test seam, and deliberately a narrow one: the departure has to be a task rather
    /// than an `await` inside ``complete(_:)`` so the confirmation is observable on its
    /// own, and a test that cannot then wait for the second half would have to sleep.
    func awaitDeparture() async {
        await departure?.value
    }

    /// Records what she refused, on the row it is about.
    private func refuse(_ error: Error, on id: SylID) {
        refusals[id] = DayRefusal.phrase(for: error)
        snapshot = snapshot.applying(refusals: refusals)
    }

    /// Push what he just asked for, then show whatever came back.
    private func push() async {
        await flush()
        await refresh()
    }

    // MARK: - Presence

    /// Feed the socket. Only presence frames matter here; everything else belongs to
    /// chat and to the sync engine.
    func apply(_ event: SocketEvent) {
        switch event {
        case .presence(let frame):
            timeline.record(frame, at: clock())
            refreshPresence()

        case .connectionState(let state):
            // A presence state that survived a disconnection would be asserting
            // something about *now* that stopped being true the moment the socket died.
            switch state {
            case .offline, .unauthenticated, .idle:
                timeline.clear()
                refreshPresence()
            default:
                break
            }

        default:
            break
        }
    }

    private func refreshPresence() {
        let instant = clock()
        presence = timeline.state(at: instant)
        intensity = timeline.intensity(at: instant)
        armDecay(from: instant)
    }

    /// Arm a single timer for the next moment the rendered state changes.
    ///
    /// `PresenceTimeline` exposes `nextTransition()` precisely "so a view can schedule
    /// one timer instead of polling". There are two boundaries on the ladder — the TTL
    /// expiring into `idle`, and the further grace expiring into `absent` — so this
    /// picks whichever is next and re-arms itself when it fires.
    private func armDecay(from instant: Date) {
        decay?.cancel()

        guard let ttlExpiry = timeline.nextTransition() else { return }
        let boundaries = [ttlExpiry, ttlExpiry.addingTimeInterval(PresenceTimeline.idleGrace)]
        guard let next = boundaries.first(where: { $0 > instant }) else { return }

        let delay = next.timeIntervalSince(instant)
        decay = Task { [weak self] in
            try? await Task.sleep(for: .seconds(max(delay, 0.05)))
            guard !Task.isCancelled else { return }
            self?.refreshPresence()
        }
    }
}
