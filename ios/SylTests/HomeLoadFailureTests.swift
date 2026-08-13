import GRDB
import XCTest

@testable import Syl
@testable import SylKit

/// A day the app could not read must never be reported as a day with nothing in it.
///
/// `syl-019`. The Commander opened the app to "The day is clear — Nothing needs you"
/// while eight things were due, one of them overdue and pinned. Nothing was lost and
/// nothing was mis-sorted: the read THREW, `HomeViewModel.refresh` swallowed it with
/// `try?`, and the published snapshot kept its default value — which is an empty day.
/// `HomeView` renders an empty day as the reassuring sentence above.
///
/// So the screen had one way to say "I have nothing" and no way to say "I could not
/// look", and the two collapsed onto the comforting one. That is the failure this
/// project keeps re-encountering in new clothes and wrote down as
/// `docs/CONTEXT.md` §8: *you cannot check a claim with an instrument that can only
/// say yes.* Here it was worse than a bad instrument — it was her voice, telling him
/// he was free on the strength of a question that was never answered.
///
/// ## Why the failure is forced with a corrupt payload
///
/// `LocalStore` keeps the server's JSON and decodes it on read (`PayloadRecord.model()`),
/// so an undecodable row is exactly how this read throws in the field — and one bad row
/// takes the whole list with it, because `upcomingReminders` maps with `try`. Forcing it
/// this way tests the real mechanism rather than a stubbed error, and it documents the
/// blast radius: a single unreadable reminder is enough to blank his entire day.
@MainActor
final class HomeLoadFailureTests: XCTestCase {
    private var database: SylDatabase!
    private var store: LocalStore!

    override func setUp() async throws {
        try await super.setUp()
        database = try SylDatabase.inMemory()
        store = LocalStore(database: database)
    }

    override func tearDown() async throws {
        store = nil
        database = nil
        try await super.tearDown()
    }

    /// Writes a reminder row whose payload cannot become a `Reminder`.
    ///
    /// The columns are all valid — it is only the payload that is unreadable, which is
    /// what a schema drift or a partially-written sync actually looks like. A row that
    /// failed its column constraints would never have been inserted.
    private func insertUndecodableReminder(firingAt instant: Date) throws {
        // Written through the ordinary path FIRST, then only its payload is spoiled.
        // That is the real shape of the failure — a row that synced fine and later
        // stopped decoding — and it keeps the test honest about the columns, which are
        // all still perfectly valid. `upcomingReminders` filters on those columns and
        // then decodes, so this row is selected and then explodes.
        let reminder = Reminder(
            id: "syl:reminder:0198f2c1-0019-7d21-9f00-1a2b3c4d5e19",
            kind: .commitment, text: "Something he asked for", todoId: nil, eventId: nil,
            wallTime: "09:00", tz: "America/Chicago", rrule: nil,
            scheduledFor: instant, nextFireAt: instant,
            urgent: false, late: false, deferredFrom: nil, supersedesPrevious: false,
            deliveryState: .scheduled, createdAt: instant, updatedAt: instant,
            completedAt: nil
        )
        try store.upsert([reminder])

        try database.queue.write { db in
            try db.execute(
                sql: "UPDATE reminder SET payload = ? WHERE id = ?",
                arguments: [Data(#"{"but_this_is_not":"a reminder"}"#.utf8), reminder.id]
            )
        }
    }

    func testShouldReportThatItCouldNotReadTheDayWhenTheReadThrows() async throws {
        let noon = Date(timeIntervalSince1970: 1_786_000_000)
        try insertUndecodableReminder(firingAt: noon.addingTimeInterval(3_600))

        let model = HomeViewModel(store: store, clock: { noon })
        await model.refresh()

        // The whole bug in one assertion: the load failed, so the screen must know.
        XCTAssertNotNil(
            model.loadFailure,
            "the read threw and the screen was told nothing — this is syl-019 exactly"
        )
    }

    func testShouldCarryTheErrorItselfSoTheCauseCanBeNamed(
    ) async throws {
        let noon = Date(timeIntervalSince1970: 1_786_000_000)
        try insertUndecodableReminder(firingAt: noon.addingTimeInterval(3_600))

        let model = HomeViewModel(store: store, clock: { noon })
        await model.refresh()

        // Not a boolean and not a friendly stand-in sentence. When this fired in the
        // field the cause was unknown and unreachable from the outside — the device is
        // the only place the failing read happens, against his data, so the message has
        // to survive the trip or the next person is back to guessing from the shore.
        let failure = try XCTUnwrap(model.loadFailure)
        XCTAssertFalse(failure.isEmpty)
        XCTAssertNotEqual(
            failure, "The day would not load, and said nothing about why.",
            "a real error was available and was replaced with a placeholder"
        )
    }

    func testShouldSayNothingIsWrongWhenTheDayIsGenuinelyEmpty() async throws {
        // The other half, and the reason this cannot be fixed by always showing a
        // warning: an empty day is a real and common state, and it must still read as
        // the calm sentence. Only a FAILED read is disqualified from that claim.
        let noon = Date(timeIntervalSince1970: 1_786_000_000)

        let model = HomeViewModel(store: store, clock: { noon })
        await model.refresh()

        XCTAssertNil(model.loadFailure)
        XCTAssertTrue(model.snapshot.moments.isEmpty)
    }

    func testShouldKeepTheLastGoodDayRatherThanBlankingItOnAFailedRead() async throws {
        // A spine that empties itself when a refresh fails is the same lie in a slower
        // form: he would watch his day disappear a minute after opening the app, with
        // the failure notice attached to an emptiness the failure invented.
        let noon = Date(timeIntervalSince1970: 1_786_000_000)
        let model = HomeViewModel(store: store, clock: { noon })

        let todo = Todo(
            id: "syl:todo:0198f2c2-0019-7000-8000-00000000d019",
            text: "Verify the insurance", goalId: nil, dueAt: nil, pinned: true,
            status: .open, source: .commander, delegatedJobId: nil,
            createdAt: noon, updatedAt: noon, completedAt: nil
        )
        try store.upsert([todo])
        await model.refresh()

        let before = model.snapshot.moments
        XCTAssertFalse(before.isEmpty, "the pinned to-do should be on the spine")

        try insertUndecodableReminder(firingAt: noon.addingTimeInterval(3_600))
        await model.refresh()

        XCTAssertNotNil(model.loadFailure)
        XCTAssertEqual(
            model.snapshot.moments.count, before.count,
            "a failed refresh threw away a day it had already read correctly"
        )
    }
}
