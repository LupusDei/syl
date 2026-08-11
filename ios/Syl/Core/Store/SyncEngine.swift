import Foundation
import SylKit

/// What sending one queued intent produced.
enum PushResult: Sendable, Equatable {
    /// The server accepted it and there is nothing to reconcile.
    case done
    /// A message landed. The confirmation carries the `clientId` that matches the
    /// optimistic bubble and the `serverId` that replaces it.
    case confirmed(DeliveryConfirmation)
}

/// The network, as two closures.
///
/// A pair of closures rather than a protocol because the two calls have unrelated
/// generic shapes and a protocol would need an associated type per endpoint to say so.
/// This way the sync state machine — which is the part with the interesting bugs —
/// can be tested with no network, no `URLSession` and no server.
struct SyncGateway: Sendable {
    var push: @Sendable (OutboxRecord) async throws -> PushResult
    var pull: @Sendable (_ since: String?) async throws -> SyncResponse
    /// Every goal, straight from the list route rather than from the change feed.
    ///
    /// Needed because the change feed cannot deliver a goal it has already skipped past.
    /// See ``SyncEngine/backfillGoals(into:)``.
    var allGoals: @Sendable (_ cursor: String?) async throws -> GoalPage = { _ in
        GoalPage(items: [], nextCursor: nil, hasMore: false)
    }
}

/// What one synchronisation did. Reported rather than logged, because the app is
/// required to be honest about what is stuck.
struct SyncReport: Equatable, Sendable {
    var pushed = 0
    /// Intents dropped because they can never succeed. A validation failure fails
    /// identically forever and would otherwise block everything behind it.
    var abandoned = 0
    /// Intents left queued after a failure that might yet succeed.
    var deferred = 0
    /// Intents parked because the first attempt may have landed and the service does
    /// not deduplicate that kind. Neither retried nor dropped.
    var blocked = 0
    var changesApplied = 0
    var pagesPulled = 0
    /// The server had more to give than this run took. Not an error — a device back
    /// from a week away pages.
    var hasMore = false
    var failures: [String] = []
}

/// Push outbox, pull since cursor, reconcile, ack.
///
/// The order is not arbitrary. Pushing first means the pull sees his own writes and
/// returns them as authoritative rows, so the optimistic bubble is replaced by the
/// server's copy in the same pass. Pulling first would race: a change pulled before
/// the push lands describes a world without his last message in it.
actor SyncEngine {
    private let store: LocalStore
    private let outbox: Outbox
    private let gateway: SyncGateway
    /// A ceiling on pages per run. A device back from a week away should page, not
    /// block the app for a minute on launch — the next run picks up where this left
    /// off, because the cursor is written after every page.
    private let maxPagesPerRun: Int

    init(
        store: LocalStore,
        outbox: Outbox,
        gateway: SyncGateway,
        maxPagesPerRun: Int = 10
    ) {
        self.store = store
        self.outbox = outbox
        self.gateway = gateway
        self.maxPagesPerRun = maxPagesPerRun
    }

    @discardableResult
    func synchronise() async -> SyncReport {
        var report = SyncReport()
        await pushOutbox(into: &report)
        await backfillGoals(into: &report)
        await pullChanges(into: &report)

        // Optimistic markers live exactly as long as the intent behind them, and this is
        // where that becomes true. It runs **only after a page actually landed**: a push
        // that succeeded followed by a pull that did not means the server has his
        // captured to-do and this device has not been told about it yet, and settling
        // there would take the row off his screen before its replacement arrived. It
        // waits for the next run instead, which is what the outbox does with everything
        // else it cannot yet resolve.
        if report.pagesPulled > 0 {
            do {
                try store.settleOptimisticMarkers()
            } catch {
                report.failures.append("could not settle optimistic rows: \(error)")
            }
        }
        return report
    }

    // MARK: - The goals the cursor walked past

    /// Fetch every goal once, directly, because the change feed can no longer produce
    /// them.
    ///
    /// **`pullChanges` writes the cursor after every page whether or not anything in it
    /// was applied.** While `.goal` sat in the ignore list, each goal that came down a
    /// page was dropped *and the cursor moved past it* — and `GET /sync` only returns
    /// changes since the cursor. So a device upgraded into goal support believes it is
    /// perfectly up to date and is missing every goal that has not been touched since.
    ///
    /// The Commander hit it within an hour: three goals on the server, one on the phone,
    /// no error anywhere. Turning `.goal` on fixes every goal touched from now on and
    /// cannot recover one that is merely sitting there unchanged.
    ///
    /// Runs **once**, recorded in `syncState`. Not on every launch: this is a full list
    /// fetch, and doing it repeatedly would trade a one-off recovery for a permanent
    /// cost. A failure leaves the flag unset, so it simply tries again next time — the
    /// one thing it must not do is record success it did not have.
    private func backfillGoals(into report: inout SyncReport) async {
        guard (try? store.syncState())?.goalsBackfilledAt == nil else { return }

        var cursor: String?
        var recovered = 0

        for _ in 0..<maxPagesPerRun {
            let page: GoalPage
            do {
                page = try await gateway.allGoals(cursor)
            } catch {
                // Deliberately not fatal, and deliberately not recorded as done. The
                // rest of the sync is still worth running, and this will be retried.
                report.failures.append("goal backfill: \(error.localizedDescription)")
                return
            }

            do {
                try store.upsert(page.items)
                recovered += page.items.count
            } catch {
                report.failures.append("goal backfill could not write: \(error)")
                return
            }

            guard page.hasMore, let next = page.nextCursor else { break }
            cursor = next
        }

        report.changesApplied += recovered
        try? store.markGoalsBackfilled(at: Date())
    }

    // MARK: - Push

    private func pushOutbox(into report: inout SyncReport) async {
        let queued: [OutboxRecord]
        do {
            queued = try outbox.pending()
        } catch {
            report.failures.append("could not read the outbox: \(error)")
            return
        }

        for record in queued {
            do {
                let result = try await gateway.push(record)
                if case .confirmed(let confirmation) = result {
                    try store.reconcile(confirmation)
                }
                try outbox.complete(record)
                report.pushed += 1
            } catch let error as APIError {
                if Self.isPermanent(error) {
                    // It will fail identically forever, and leaving it at the head of
                    // the queue would block everything behind it.
                    try? outbox.abandon(record)
                    report.abandoned += 1
                    report.failures.append("\(record.kind.rawValue): \(error.localizedDescription)")
                } else if !record.kind.isSafeToReplayBlind, error.mayHaveReachedTheServer {
                    // The request may have landed and the service does not deduplicate
                    // this kind. Retrying a snooze in that state would defer the
                    // reminder by another fifteen minutes, which is exactly the quiet
                    // kind of wrong this project cares most about.
                    //
                    // So it is parked, not dropped. Nothing vanishes; it waits visibly.
                    //
                    // `syl-ux1` made every implemented write honour `Idempotency-Key`,
                    // so `isSafeToReplayBlind` is now true for every kind and this
                    // branch no longer fires. It stays as the honest response if that
                    // ever stops holding — a new write that forgets the ledger, or a
                    // retry arriving after the ledger's retention has dropped the key.
                    try? outbox.block(record, reason: error.localizedDescription)
                    report.blocked += 1
                    report.failures.append(
                        """
                        \(record.kind.rawValue) may already have taken effect and cannot be \
                        retried safely: \(error.localizedDescription)
                        """
                    )
                    return
                } else {
                    try? outbox.recordFailure(record, error: error.localizedDescription)
                    report.deferred += 1
                    report.failures.append("\(record.kind.rawValue): \(error.localizedDescription)")
                    // Stop at the first recoverable failure. The queue is ordered
                    // because he acted in that order, and pushing past a stuck row
                    // would deliver his actions out of sequence.
                    return
                }
            } catch {
                try? outbox.recordFailure(record, error: String(describing: error))
                report.deferred += 1
                report.failures.append("\(record.kind.rawValue): \(error)")
                return
            }
        }
    }

    /// Whether an error means "this intent can never succeed".
    ///
    /// Auth failures are deliberately **not** permanent here: the intent is fine, the
    /// token is not, and discarding the Commander's message because a token expired
    /// would be the worst possible response. It stays queued until he re-pairs.
    static func isPermanent(_ error: APIError) -> Bool {
        switch error.code {
        case .validationFailed, .idempotencyKeyReuse, .notFound, .rruleUnsupported,
             .unknownJobKind, .deferralNotLater, .forbidden:
            return true
        default:
            return false
        }
    }

    // MARK: - Pull

    private func pullChanges(into report: inout SyncReport) async {
        var cursor = (try? store.syncState())?.cursor

        for _ in 0..<maxPagesPerRun {
            let response: SyncResponse
            do {
                response = try await gateway.pull(cursor)
            } catch {
                report.failures.append("pull: \(error.localizedDescription)")
                return
            }

            report.pagesPulled += 1
            report.changesApplied += apply(response.changes, into: &report)

            cursor = response.cursor
            // Written after every page, so an interrupted run resumes rather than
            // restarting. A device back from a week away must not lose a page because
            // the app was backgrounded on the ninth.
            try? store.setCursor(response.cursor)

            report.hasMore = response.hasMore
            if !response.hasMore { return }
        }
    }

    private func apply(_ changes: [SyncChange], into report: inout SyncReport) -> Int {
        var applied = 0
        for change in changes {
            do {
                switch change.op {
                case .delete:
                    try store.delete(type: change.type, id: change.id)
                    applied += 1
                case .upsert:
                    applied += try upsert(change) ? 1 : 0
                }
            } catch {
                // One unreadable change must not abandon the page. The row it
                // describes stays stale, and the next cursor pass sees it again.
                report.failures.append("\(change.type.rawValue) \(change.id): \(error)")
            }
        }
        return applied
    }

    private func upsert(_ change: SyncChange) throws -> Bool {
        switch change.type {
        case .conversation:
            guard let value = try change.decodeResource(as: Conversation.self) else { return false }
            try store.upsert(value)
        case .message:
            guard let value = try change.decodeResource(as: Message.self) else { return false }
            try store.upsert([value])
        case .reminder:
            guard let value = try change.decodeResource(as: Reminder.self) else { return false }
            try store.upsert([value])
        case .todo:
            guard let value = try change.decodeResource(as: Todo.self) else { return false }
            try store.upsert([value])
        case .goal:
            guard let value = try change.decodeResource(as: Goal.self) else { return false }
            try store.upsert([value])
        case .sending:
            // **Applied here, and depended on nowhere.**
            //
            // From Syl reads `GET /sendings` directly and re-reads it on foreground, for
            // the reason `ConstellationSource` states at length: this engine writes its
            // cursor after every page whether or not anything in it was stored
            // (`syl-011.9`, open, P0), so a surface that learned about her sendings only
            // from this feed would inherit silent data loss. The surface therefore asks.
            //
            // But a change that has arrived is free, and dropping it would leave a row
            // stale until the next open for no reason. So it is stored when it comes,
            // and nothing anywhere assumes it did.
            guard let value = try change.decodeResource(as: Sending.self) else { return false }
            try store.replaceSendings(SendingPage(items: [value], nextCursor: nil, hasMore: false))
        case .device, .delivery, .job, .run:
            // Not stored on the device. The admin surface reads these live and the
            // phone has no use for them; skipping is correct, not a gap.
            //
            // **`.goal` was in this list until `syl-011.1.2`, and the comment above
            // covered it.** That was true when it was written — there was no goal
            // surface in the app for a stored goal to serve — and it stopped being true
            // the moment the epic decided he must be able to open a goal and know
            // whether it is moving, instantly, from disk, with the server unreachable. A
            // goal screen built on top of the old rule would have to hit the network to
            // show anything, which breaks local-first on its first frame. So goals are
            // stored now and upserted above; this list is the four resources that are
            // still somebody else's business, and it keeps the original reason.
            return false
        }
        return true
    }
}

// MARK: - The real gateway

extension SyncGateway {
    /// Turns a queued intent back into the call it stands for.
    ///
    /// The idempotency key comes from the row, never freshly generated — that is the
    /// whole reason it is stored. Every retry of the same intent carries the same key,
    /// so the server replays its stored response instead of doing the work twice.
    static func live(backend: SylBackend) -> SyncGateway {
        SyncGateway(
            push: { record in
                let client = backend.client()
                switch record.kind {
                case .sendMessage:
                    let body = try record.decodePayload(as: SendMessageRequest.self)
                    let confirmation = try await client.send(
                        try SylAPI.sendMessage(
                            conversationId: record.targetId ?? SylIDs.interactiveConversation,
                            body,
                            idempotencyKey: record.idempotencyKey
                        )
                    )
                    return .confirmed(confirmation)

                case .acknowledgeDelivery:
                    let body = try record.decodePayload(as: AcknowledgeDeliveryRequest.self)
                    _ = try await client.send(
                        try SylAPI.acknowledgeDelivery(
                            try Self.requireTarget(record),
                            body,
                            idempotencyKey: record.idempotencyKey
                        )
                    )
                    return .done

                case .snoozeReminder:
                    let body = try record.decodePayload(as: SnoozeReminderRequest.self)
                    _ = try await client.send(
                        try SylAPI.snoozeReminder(
                            try Self.requireTarget(record),
                            body,
                            idempotencyKey: record.idempotencyKey
                        )
                    )
                    return .done

                case .completeReminder:
                    _ = try await client.send(
                        SylAPI.completeReminder(
                            try Self.requireTarget(record),
                            idempotencyKey: record.idempotencyKey
                        )
                    )
                    return .done

                case .completeTodo:
                    _ = try await client.send(
                        SylAPI.completeTodo(
                            try Self.requireTarget(record),
                            idempotencyKey: record.idempotencyKey
                        )
                    )
                    return .done

                case .createTodo:
                    let body = try record.decodePayload(as: CreateTodoRequest.self)
                    _ = try await client.send(
                        try SylAPI.createTodo(body, idempotencyKey: record.idempotencyKey)
                    )
                    return .done

                case .createReminder:
                    let body = try record.decodePayload(as: CreateReminderRequest.self)
                    _ = try await client.send(
                        try SylAPI.createReminder(body, idempotencyKey: record.idempotencyKey)
                    )
                    return .done
                }
            },
            pull: { since in
                try await backend.client().send(SylAPI.sync(since: since))
            },
            allGoals: { cursor in
                try await backend.client().send(SylAPI.goals(cursor: cursor))
            }
        )
    }

    private static func requireTarget(_ record: OutboxRecord) throws -> SylID {
        guard let targetId = record.targetId else {
            throw OutboxError.missingPayload(kind: record.kind)
        }
        return targetId
    }
}
