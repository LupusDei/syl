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

    /// The decayed view of presence. **Not** the last frame's raw state.
    ///
    /// This screen used to store `frame.state` directly, which meant a dropped socket
    /// left Syl asserting `thinking` forever — the exact failure `PresenceTimeline`
    /// exists to prevent, and worse here than on home, because this is the screen where
    /// "she is thinking" is a claim about a turn the Commander is actually waiting on.
    /// A character frozen mid-thought is worse than no character at all: it actively
    /// misrepresents what the system is doing. The failure mode has to be quiet, not
    /// stuck.
    @Published private(set) var presence: PresenceState = .absent

    /// How strongly to render that presence, already clamped. Zero once the state has
    /// expired — an amplitude outliving its state is the same lie as the state itself.
    @Published private(set) var intensity: Double = 0
    /// Non-nil when something is stuck and the Commander should know. Offline is a
    /// state to design, not an error to report — but a message that cannot be sent is
    /// worth saying out loud.
    @Published private(set) var notice: String?

    /// What he is typing.
    ///
    /// **A separate observable, and that separation is the fix.** This was
    /// `@Published var draft` on this object — the same object the transcript observes —
    /// so every character invalidated `ChatView.body` and everything under it. Nothing he
    /// types is about the transcript, and it was rebuilding twenty to thirty rows per
    /// keystroke to find that out.
    ///
    /// Held as a plain `let`. Reading a `let` does not subscribe, so `ChatView` can hand
    /// this to the composer without hearing about it; only `ChatComposer` observes it, and
    /// only the composer redraws.
    let draft = ChatDraft()

    /// How many messages the window currently reaches back over.
    ///
    /// Exposed because three separate requirements are statements about it -- it must not
    /// grow on a read that failed, it must come back down at the foot, and it must never
    /// disagree with what is on screen -- and none of them could be observed at all while
    /// it was buried in the loader. A test that can only see the snapshot cannot tell a
    /// window that did not move from one that moved and was not drawn, which is exactly
    /// the difference `syl-025.1.3.1` is about.
    var windowSize: Int { loader.limit }

    /// True while an older page is being read. Kept so the affordance can say it is
    /// working and so a fast scroll cannot queue five overlapping loads.
    @Published private(set) var isLoadingEarlier = false

    /// Whether a turn he asked for is still outstanding.
    ///
    /// Set when a send is queued and cleared the moment she answers — or the moment
    /// nothing is vouching for it any more. See ``armTurnWatch(from:)`` for why that
    /// second condition is presence rather than a stopwatch.
    @Published private(set) var isAwaitingReply = false

    private let store: LocalStore
    /// `var`: the window grows as the Commander reaches back through history.
    private var loader: ChatSnapshotLoader
    /// How much further back each "load earlier" reaches.
    private let pageSize: Int
    private let conversationId: SylID
    private let sendOverSocket: @Sendable (_ text: String, _ clientId: String, _ key: String) async throws -> Void
    /// Puts one attachment's bytes on the server and hands back the row it made.
    ///
    /// Injected rather than reached for, so the ordering rule in ``send(staging:)`` can
    /// be tested — including the case where the upload fails partway — without a server
    /// and without a network stub.
    private let uploadAttachment: @Sendable (CreateAttachmentRequest, String) async throws -> Attachment
    private let flush: @Sendable () async -> Void
    private let now: @Sendable () -> Date
    private let makeClientId: @Sendable () -> String
    private let makeIdempotencyKey: @Sendable () -> String

    /// Stamps each read so a superseded one cannot assign its result. See ``read(with:)``.
    private var generation = 0

    /// Whether the automatic trigger has already spent itself on this arrival at the top.
    ///
    /// Model state, not view state, and that is the entire point — see
    /// ``reachedTheTopOfTheWindow()``.
    private var automaticLoadIsSpent = false

    /// The presence ladder. Frames go in, a decayed state comes out.
    private var timeline = PresenceTimeline()

    /// One armed timer for the next moment the rendered state changes, rather than a
    /// poll. Cancelled and re-armed on every frame.
    private var decay: Task<Void, Never>?

    /// Armed while a turn is outstanding; fires when presence can no longer speak for it.
    private var turnWatch: Task<Void, Never>?

    /// How long a turn is given when presence never said anything about it at all.
    ///
    /// Only reached when a send goes out and **no** presence frame follows — a socket
    /// that was never up, or a service that accepted the message and died before
    /// announcing the turn. When presence does speak, its own ladder is the deadline and
    /// this is not consulted. Deliberately the same length as that ladder
    /// (`thinking`'s 15-second TTL plus the 30-second grace) so the two cases cannot
    /// disagree about how long silence is allowed to last.
    ///
    /// It is also the floor after a **socket drop**, which clears the timeline outright.
    /// A drop must not declare the turn lost on the spot: the client reconnects and the
    /// server replays from the high-water mark, so the reply very often arrives a second
    /// later. Waiting the same silence out is what tells the two apart.
    static let defaultTurnSilence: TimeInterval = 45

    /// Injected so a test can assert the floor without waiting it out in real seconds.
    /// The watch sleeps in real time — `now` decides what it *concludes*, not when it
    /// wakes — so this is the only way to exercise the no-presence path at all.
    private let turnSilence: TimeInterval

    init(
        store: LocalStore,
        conversationId: SylID = SylIDs.interactiveConversation,
        /// One page. Named in `ChatPaging` rather than written here, because the last
        /// time this number lived in two places they drifted apart by a factor of four
        /// and no test could see it.
        limit: Int = ChatPaging.pageSize,
        /// Sends over the live socket. Throws when it is not up, which is the cue to
        /// leave the intent in the outbox for the sync engine.
        sendOverSocket: @escaping @Sendable (String, String, String) async throws -> Void = { _, _, _ in
            throw WebSocketClient.NotConnected()
        },
        /// Uploads one attachment. The default throws, which is correct for every
        /// caller that does not stage attachments and honest for one that does without
        /// wiring this: the send parks rather than pretending to have gone.
        uploadAttachment: @escaping @Sendable (CreateAttachmentRequest, String) async throws -> Attachment = { _, _ in
            throw AttachmentFetchError.offline
        },
        /// Runs the outbox. Called after a send so a queued message leaves promptly
        /// rather than waiting for the next scheduled sync.
        flush: @escaping @Sendable () async -> Void = {},
        now: @escaping @Sendable () -> Date = { Date() },
        makeClientId: @escaping @Sendable () -> String = { UUID().uuidString },
        makeIdempotencyKey: @escaping @Sendable () -> String = { IdempotencyKey.generate() },
        turnSilence: TimeInterval = ChatViewModel.defaultTurnSilence
    ) {
        self.turnSilence = turnSilence
        self.store = store
        self.conversationId = conversationId
        self.pageSize = limit
        self.loader = ChatSnapshotLoader(store: store, conversationId: conversationId, limit: limit)
        self.sendOverSocket = sendOverSocket
        self.uploadAttachment = uploadAttachment
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
        await read(with: loader)
    }

    /// Reads with a given window and applies the result, reporting whether it landed.
    ///
    /// ## Why the window is a parameter rather than the stored one
    ///
    /// So a widen can be **proposed** and only committed if the read behind it worked.
    /// `loadEarlier()` used to advance `loader.limit` and *then* refresh, and the failure
    /// path returns leaving the snapshot untouched — so a store that throws three times
    /// left the limit at 200 while the screen still showed 50, and the next successful
    /// read, triggered by an arriving message he had nothing to do with, painted all 200
    /// at once. A window that grew on a read that failed is worse than a failed read.
    ///
    /// ## Why the generation stamp
    ///
    /// Three callers refresh independently — the view's `task`, an arriving socket
    /// message, and background sync — and this suspends in the middle. A sync-driven read
    /// captured at fifty could resolve *after* his tap-driven read at a hundred and assign
    /// the narrower snapshot, collapsing his history under him while `loader.limit` still
    /// said a hundred. Stamping each read and dropping any result that is no longer the
    /// newest makes the last read to *start* the one that wins, which is the only ordering
    /// that matches what he last asked for.
    @discardableResult
    private func read(with window: ChatSnapshotLoader) async -> Bool {
        generation &+= 1
        let stamp = generation

        let snapshot = await Task.detached(priority: .userInitiated) {
            try? window.load()
        }.value

        // Superseded. Not a failure — the newer read speaks for him — but this result
        // must not be applied and its window must not be committed.
        guard stamp == generation else { return false }

        guard let snapshot else {
            notice = "Could not read the conversation from this device."
            return false
        }
        self.snapshot = snapshot
        return true
    }

    /// **He asked.** One tap, one page, every time.
    ///
    /// Deliberately unlatched. The automatic trigger below can misfire, and when it does
    /// this control is the only way back — that is the stated reason it was built, and a
    /// latch that also swallowed his second tap would take the fallback away exactly
    /// when it is needed.
    func loadEarlier() async {
        await widenTheWindow()
    }

    /// The top of the window came into view. **At most one page per arrival.**
    ///
    /// ## The runaway this replaces
    ///
    /// `loadEarlier()` used to be driven from an `onAppear` on the `EarlierMessages` row
    /// inside the `LazyVStack`. Widening reassigns the whole snapshot, which rebuilds
    /// that subtree, which re-creates the row, which fires `onAppear` again — and
    /// `defer` had already cleared `isLoadingEarlier` before the next appearance. The
    /// loop terminated on `mayHaveEarlier == false`, which is to say **when the entire
    /// conversation was resident in memory.** No finger touched the screen. The page
    /// size was never a cap; it was a step size.
    ///
    /// `onAppear` inside a `LazyVStack` does not mean "became visible". It means "was
    /// instantiated", which is true for rows nowhere near the screen whenever something
    /// forces the stack to size its whole content, and true again on every subtree
    /// rebuild. Neither is "he scrolled to the top", so anything using it as a scroll
    /// trigger is wrong by construction.
    ///
    /// The latch lives **here, on the model**, and that placement is the fix. View state
    /// is destroyed and recreated by the very rebuild the load causes, so a latch in the
    /// view would be reset by the thing it exists to stop.
    func reachedTheTopOfTheWindow() async {
        // **Every condition is checked, and the latch is set, before the first `await`.**
        // Two wrong shapes, both of which look right:
        //
        // - Spending the latch and *then* calling `widenTheWindow()` consumes the arrival
        //   even when the widen early-returns — a tap already in flight, or nothing older
        //   to read — so the trigger is gone and no page arrived. It degrades to "tap to
        //   continue", which is the safe direction, and it is still wrong.
        // - Spending it *after* the widen returns reopens the runaway outright, because
        //   the widen suspends: further reports of the top re-enter across the await with
        //   the latch still false.
        //
        // Synchronous guard, synchronous set, then suspend. Actor reentrancy cannot get
        // between them.
        guard !automaticLoadIsSpent, snapshot.mayHaveEarlier, !isLoadingEarlier else { return }
        automaticLoadIsSpent = true
        await widenTheWindow()
    }

    /// The top of the window is behind him again. Re-arms the automatic trigger.
    ///
    /// Without this the automatic load would fire once per session rather than once per
    /// arrival, and reaching back through a long history would mean tapping for every
    /// page after the first.
    func leftTheTopOfTheWindow() {
        automaticLoadIsSpent = false
    }

    /// Widen the window and read again.
    ///
    /// The transcript was hard-capped with no way to reach anything older — a
    /// conversation that has run for a month simply had no beginning. The window grows,
    /// the loader re-reads, and the markdown cache keeps every message it has already
    /// parsed, so reaching further back costs only the new page.
    ///
    /// `isLoadingEarlier` makes this one-at-a-time rather than one-per-trigger: a fast
    /// flick would otherwise start several overlapping reads that each widen again.
    /// **It was never sufficient on its own** — it is cleared before the next appearance
    /// of a row that re-fires — which is what the latch above is for.
    private func widenTheWindow() async {
        guard snapshot.mayHaveEarlier, !isLoadingEarlier else { return }

        isLoadingEarlier = true
        defer { isLoadingEarlier = false }

        // Proposed, then committed only if the read behind it landed. The old shape
        // advanced the stored limit first, so a read that threw left the window wider
        // than the screen and the next unrelated refresh paid for it.
        var widened = loader
        widened.limit += pageSize
        guard await read(with: widened) else { return }
        loader = widened
    }

    /// Let the window fall back to one page.
    ///
    /// **The window only ever grew.** There was exactly one write to it in the whole app,
    /// `+= pageSize`, and `ChatViewModel` is built once at launch and outlives the screen —
    /// so a browse back through history was permanent for the life of the process.
    /// Navigating away did not clear it, backgrounding did not clear it, and returning to
    /// the tab re-read and rebuilt the whole grown window because the view is recreated
    /// even though the model is not. Only killing the app brought it down.
    ///
    /// That is very likely the whole of what the Commander reported: a bounded,
    /// legitimate, user-initiated action with an unbounded and permanent cost.
    ///
    /// **A pending row cannot be lost here.** The window is anchored at the newest end and
    /// an optimistic bubble is by definition the newest thing in it, so collapsing to the
    /// newest page always keeps it. Asserted rather than guarded, because a guard on
    /// `pendingCount` would quietly stop collapsing for anyone whose outbox is backed up —
    /// which is exactly when the window most needs to come down.
    func collapseTheWindow() async {
        guard loader.limit > pageSize, !isLoadingEarlier, !isAwaitingReply else { return }

        var collapsed = loader
        collapsed.limit = pageSize
        guard await read(with: collapsed) else { return }
        loader = collapsed
        // A fresh window means the top of it is somewhere he has not been. Re-arm.
        automaticLoadIsSpent = false
    }

    // MARK: - Sending

    /// Renders the bubble, queues the intent, and tries the socket.
    ///
    /// The order matters and is not negotiable: **disk first**. If the app is killed
    /// between the write and the send, the message is still queued and still on screen.
    /// If it were sent first, a crash would lose both the bubble and the intent.
    ///
    /// ## The same rule, applied to bytes (D7, T036)
    ///
    /// A staged attachment goes through the identical ordering, and the temptation to
    /// invert it is much stronger here — uploading first would hand back a real server
    /// id and save a second write. It is exactly as wrong: a crash mid-upload would lose
    /// the bubble, the words and the picture, and the Commander would have no evidence
    /// he ever sent anything.
    ///
    /// So the sequence is:
    ///
    /// 1. **Prime the byte cache** under locally-minted ids, so the bubble draws the
    ///    picture he just chose rather than fetching a copy of it back from the Mac.
    /// 2. **Write disk** — the optimistic row *with those local attachments*, and the
    ///    outbox intent, in one transaction. Nothing has left the device yet.
    /// 3. **Upload**, one attachment at a time.
    /// 4. **Swap in the server's ids and release the send.**
    ///
    /// Between 2 and 4 the outbox row is parked (`blockedReason`), because a send naming
    /// local ids is `VALIDATION_FAILED` forever and a send with the ids stripped would
    /// deliver the words without the picture. Parked is neither: it is a durable,
    /// visible "not yet".
    func send(staging: [StagedAttachment] = []) async {
        let text = draft.text.trimmingCharacters(in: .whitespacesAndNewlines)
        // A message must say something. A picture says something.
        //
        // The contract required non-empty text until `syl-008.8`, which made "send a
        // photo, no caption" impossible — the most ordinary thing anyone does with a
        // picture. The Commander's call, 2026-08-10.
        //
        // What did NOT change: an empty draft with nothing staged still sends nothing.
        // That is a stray tap on the send control, and turning it into a blank bubble
        // in his transcript would be permanent.
        //
        // The client deliberately does not invent a caption here — a filename or a
        // space in the text field would be the app putting words in his mouth.
        guard !text.isEmpty || !staging.isEmpty else { return }

        let clientId = makeClientId()
        let idempotencyKey = makeIdempotencyKey()

        // Before the write, so a bubble that renders on the very next `refresh()` has
        // its bytes already in hand.
        for staged in staging {
            AttachmentLoader.prime(attachmentId: staged.id, data: staged.data)
        }

        do {
            _ = try store.enqueueSend(
                conversationId: conversationId,
                clientId: clientId,
                idempotencyKey: idempotencyKey,
                text: text,
                now: now(),
                attachments: staging.map(\.localAttachment)
            )
        } catch {
            notice = "Could not queue that message on this device."
            return
        }

        draft.text = ""
        notice = nil
        // He has asked for something, and from here until she answers the screen owes him
        // an account of it. Armed before the send rather than after, because a send that
        // throws is exactly the case where the turn may never come back.
        isAwaitingReply = true
        armTurnWatch(from: now())
        await refresh()

        if !staging.isEmpty {
            guard await upload(staging, clientId: clientId, idempotencyKey: idempotencyKey) else {
                // The row stays on disk and stays parked. Nothing is lost and nothing is
                // sent half-formed; `retryQueued()` runs it again.
                return
            }
            await refresh()
        }

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

    /// Uploads every staged attachment, then releases the parked send.
    ///
    /// - Returns: whether the send may now go.
    private func upload(
        _ staging: [StagedAttachment],
        clientId: String,
        idempotencyKey: String
    ) async -> Bool {
        var uploaded: [Attachment] = []
        for staged in staging {
            do {
                let attachment = try await uploadAttachment(staged.request, makeIdempotencyKey())
                // The same bytes, now also reachable under the id the server minted, so
                // the confirmed message renders from cache instead of downloading the
                // picture that is already in memory.
                AttachmentLoader.prime(attachmentId: attachment.id, data: staged.data)
                uploaded.append(attachment)
            } catch {
                notice = "That picture has not uploaded yet. It will go when Syl is reachable."
                return false
            }
        }

        do {
            try store.attachUploaded(
                clientId: clientId,
                idempotencyKey: idempotencyKey,
                attachments: uploaded
            )
        } catch {
            notice = "Could not finish attaching that picture on this device."
            return false
        }
        return true
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
            // A presence state that survived a disconnection would be asserting
            // something about *now* that stopped being true the moment the socket died.
            // Replaying "thinking" from four minutes ago is not stale data, it is a lie.
            switch state {
            case .offline, .unauthenticated, .idle:
                timeline.clear()
                refreshPresence()
            default:
                break
            }
            return false

        case .message(let message):
            // Compared case-insensitively: the `Id` pattern permits either hex case,
            // and a bare `==` would drop a message into the wrong thread rather than
            // fail loudly.
            guard SylIDs.areEqual(message.conversationId, conversationId) else { return false }
            do {
                try store.upsert([message])
            } catch {
                // A message the device cannot write is one he will not see. Saying so
                // is the only honest option; swallowing it makes the app look fine.
                notice = "A message arrived that this device could not save."
                return false
            }
            // She answered. Whatever the turn was waiting on, it has arrived.
            if message.role == .assistant { closeTurn() }
            await refresh()
            return true

        case .deliveryConfirmation(let confirmation):
            guard SylIDs.areEqual(confirmation.conversationId, conversationId) else { return false }
            let reconciled = (try? store.reconcile(confirmation)) ?? false
            if reconciled { await refresh() }
            return reconciled

        case .presence(let frame):
            timeline.record(frame, at: now())
            refreshPresence()
            return false

        case .needsHTTPSync:
            // The gap is older than the server's replay buffer. Saying nothing here
            // would leave the client believing it is caught up when it is not.
            notice = "Catching up on what was missed."
            return false

        case .error(let error, let fatal):
            // Only a fatal error writes here. A transient one — "slow down" — must not
            // clear a standing notice like "this device needs to be paired again",
            // which is still true and still the more important thing to say.
            if fatal { notice = error.message }
            return false
        }
    }

    // MARK: - Presence

    /// Recompute what to render, and arm the next transition.
    private func refreshPresence() {
        let instant = now()
        presence = timeline.state(at: instant)
        intensity = timeline.intensity(at: instant)
        armDecay(from: instant)
        // Every presence frame is fresh evidence that the outstanding turn is alive, so
        // the watch is re-armed from it. This is what lets a ten-minute turn run without
        // being accused: the service re-announces `thinking` every 7.5 seconds.
        armTurnWatch(from: instant)
    }

    /// Arm a single timer for the next moment the rendered state changes.
    ///
    /// `PresenceTimeline` exposes `nextTransition()` precisely "so a view can schedule
    /// one timer instead of polling". There are two boundaries on the ladder — the TTL
    /// expiring into `idle`, and the further grace expiring into `absent` — so this
    /// takes whichever is next and re-arms itself when it fires.
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

    // MARK: - The turn he is waiting on

    /// Arm the watch for the moment nothing will be vouching for this turn any more.
    ///
    /// **Not a timeout, and the service is why.** A turn is allowed to take ten minutes
    /// (`DEFAULT_TURN_TIMEOUT_MS`), twenty if the agent retries from a clean session, so
    /// any stopwatch short enough to be useful would accuse turns that are working. But
    /// the service also reports continuously while it works: `thinking` carries a
    /// 15-second TTL and is re-announced every 7.5 seconds for as long as the turn runs.
    ///
    /// So the question is not "has it been long enough" but **"is anything still vouching
    /// for it"**, and `PresenceTimeline` already answers that: it decays to `absent` after
    /// the TTL and a further grace, and it is cleared outright when the socket drops. A
    /// working turn never reaches `absent`; a stranded one gets there on its own, with no
    /// clock of ours. That is what makes this structural rather than bolted on — the same
    /// instinct that put the expiry in the timeline rather than in the view.
    private func armTurnWatch(from instant: Date) {
        turnWatch?.cancel()
        guard isAwaitingReply else { return }

        // The moment presence stops being able to speak for the turn. When no frame has
        // ever arrived there is no ladder to read, and `turnSilence` is the floor.
        let deadline =
            timeline.nextTransition()?.addingTimeInterval(PresenceTimeline.idleGrace)
            ?? instant.addingTimeInterval(turnSilence)

        // **Capped, and it re-arms.** The wake-up is real time; what it concludes is read
        // from `now()`, which a test moves by hand and which a suspended app moves in
        // jumps. Sleeping straight to a computed deadline would mean a watch that slept
        // through the very interval it was meant to observe. Waking no less often than
        // `turnSilence` and re-checking costs one wake a minute while a turn is
        // outstanding, and nothing at all when none is.
        let delay = max(min(deadline.timeIntervalSince(instant), turnSilence), 0.05)

        turnWatch = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            await self?.turnWentQuiet()
        }
    }

    /// Nothing has vouched for the outstanding turn. Say so — and then actually go and
    /// look, because the reply usually exists.
    ///
    /// Constraint 4 is that the system does not get to silently discard things, and a
    /// notice that narrates a lost reply without trying to fetch it is still a lost
    /// reply. The socket is not the only way the answer can arrive: `flush` is
    /// `SyncEngine.synchronise()`, which pulls the change feed, and a reply the server
    /// appended while this device was wedged or disconnected comes back through it. So
    /// the recovery asks first and reports only what survives asking.
    private func turnWentQuiet() async {
        guard isAwaitingReply else { return }
        // A frame may have landed between the watch being armed and it firing.
        guard timeline.state(at: now()) == .absent else {
            armTurnWatch(from: now())
            return
        }

        isAwaitingReply = false
        turnWatch?.cancel()
        turnWatch = nil

        // Ask before concluding. This is the half that recovers rather than reports.
        await flush()
        await refresh()

        if snapshot.groups.last?.role == .assistant {
            // It was there all along and is now on screen. Nothing to report.
            return
        }

        notice = """
            Syl did not come back to that one. Your message is safe here — pull down or \
            tap Retry and it will go again.
            """
    }

    /// The turn is closed: she answered, or he asked something else.
    private func closeTurn() {
        isAwaitingReply = false
        turnWatch?.cancel()
        turnWatch = nil
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

    /// Whether a queued turn is going nowhere for now.
    ///
    /// Deliberately derived from what is actually known — the turn is pending and the
    /// socket is not up — rather than from a `failed` flag, because no such flag
    /// exists. Inventing one in the view layer would mean claiming a send failed when
    /// all that is known is that it has not happened yet. The intent is durable either
    /// way; the outbox will carry it when the tailnet returns.
    ///
    /// A real per-message failure state (a rejected message, a permanent error) is
    /// `syl-008.3.8` and needs the store, not the view.
    func isStalled(_ group: MessageGroup) -> Bool {
        guard group.isPending else { return false }
        switch connection {
        case .connected, .connecting, .authenticating, .reconnecting:
            return false
        case .idle, .offline, .unauthenticated:
            return true
        }
    }

    /// Run the outbox now, rather than waiting for the next scheduled sync.
    ///
    /// The retry affordance is not cosmetic: without it a queued message sits until
    /// something else happens to trigger a flush, and the Commander's only recourse is
    /// to guess whether it went.
    func retryQueued() async {
        notice = nil
        await flush()
        await refresh()
    }
}
