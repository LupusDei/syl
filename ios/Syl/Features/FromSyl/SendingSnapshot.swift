import Foundation
import SylKit

/// One sending, as a row.
///
/// A small value per row and nothing that spans the list. That is the shape `syl-008`
/// got wrong in a transcript and paid for with two watchdog terminations (plan R4), and
/// it matters more here than anywhere: a row carries an `Attachment`, and a row holding
/// the whole list's worth of them would hold the whole list's worth of posters.
struct SendingRowSnapshot: Identifiable, Equatable, Sendable {
    /// What she said. Already in his conversation and already the body of the push —
    /// this is the same sentence, kept.
    var words: String
    /// Why she made it. Hers, not a caption, and the thing that makes *"show me the one
    /// about Ela"* answerable. **A gallery of renders is a gallery with this missing**,
    /// which is the whole reason the spec rules one out by name.
    var because: String
    /// The date, written for a person: Today, Yesterday, or a day and a month.
    var dateLine: String
    /// Where the video got to.
    var standing: Standing
    /// The clip, when there is one. The row draws its **poster** — `?variant=thumb`,
    /// which the service guarantees exists on this one attachment and guarantees is not
    /// frame zero, because her loops open on empty starfield.
    var still: Attachment?

    var id: SylID

    /// Where the video got to, in the three shapes the screen has to draw.
    ///
    /// `rendering` and `failed` are **different states and must never look alike.**
    /// One means wait a minute; the other means there will never be a video for this
    /// one. Collapsing them would be the silence this project refuses, and neither may
    /// read as a bug — the words arrived, which is the half that was promised.
    enum Standing: Equatable, Sendable {
        case ready
        case rendering
        case failed
    }

    /// Whether there is anything to tap. False for both the states with no video, so a
    /// row never offers a play control over nothing at all.
    var isPlayable: Bool { still != nil }

    /// The one line under the words when there is no video, in her voice.
    ///
    /// Nil for a ready sending: a row that plays needs nothing explained.
    var note: String? {
        switch standing {
        case .ready: return nil
        case .rendering: return "I am still making the video for this one."
        case .failed: return "There is no video for this one. The words stand."
        }
    }

    /// What VoiceOver reads, in the order someone needs it: what she said, when, and
    /// then whether there is anything to play.
    var accessibilityLabel: String {
        var parts = [words, dateLine]
        if let note { parts.append(note) }
        if isPlayable { parts.append("Video") }
        return parts.joined(separator: ", ")
    }
}

/// The From Syl screen, prepared in one go.
struct SendingListSnapshot: Equatable, Sendable {
    var rows: [SendingRowSnapshot] = []

    var isEmpty: Bool { rows.isEmpty }

    /// What the screen says when she has sent him nothing. A statement about the world,
    /// not a report about the app — and the view model never shows it until a fetch has
    /// actually answered, because "nothing yet" and "I have not asked" are different
    /// things.
    static let emptyHeadline = "Nothing here yet."
    static let emptyExplanation =
        "When there is something I want you to see, this is where it will be."

    /// Project rows off the disk into rows on a screen.
    ///
    /// **Newest first, sorted here rather than assumed.** The service orders by
    /// `created_at DESC, id DESC` and the store orders again; this is the third place,
    /// and it is not redundant — the mock served this list in authoring order for a
    /// while and was schema-conformant the whole time, because ordering is not something
    /// a schema can express. A projection that inherited its order would have encoded
    /// that bug and looked green.
    static func project(
        _ sendings: [Sending],
        now: Date,
        calendar: Calendar = .current,
        timeZone: TimeZone = .current,
        locale: Locale = .current
    ) -> SendingListSnapshot {
        var days = calendar
        days.timeZone = timeZone
        days.locale = locale

        let ordered = sendings.sorted { left, right in
            left.createdAt == right.createdAt
                ? left.id.lowercased() > right.id.lowercased()
                : left.createdAt > right.createdAt
        }

        return SendingListSnapshot(
            rows: ordered.map { sending in
                SendingRowSnapshot(
                    words: sending.words,
                    because: sending.because,
                    dateLine: dateLine(for: sending.createdAt, now: now, in: days, locale: locale),
                    standing: standing(of: sending),
                    // **Only a ready sending has a still**, and a `video` present on any
                    // other state would be the service contradicting itself. Reading the
                    // state rather than the nullability means a row can never offer a
                    // poster for a clip that is not there.
                    still: sending.state == .ready ? sending.video : nil,
                    id: sending.id
                )
            }
        )
    }

    private static func standing(of sending: Sending) -> SendingRowSnapshot.Standing {
        switch sending.state {
        case .ready: return sending.video == nil ? .rendering : .ready
        case .pending: return .rendering
        case .failed: return .failed
        }
    }

    /// The date, in **his** zone.
    ///
    /// Stored instants are UTC and half past nine on a Chicago evening is the following
    /// day in UTC — so a row formatted in the machine's zone would tell him a keepsake
    /// arrived on a day it did not.
    ///
    /// Today and Yesterday by name because those are the two a person reads as a time
    /// rather than as a date. The year appears only when it is not this one; carrying it
    /// on every row would be noise on all of them.
    private static func dateLine(
        for instant: Date,
        now: Date,
        in calendar: Calendar,
        locale: Locale
    ) -> String {
        // Against the injected `now`, never `isDateInToday`, which reads the system
        // clock: a projection that consulted the wall clock would answer differently in
        // a test at midnight than at noon, and this screen's whole job is dates.
        if calendar.isDate(instant, inSameDayAs: now) { return "Today" }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now),
           calendar.isDate(instant, inSameDayAs: yesterday) {
            return "Yesterday"
        }

        let sameYear = calendar.component(.year, from: instant)
            == calendar.component(.year, from: now)
        let style = sameYear
            ? Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone)
                .day().month(.wide)
            : Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone)
                .day().month(.wide).year()
        return instant.formatted(style)
    }
}
