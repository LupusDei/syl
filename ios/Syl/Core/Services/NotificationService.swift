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
    /// acceptable here: the foreground reconcile through `GET /sync` picks up anything
    /// this missed.
    func acknowledge(_ payload: NotificationPayload, engagement: DeliveryEngagement) async {
        guard let deliveryId = payload.deliveryId else { return }
        let request = AcknowledgeDeliveryRequest(ackedAt: now(), engagement: engagement)
        _ = try? await backend.client().send(
            try SylAPI.acknowledgeDelivery(
                deliveryId,
                request,
                // Derived from the delivery, not random: the device retries this call
                // by design and a fresh key each time would defeat the point.
                idempotencyKey: "ack-\(deliveryId)"
            )
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
        _ = try? await backend.client().send(
            try SylAPI.snoozeReminder(
                reminderId,
                .minutes(ReminderNotification.snoozeMinutes),
                idempotencyKey: IdempotencyKey.generate()
            )
        )
    }

    func complete(_ payload: NotificationPayload) async {
        guard let reminderId = payload.reminderId else { return }
        _ = try? await backend.client().send(
            SylAPI.completeReminder(reminderId, idempotencyKey: IdempotencyKey.generate())
        )
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
