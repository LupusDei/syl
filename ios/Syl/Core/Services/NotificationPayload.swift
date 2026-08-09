import Foundation
import SylKit

/// What a Syl push carries in `userInfo`, and what the app is allowed to do with it.
///
/// **The alert body is self-sufficient by contract** — the reminder text is in the
/// notification, never an id to fetch. Push reaches the phone over Apple's network,
/// which does not touch the tailnet, so a notification that needed a fetch to be
/// readable would be blank exactly when the tunnel is down.
///
/// These ids are therefore for *acting*, not for *reading*: acknowledging the
/// delivery, and deferring or completing the reminder.
struct NotificationPayload: Equatable, Sendable {
    /// The outbox row. Acknowledging it is the only thing that marks a reminder
    /// delivered — APNs cannot tell us whether the notification arrived, and Apple
    /// retains only the most recent notification per app while a device is offline.
    let deliveryId: SylID?
    let reminderId: SylID?

    init(deliveryId: SylID?, reminderId: SylID?) {
        self.deliveryId = deliveryId
        self.reminderId = reminderId
    }

    /// Parses the `userInfo` dictionary iOS hands over.
    ///
    /// Tolerant on purpose: a notification whose payload the app cannot fully parse
    /// has still been *seen* by the Commander, and the worst possible response is to
    /// crash on the way to telling him so.
    init(userInfo: [AnyHashable: Any]) {
        func string(_ key: String) -> SylID? {
            guard let value = userInfo[key] as? String, !value.isEmpty else { return nil }
            return value
        }
        self.deliveryId = string("deliveryId")
        self.reminderId = string("reminderId")
    }

    var isEmpty: Bool { deliveryId == nil && reminderId == nil }
}

/// The notification category and its actions.
///
/// Taken from Adjutant, which already ships View / Snooze 15 min / Dismiss and is
/// roughly 80% of what Syl needs for free. **The UI is borrowed; the authority is
/// not.** Adjutant's snooze reschedules locally on the device, and a phone that is
/// wiped, restored or replaced would take those deferrals with it. Every action here
/// is a call to the server.
enum ReminderNotification {
    static let categoryIdentifier = "reminder"

    enum Action: String, CaseIterable {
        case view = "syl.reminder.view"
        case snooze = "syl.reminder.snooze"
        case complete = "syl.reminder.complete"

        var title: String {
            switch self {
            case .view: return "View"
            case .snooze: return "Snooze 15 min"
            case .complete: return "Done"
            }
        }

        /// How the engagement is reported to the interruption ledger. A message class
        /// that is consistently ignored gets demoted, so the difference between
        /// "opened" and "acted on" is what stops Syl talking into a void.
        var engagement: DeliveryEngagement {
            switch self {
            case .view: return .opened
            case .snooze, .complete: return .actedOn
            }
        }
    }

    /// Minutes a snooze defers by. The number lives here rather than being computed
    /// on the device, because the server is the one that applies it — and it must
    /// return a strictly later instant or refuse with `DEFERRAL_NOT_LATER`.
    static let snoozeMinutes = 15
}
