import Foundation
import SylKit

/// A run of consecutive messages from the same speaker.
///
/// Grouping is what makes a long thread readable: one avatar and one timestamp for a
/// burst of replies rather than eleven. It is also what makes the list cheap to
/// diff — SwiftUI re-renders a group, not every bubble in it.
struct MessageGroup: Identifiable, Equatable, Sendable {
    /// The first message's id, which is stable across a reconciliation only for
    /// server-originated groups. A pending group's id changes when the server
    /// confirms, which is correct: it is a different row.
    let id: SylID
    let role: MessageRole
    let messages: [Message]
    /// True when any message in the group is still waiting on the server.
    let isPending: Bool

    var startedAt: Date { messages.first?.createdAt ?? .distantPast }
    var endedAt: Date { messages.last?.createdAt ?? .distantPast }
    var text: String { messages.map(\.text).joined(separator: "\n\n") }
}

/// Pure grouping. No view coupling, no store, no clock.
///
/// Adjutant has the same logic buried inside a 955-line chat view, where it cannot be
/// tested and cannot be reused. Lifting it out is the cheapest correctness win in the
/// whole feature: every edge case here — an empty thread, a burst spanning a pause, a
/// pending message next to a confirmed one — is a unit test rather than a screenshot.
enum MessageGrouping {
    /// A pause long enough to be a new thought rather than a continuation.
    ///
    /// Five minutes, matching the interval at which a timestamp stops being obvious
    /// from context. Shorter and a normal back-and-forth fragments; longer and a
    /// reminder that fired an hour later joins the morning's conversation.
    static let maximumGap: TimeInterval = 300

    static func group(_ messages: [Message], pendingIds: Set<SylID> = []) -> [MessageGroup] {
        var groups: [MessageGroup] = []
        var current: [Message] = []

        func flush() {
            guard let first = current.first else { return }
            groups.append(
                MessageGroup(
                    id: first.id,
                    role: first.role,
                    messages: current,
                    isPending: current.contains { pendingIds.contains($0.id) }
                )
            )
            current = []
        }

        for message in messages {
            guard let previous = current.last else {
                current = [message]
                continue
            }

            let sameSpeaker = previous.role == message.role
            let closeEnough =
                message.createdAt.timeIntervalSince(previous.createdAt) <= maximumGap
            // A pending message never joins a confirmed group. It renders differently,
            // and merging them would make the whole group look unsent.
            let samePendingState =
                pendingIds.contains(previous.id) == pendingIds.contains(message.id)

            if sameSpeaker && closeEnough && samePendingState {
                current.append(message)
            } else {
                flush()
                current = [message]
            }
        }
        flush()

        return groups
    }
}
