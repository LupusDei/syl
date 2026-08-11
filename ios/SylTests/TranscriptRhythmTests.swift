import XCTest

@testable import Syl
@testable import SylKit

/// How the transcript reads down the page.
///
/// The calendar is pinned in every test. A day-boundary test that reads the device
/// calendar is a test that passes in Chicago and fails in Auckland, and the whole point
/// of this type is getting midnight right.
final class TranscriptRhythmTests: XCTestCase {
    private var calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/Chicago")!
        return calendar
    }()

    // MARK: - Day dividers

    func testShouldOpenTheTranscriptWithADayDivider() {
        // The top of the transcript is where the date is needed most: nothing above it
        // establishes one.
        let rows = TranscriptRhythm.rows(
            for: [group(at: "2026-08-09T14:00:00Z", role: .assistant)],
            calendar: calendar
        )

        guard case .day = rows.first else {
            return XCTFail("expected a day divider first, got \(String(describing: rows.first))")
        }
        XCTAssertEqual(rows.count, 2)
    }

    func testShouldPrintOneDividerForSeveralTurnsOnTheSameDay() {
        let rows = TranscriptRhythm.rows(
            for: [
                group(at: "2026-08-09T14:00:00Z", role: .user),
                group(at: "2026-08-09T14:01:00Z", role: .assistant),
                group(at: "2026-08-09T22:00:00Z", role: .assistant),
            ],
            calendar: calendar
        )

        XCTAssertEqual(rows.filter(\.isDay).count, 1)
        XCTAssertEqual(rows.filter { !$0.isDay }.count, 3)
    }

    func testShouldBreakTheDayAtLocalMidnightRatherThanUTC() {
        // 04:00 UTC is still the previous evening in Chicago. Splitting on UTC would put
        // a divider in the middle of an evening conversation — the exact reason the
        // project stores IANA zones rather than offsets.
        let rows = TranscriptRhythm.rows(
            for: [
                group(at: "2026-08-09T23:00:00Z", role: .user),
                group(at: "2026-08-10T04:00:00Z", role: .assistant),
            ],
            calendar: calendar
        )

        XCTAssertEqual(rows.filter(\.isDay).count, 1, "both turns are 9 August in Chicago")
    }

    func testShouldStartANewDividerWhenTheLocalDayChanges() {
        let rows = TranscriptRhythm.rows(
            for: [
                group(at: "2026-08-09T14:00:00Z", role: .user),
                group(at: "2026-08-10T14:00:00Z", role: .assistant),
            ],
            calendar: calendar
        )

        XCTAssertEqual(rows.filter(\.isDay).count, 2)
    }

    func testShouldRenderNothingForAnEmptyConversation() {
        XCTAssertTrue(TranscriptRhythm.rows(for: [], calendar: calendar).isEmpty)
    }

    // MARK: - When a time is worth printing

    func testShouldAlwaysPrintATimeOnTheFirstTurn() {
        let rows = TranscriptRhythm.rows(
            for: [group(at: "2026-08-09T14:00:00Z", role: .assistant)],
            calendar: calendar
        )

        XCTAssertEqual(rows.compactMap(\.showsTime), [true])
    }

    func testShouldSuppressTheTimeOnAnImmediateReply() {
        // She answers twenty seconds after he asks. Printing 9:14 twice is noise — it is
        // the same moment.
        let rows = TranscriptRhythm.rows(
            for: [
                group(at: "2026-08-09T14:00:00Z", role: .user),
                group(at: "2026-08-09T14:00:20Z", role: .assistant),
            ],
            calendar: calendar
        )

        XCTAssertEqual(rows.compactMap(\.showsTime), [true, false])
    }

    func testShouldPrintTheTimeOnceTheConversationHasPaused() {
        let rows = TranscriptRhythm.rows(
            for: [
                group(at: "2026-08-09T14:00:00Z", role: .user),
                group(at: "2026-08-09T14:06:00Z", role: .assistant),
            ],
            calendar: calendar
        )

        XCTAssertEqual(rows.compactMap(\.showsTime), [true, true])
    }

    func testShouldUseTheSameThresholdAsGrouping() {
        // Two numbers meaning "long enough to be a new thought" drift apart the first
        // time one is tuned, and then the transcript groups on one rule and timestamps
        // on another. This test fails if someone introduces a second constant.
        let justInside = TranscriptRhythm.rows(
            for: [
                group(at: "2026-08-09T14:00:00Z", role: .user),
                group(
                    at: Instant.format(
                        instant("2026-08-09T14:00:00Z")
                            .addingTimeInterval(MessageGrouping.maximumGap)
                    ),
                    role: .assistant
                ),
            ],
            calendar: calendar
        )

        XCTAssertEqual(justInside.compactMap(\.showsTime), [true, false])
    }

    // MARK: - The label on the rule

    func testShouldNameTodayAndYesterdayRatherThanDatingThem() {
        let now = instant("2026-08-10T14:00:00Z")

        XCTAssertEqual(
            TranscriptRhythm.dayLabel(
                for: calendar.startOfDay(for: now), now: now, calendar: calendar
            ),
            "Today"
        )
        XCTAssertEqual(
            TranscriptRhythm.dayLabel(
                for: calendar.startOfDay(for: instant("2026-08-09T14:00:00Z")),
                now: now,
                calendar: calendar
            ),
            "Yesterday"
        )
    }

    func testShouldGiveADateRatherThanACountOfDaysAgo() {
        // "3 days ago" forces arithmetic to answer a question the date answers directly.
        let now = instant("2026-08-10T14:00:00Z")
        let label = TranscriptRhythm.dayLabel(
            for: calendar.startOfDay(for: instant("2026-08-05T14:00:00Z")),
            now: now,
            calendar: calendar
        )

        XCTAssertFalse(label.contains("ago"))
        XCTAssertTrue(label.contains("August"), "got \(label)")
    }

    func testShouldIncludeTheYearOnlyWhenItDiffers() {
        let now = instant("2026-08-10T14:00:00Z")

        let sameYear = TranscriptRhythm.dayLabel(
            for: calendar.startOfDay(for: instant("2026-02-05T14:00:00Z")),
            now: now,
            calendar: calendar
        )
        let otherYear = TranscriptRhythm.dayLabel(
            for: calendar.startOfDay(for: instant("2025-02-05T14:00:00Z")),
            now: now,
            calendar: calendar
        )

        XCTAssertFalse(sameYear.contains("2026"), "got \(sameYear)")
        XCTAssertTrue(otherYear.contains("2025"), "got \(otherYear)")
    }

    // MARK: - Harness

    private func instant(_ iso: String) -> Date {
        try! Instant.parse(iso)
    }

    /// Ids must be distinct but their values are irrelevant here. A counter rather than
    /// a hash of the timestamp, because `String.hashValue` is seeded per process and a
    /// test that depends on it is a test that fails on some runs and not others.
    private var nextId = 0

    private func group(at iso: String, role: MessageRole) -> MessageGroup {
        nextId += 1
        let message = Message(
            id: "syl:message:0198f2c0-0001-7000-8000-\(String(format: "%012d", nextId))",
            conversationId: SylIDs.interactiveConversation,
            clientId: nil,
            role: role,
            text: "Something.",
            createdAt: instant(iso),
            seq: nextId
        )
        return MessageGroup(id: message.id, role: role, messages: [message], isPending: false)
    }
}

private extension TranscriptRow {
    var isDay: Bool {
        if case .day = self { return true }
        return false
    }

    /// Nil for a day rule, so `compactMap` yields one entry per turn.
    var showsTime: Bool? {
        if case .turn(_, let showsTime) = self { return showsTime }
        return nil
    }
}
