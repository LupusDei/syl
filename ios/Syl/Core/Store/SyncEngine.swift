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
        await pullChanges(into: &report)
        return report
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
        case .goal, .device, .delivery, .job, .run:
            // Not stored on the device. The admin surface reads these live and the
            // phone has no use for them; skipping is correct, not a gap.
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
