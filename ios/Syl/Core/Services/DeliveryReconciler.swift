import Foundation
import SylKit

/// The foreground reconcile. **This is the floor under the delivery guarantee.**
///
/// Three places in this codebase used to justify closing a delivery the moment APNs
/// returned 200 by pointing at "the app's foreground reconcile" — `outbox.ts`, the
/// reminder-delivery integration test, and the `unacknowledged` filter on
/// `GET /deliveries` that exists for no other caller. None of them was wrong about
/// what was needed. All three were wrong that it existed: `SylAPI.deliveries(
/// unacknowledged:)` was declared in SylKit and called by nothing, so every layer
/// deferred the guarantee to a layer that did not implement it. See `syl-u9e`.
///
/// What makes the gap real rather than theoretical is Apple's own behaviour. APNs
/// exposes no delivery-status API, so `deliveredAt` never means more than "Apple
/// accepted the request" — and while a device is offline Apple retains only the most
/// recent notification per app. Four reminders pushed overnight are four accepted
/// requests and one notification. The server marks all four delivered; the phone shows
/// one; the other three are unacknowledged forever and nothing tries again.
///
/// So this asks the server what it is still waiting to hear about, and answers.
actor DeliveryReconciler {
    private let outbox: Outbox
    private let fetch: @Sendable (_ cursor: String?) async throws -> DeliveryPage
    private let presenter: DeliveryPresenter
    private let flush: (@Sendable () async -> Void)?
    private let now: @Sendable () -> Date
    /// A ceiling per run, for the same reason `SyncEngine` has one: a phone back from
    /// a week away should page rather than block the first frame after launch.
    private let maxPagesPerRun: Int

    init(
        outbox: Outbox,
        fetch: @escaping @Sendable (_ cursor: String?) async throws -> DeliveryPage,
        presenter: DeliveryPresenter,
        flush: (@Sendable () async -> Void)? = nil,
        now: @escaping @Sendable () -> Date = { Date() },
        maxPagesPerRun: Int = 10
    ) {
        self.outbox = outbox
        self.fetch = fetch
        self.presenter = presenter
        self.flush = flush
        self.now = now
        self.maxPagesPerRun = maxPagesPerRun
    }

    /// The idempotency key for acknowledging a delivery.
    ///
    /// Derived from the delivery and **identical** to the one `NotificationService`
    /// mints when he taps the notification himself. That is the whole point: if the
    /// push arrives late and he acts on it after the reconcile has already answered
    /// for it, both calls carry the same key and the server replays one answer instead
    /// of recording two.
    static func acknowledgementKey(for deliveryId: SylID) -> String {
        "ack-\(SylIDs.canonical(deliveryId))"
    }

    @discardableResult
    func reconcile() async -> DeliveryReconcileReport {
        var report = DeliveryReconcileReport()
        var cursor: String?
        var enqueuedAnything = false

        for _ in 0..<maxPagesPerRun {
            let page: DeliveryPage
            do {
                page = try await fetch(cursor)
            } catch {
                report.failures.append("fetch: \(Self.describe(error))")
                break
            }
            report.pagesPulled += 1

            let held = await presenter.alreadyOnDevice()
            for delivery in page.items {
                enqueuedAnything = await handle(delivery, held: held, into: &report)
                    || enqueuedAnything
            }

            report.hasMore = page.hasMore
            guard page.hasMore, let next = page.nextCursor else { break }
            cursor = next
        }

        // Push the acknowledgements this run wrote, rather than waiting for the next
        // sync. He is holding the phone; the server should stop believing these are
        // outstanding while he is still looking at them.
        if enqueuedAnything { await flush?() }
        return report
    }

    /// @returns whether an acknowledgement was enqueued.
    private func handle(
        _ delivery: Delivery,
        held: Set<SylID>,
        into report: inout DeliveryReconcileReport
    ) async -> Bool {
        // Already answered for. The server's filter should have excluded these, but a
        // reconcile that trusts the filter and nothing else would ack twice the day
        // the filter changes.
        guard delivery.ackedAt == nil else {
            report.alreadyAcknowledged += 1
            return false
        }

        // The server has not finished trying. Acknowledging a delivery still queued
        // for its first push would mark it seen before it was sent, which is exactly
        // the collapse of `deliveredAt` into `ackedAt` that the two fields exist to
        // prevent.
        guard Self.needsDeviceRecovery(delivery.state) else {
            report.stillInFlight += 1
            return false
        }

        let key = Self.acknowledgementKey(for: delivery.id)
        let alreadyQueued = (try? outbox.queued(idempotencyKey: key)) ?? nil
        if alreadyQueued != nil {
            // A previous run already surfaced this one and its acknowledgement has not
            // reached the server yet. The queued row is the memory that stops him
            // being shown the same reminder on every foreground.
            report.awaitingPush += 1
            return false
        }

        if held.contains(SylIDs.canonical(delivery.id)) {
            // The push did arrive: it is sitting in Notification Center unread, or
            // scheduled and not yet fired. The device has the content, which is
            // precisely what an acknowledgement asserts — so answer for it, and do not
            // show him a second copy of something he can already see.
            report.alreadyOnDevice += 1
        } else {
            do {
                try await presenter.present(delivery)
                report.presented += 1
            } catch {
                // Nothing was shown, so nothing is acknowledged. The row stays
                // unacknowledged on the server and the next foreground tries again —
                // a reminder that arrives late is a nuisance; one that is marked seen
                // without being seen is the failure this whole mechanism prevents.
                report.failures.append("\(delivery.id): \(Self.describe(error))")
                return false
            }
        }

        return enqueueAcknowledgement(for: delivery, key: key, into: &report)
    }

    private func enqueueAcknowledgement(
        for delivery: Delivery,
        key: String,
        into report: inout DeliveryReconcileReport
    ) -> Bool {
        do {
            let body = AcknowledgeDeliveryRequest(
                ackedAt: now(),
                // `.delivered`, never `.opened`. He has not opened anything — the
                // device has it. The interruption ledger demotes a message class that
                // is consistently ignored, and inflating engagement here would teach
                // it that a reminder he never saw was a reminder that worked.
                engagement: .delivered
            )
            try outbox.enqueue(
                OutboxRecord(
                    idempotencyKey: key,
                    kind: .acknowledgeDelivery,
                    targetId: delivery.id,
                    payload: try SylJSON.encoder().encode(body),
                    createdAt: now()
                )
            )
            report.acknowledged += 1
            return true
        } catch {
            report.failures.append("\(delivery.id): could not queue an ack: \(Self.describe(error))")
            return false
        }
    }

    /// Whether the server has stopped trying to reach the device about this row.
    ///
    /// `delivered` is the interesting one and the reason this type exists: APNs
    /// accepted it, the outbox cleared `nextAttemptAt`, and nothing on the server will
    /// ever look at that row again. `failed` and `abandoned` are rows push could not
    /// carry at all — the content still has to reach him, and the app is the only
    /// remaining route.
    static func needsDeviceRecovery(_ state: DeliveryState) -> Bool {
        switch state {
        case .delivered, .failed, .abandoned:
            return true
        case .pending, .sending, .acknowledged:
            return false
        }
    }

    private static func describe(_ error: Error) -> String {
        (error as? APIError)?.errorDescription ?? error.localizedDescription
    }
}

/// What one reconcile did. Reported rather than logged, for the same reason
/// `SyncReport` is: the app is required to be honest about what is stuck.
struct DeliveryReconcileReport: Equatable, Sendable {
    /// Deliveries surfaced as a local notification because push never showed them.
    var presented = 0
    /// Deliveries the system was already holding, so no second copy was shown.
    var alreadyOnDevice = 0
    /// Acknowledgements written to the outbox this run.
    var acknowledged = 0
    /// Rows the server is still trying to push. Not ours to answer for yet.
    var stillInFlight = 0
    /// Rows a previous run already surfaced, whose ack has not reached the server.
    var awaitingPush = 0
    /// Rows that came back already acknowledged. Should be none; counted, not trusted.
    var alreadyAcknowledged = 0
    var pagesPulled = 0
    /// The server had more than this run took. Not an error — the next run continues.
    var hasMore = false
    var failures: [String] = []
}

/// The notification surface the reconcile needs, as two closures.
///
/// Closures rather than a protocol so the state machine — which is the part with the
/// interesting mistakes in it — can be tested with no `UNUserNotificationCenter`, no
/// authorization prompt and no simulator.
struct DeliveryPresenter: Sendable {
    /// Delivery ids the system is already holding: shown in Notification Center, or
    /// scheduled and not yet fired. Canonical-cased.
    var alreadyOnDevice: @Sendable () async -> Set<SylID>
    /// Show one locally. Throwing means nothing was shown, which means nothing is
    /// acknowledged.
    var present: @Sendable (Delivery) async throws -> Void
}

extension DeliveryReconciler {
    /// The real thing: `GET /deliveries?unacknowledged=true`, paged.
    static func liveFetch(
        backend: SylBackend
    ) -> @Sendable (_ cursor: String?) async throws -> DeliveryPage {
        { cursor in
            try await backend.client().send(SylAPI.deliveries(cursor: cursor, unacknowledged: true))
        }
    }
}
