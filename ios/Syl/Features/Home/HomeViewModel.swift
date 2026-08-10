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

    private let store: LocalStore
    private let clock: @Sendable () -> Date

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

    init(store: LocalStore, clock: @escaping @Sendable () -> Date = { Date() }) {
        self.store = store
        self.clock = clock
    }

    deinit {
        decay?.cancel()
        refreshLoop?.cancel()
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
        snapshot = loaded
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
