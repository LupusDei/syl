import Foundation
import SylKit
import UserNotifications

/// Everything the app does with notifications: asking for permission, declaring the
/// reminder category, and turning a tap or an action into a call to the server.
///
/// **The delegate methods here are the completion-handler variants, deliberately.**
/// The `async` overloads crash on cold start with a main-thread assertion, even when
/// the delegate is marked `@MainActor` — and cold start from a notification is the
/// single most important path in this app, because it is what happens when a reminder
/// fires and he taps it. This one cost a real debugging cycle in Adjutant; do not
/// "modernise" it.
@MainActor
final class NotificationService: NSObject, ObservableObject {
    enum Authorization: Equatable, Sendable {
        case unknown
        case granted
        /// A state to design rather than an error to report: the app still works, it
        /// just cannot be the last mile of the delivery guarantee until he says yes.
        case denied
    }

    @Published private(set) var authorization: Authorization = .unknown

    private let center: UNUserNotificationCenter
    private let backend: SylBackend
    private let registrar: PushRegistrationService
    private let now: @Sendable () -> Date

    /// Where an action is written before anything is attempted over the network.
    ///
    /// Nil only when the database could not be opened. Wired in by `AppDelegate` as
    /// soon as the store exists — the delegate is constructed on the launch path,
    /// before the store, and a notification can arrive in between.
    private var outbox: Outbox?
    private var flush: (@Sendable () async -> Void)?

    init(
        backend: SylBackend,
        center: UNUserNotificationCenter = .current(),
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.backend = backend
        self.registrar = PushRegistrationService(backend: backend)
        self.center = center
        self.now = now
        super.init()
    }

    func attach(outbox: Outbox, flush: @escaping @Sendable () async -> Void) {
        self.outbox = outbox
        self.flush = flush
    }

    // MARK: - Setup

    /// Declares the reminder category. Must happen before the first notification
    /// arrives, or the actions simply do not appear and nothing says why.
    func registerCategories() {
        let actions = ReminderNotification.Action.allCases.map { action in
            UNNotificationAction(
                identifier: action.rawValue,
                title: action.title,
                // `.foreground` only for View. A snooze that had to launch the app to
                // take effect would be a snooze he could miss.
                options: action == .view ? [.foreground] : []
            )
        }

        center.setNotificationCategories([
            UNNotificationCategory(
                identifier: ReminderNotification.categoryIdentifier,
                actions: actions,
                intentIdentifiers: [],
                options: []
            )
        ])
    }

    /// Asks for permission and, if granted, registers for remote notifications.
    ///
    /// The completion-handler API again, and hopping back to the main actor before
    /// touching `UIApplication`.
    func requestAuthorization(then register: @escaping @MainActor () -> Void) {
        center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            Task { @MainActor in
                self.authorization = granted ? .granted : .denied
                if granted { register() }
            }
        }
    }

    func refreshAuthorization() {
        center.getNotificationSettings { settings in
            // Read the one value we need here rather than carrying `settings` across
            // the hop: `UNNotificationSettings` is not Sendable, and the enum is.
            let status = settings.authorizationStatus
            Task { @MainActor in
                switch status {
                case .authorized, .provisional, .ephemeral:
                    self.authorization = .granted
                case .denied:
                    self.authorization = .denied
                case .notDetermined:
                    self.authorization = .unknown
                @unknown default:
                    self.authorization = .unknown
                }
            }
        }
    }

    // MARK: - Acting on a notification

    /// Acknowledges the delivery. **This is the whole delivery guarantee.**
    ///
    /// `deliveredAt` only means APNs accepted the request; Apple exposes no way to
    /// ask whether the notification arrived, and while a device is offline it retains
    /// only the most recent notification per app — so a night of reminders collapses
    /// into one. Only this call, from the device, marks the row delivered.
    ///
    /// Retried by design and idempotent on the server, so failing quietly is
    /// acceptable here — but only because something else eventually answers for it.
    /// That something is `DeliveryReconciler`, which asks
    /// `GET /deliveries?unacknowledged=true` on every foreground. It is **not**
    /// `GET /sync`, which this comment used to claim: `/sync` carries resource
    /// changes, is not implemented by the service, and knows nothing about
    /// acknowledgements. See `syl-u9e` — three separate comments deferred the
    /// delivery guarantee to a backstop that did not exist.
    func acknowledge(_ payload: NotificationPayload, engagement: DeliveryEngagement) async {
        guard let deliveryId = payload.deliveryId else { return }
        await enqueue(
            kind: .acknowledgeDelivery,
            targetId: deliveryId,
            body: AcknowledgeDeliveryRequest(ackedAt: now(), engagement: engagement),
            // Derived from the delivery, not random: the device retries this call by
            // design and a fresh key each time would defeat the point. The reconcile
            // derives the identical key, so his tap and its answer are one operation.
            idempotencyKey: DeliveryReconciler.acknowledgementKey(for: deliveryId)
        )
    }

    /// Defers a reminder **on the server**.
    ///
    /// Adjutant reschedules locally, and a phone that is wiped, restored or replaced
    /// takes those deferrals with it. A deferral that vanishes is the one outcome this
    /// project forbids, so the authority is the service's: it must return a strictly
    /// later instant or refuse with `DEFERRAL_NOT_LATER`.
    func snooze(_ payload: NotificationPayload) async {
        guard let reminderId = payload.reminderId else { return }
        await enqueue(
            kind: .snoozeReminder,
            targetId: reminderId,
            body: SnoozeReminderRequest.minutes(ReminderNotification.snoozeMinutes),
            // Derived from the reminder and the delivery that prompted it, never
            // random. He tapped Snooze on *this* notification once; a fresh key on a
            // retry would ask the server to defer a second time, and a reminder half an
            // hour late is exactly the quiet wrongness this project cares about.
            idempotencyKey: Self.actionKey("snooze", reminderId, payload.deliveryId)
        )
    }

    func complete(_ payload: NotificationPayload) async {
        guard let reminderId = payload.reminderId else { return }
        await enqueue(
            kind: .completeReminder,
            targetId: reminderId,
            body: Optional<SnoozeReminderRequest>.none,
            idempotencyKey: Self.actionKey("complete", reminderId, payload.deliveryId)
        )
    }

    static func actionKey(_ action: String, _ reminderId: SylID, _ deliveryId: SylID?) -> String {
        "\(action)-\(SylIDs.canonical(reminderId))-\(deliveryId.map(SylIDs.canonical) ?? "direct")"
    }

    /// Writes the intent to disk, then tries to push it.
    ///
    /// **Disk first, always.** Adjutant calls the network directly from its
    /// notification actions and swallows the failure, so a snooze tapped while the
    /// tailnet is down simply vanishes — which is the one outcome this project forbids.
    /// The outbox is retried by the sync engine and its idempotency key is derived, so
    /// the deferral survives a dead tunnel, a rebooting Mac and a killed app.
    private func enqueue(
        kind: OutboxRecord.Kind,
        targetId: SylID,
        body: (some Encodable)?,
        idempotencyKey: String
    ) async {
        guard let outbox else {
            // No database. Better to try the network than to do nothing, though this
            // is the path that can lose an action — which is why the store is opened
            // on launch before anything else.
            await sendDirectly(kind: kind, targetId: targetId, body: body, key: idempotencyKey)
            return
        }

        do {
            try outbox.enqueue(
                OutboxRecord(
                    idempotencyKey: idempotencyKey,
                    kind: kind,
                    targetId: targetId,
                    payload: try body.map { try SylJSON.encoder().encode($0) },
                    createdAt: now()
                )
            )
        } catch {
            await sendDirectly(kind: kind, targetId: targetId, body: body, key: idempotencyKey)
            return
        }

        // Push it now rather than waiting for the next scheduled sync: he is holding
        // the phone and expects the snooze to have happened.
        await flush?()
    }

    private func sendDirectly(
        kind: OutboxRecord.Kind,
        targetId: SylID,
        body: (some Encodable)?,
        key: String
    ) async {
        let client = backend.client()
        switch kind {
        case .acknowledgeDelivery:
            guard let request = body as? AcknowledgeDeliveryRequest else { return }
            _ = try? await client.send(
                try SylAPI.acknowledgeDelivery(targetId, request, idempotencyKey: key))
        case .snoozeReminder:
            guard let request = body as? SnoozeReminderRequest else { return }
            _ = try? await client.send(
                try SylAPI.snoozeReminder(targetId, request, idempotencyKey: key))
        case .completeReminder:
            _ = try? await client.send(
                SylAPI.completeReminder(targetId, idempotencyKey: key))
        case .sendMessage, .completeTodo, .createTodo, .createReminder:
            return
        }
    }

    // MARK: - Recovering a delivery push never showed

    /// The presenter half of `DeliveryReconciler`, bound to this service.
    var deliveryPresenter: DeliveryPresenter {
        DeliveryPresenter(
            alreadyOnDevice: { [self] in await heldDeliveryIds() },
            present: { [self] delivery in try await present(delivery) }
        )
    }

    /// Delivery ids the system is already holding.
    ///
    /// Matched on `userInfo`, never on the request identifier: a push carries the
    /// identifier APNs assigned it, so the only thing that ties a banner sitting in
    /// Notification Center back to an outbox row is the `deliveryId` the payload
    /// carries. Both lists matter — one that has fired and one that has not are both
    /// content the device already has.
    func heldDeliveryIds() async -> Set<SylID> {
        let center = self.center

        // The ids are extracted inside each completion handler so that no
        // `UNNotification` or `UNNotificationRequest` — neither of which is
        // `Sendable` — crosses the continuation. Same reasoning as
        // `refreshAuthorization` above.
        let delivered: [SylID] = await withCheckedContinuation { continuation in
            center.getDeliveredNotifications { notifications in
                continuation.resume(returning: Self.deliveryIds(in: notifications.map(\.request)))
            }
        }
        let pending: [SylID] = await withCheckedContinuation { continuation in
            center.getPendingNotificationRequests { requests in
                continuation.resume(returning: Self.deliveryIds(in: requests))
            }
        }

        return Set(delivered + pending)
    }

    /// Pure, so the mapping is testable without a notification centre.
    nonisolated static func deliveryIds(in requests: [UNNotificationRequest]) -> [SylID] {
        requests
            .compactMap { NotificationPayload(userInfo: $0.content.userInfo).deliveryId }
            .map(SylIDs.canonical)
    }

    /// Show a delivery locally, because push did not.
    ///
    /// The payload is reproduced faithfully — same title, same body, same category, so
    /// Snooze and Done are still there. A recovered reminder he cannot act on is half
    /// a recovery, and the actions write to the outbox exactly as they would have.
    ///
    /// Throwing matters: the caller acknowledges only on success, so a notification
    /// that could not be shown stays unacknowledged on the server and is tried again.
    func present(_ delivery: Delivery) async throws {
        let content = UNMutableNotificationContent()
        content.title = delivery.payload.title
        content.body = delivery.payload.body
        content.sound = .default
        content.categoryIdentifier =
            delivery.payload.categoryIdentifier ?? ReminderNotification.categoryIdentifier
        if let thread = delivery.payload.threadIdentifier {
            content.threadIdentifier = thread
        }
        content.interruptionLevel = Self.level(of: delivery.payload.interruptionLevel)
        content.userInfo = Self.userInfo(for: delivery)

        let request = UNNotificationRequest(
            // Prefixed and derived, so a second recovery of the same row replaces the
            // first rather than stacking a duplicate in Notification Center.
            identifier: "syl.recovered.\(SylIDs.canonical(delivery.id))",
            content: content,
            // No trigger: it has already waited long enough.
            trigger: nil
        )

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            center.add(request) { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume(returning: ())
                }
            }
        }
    }

    /// What a recovered notification carries, so its actions behave like any other.
    nonisolated static func userInfo(for delivery: Delivery) -> [String: String] {
        var info = ["deliveryId": delivery.id]
        if let reminderId = delivery.reminderId {
            info["reminderId"] = reminderId
        }
        return info
    }

    nonisolated static func level(of level: InterruptionLevel) -> UNNotificationInterruptionLevel {
        switch level {
        case .passive: return .passive
        case .active: return .active
        case .timeSensitive: return .timeSensitive
        }
    }

    /// Maps an action identifier onto the work it implies. Pure and separate from the
    /// delegate so it can be tested without a notification.
    static func work(for actionIdentifier: String) -> (
        action: ReminderNotification.Action?, engagement: DeliveryEngagement
    ) {
        if let action = ReminderNotification.Action(rawValue: actionIdentifier) {
            return (action, action.engagement)
        }
        switch actionIdentifier {
        case UNNotificationDefaultActionIdentifier:
            return (nil, .opened)
        case UNNotificationDismissActionIdentifier:
            return (nil, .dismissed)
        default:
            return (nil, .delivered)
        }
    }

    func handle(actionIdentifier: String, payload: NotificationPayload) async {
        let work = Self.work(for: actionIdentifier)
        switch work.action {
        case .snooze:
            await snooze(payload)
        case .complete:
            await complete(payload)
        case .view, nil:
            break
        }
        await acknowledge(payload, engagement: work.engagement)
    }
}

// MARK: - UNUserNotificationCenterDelegate

extension NotificationService: UNUserNotificationCenterDelegate {
    /// A reminder that arrives while he is already looking at the app still counts as
    /// delivered, so it is acknowledged here too — and still shown, because
    /// suppressing it would mean a time-sensitive reminder silently did nothing.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        let payload = NotificationPayload(userInfo: notification.request.content.userInfo)
        Task { @MainActor in
            await self.acknowledge(payload, engagement: .delivered)
        }
        completionHandler([.banner, .sound, .list])
    }

    /// The cold-start path. `completionHandler` must be called, and the async variant
    /// of this method traps on the main-thread assertion before it ever gets there.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let payload = NotificationPayload(userInfo: response.notification.request.content.userInfo)
        let identifier = response.actionIdentifier
        // UserNotifications declares the handler without `@Sendable`, so it cannot
        // cross into a Task on its own. Boxing it is the honest fix: calling it early
        // to satisfy the checker would tell the system we are finished while the
        // snooze is still in flight, and the system may suspend the app on that word.
        let finish = UncheckedSendableBox(completionHandler)

        Task { @MainActor in
            await self.handle(actionIdentifier: identifier, payload: payload)
            finish.value()
        }
    }
}

/// Carries a value the compiler cannot prove `Sendable` across an isolation hop.
///
/// Used only for framework callbacks that are documented to be called once, on the
/// main thread — never for anything this codebase owns, where the right answer is to
/// make the type properly `Sendable`.
private struct UncheckedSendableBox<Value>: @unchecked Sendable {
    let value: Value

    init(_ value: Value) {
        self.value = value
    }
}
