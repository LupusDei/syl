import XCTest
import SylKit

@testable import Syl

/// The home screen's logic, tested away from the `Canvas`.
///
/// Everything that could be wrong in an interesting way lives in `HomeSnapshot` and
/// `RibbonAppearance` precisely so it can be tested here. What is left in the renderer
/// is arithmetic on the results.
final class HomeTests: XCTestCase {
    // MARK: - Fixtures

    private let calendar: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "America/Chicago") ?? .gmt
        return c
    }()

    /// 2026-08-10 09:00 Central. A fixed instant, never `Date()` — a test that reads
    /// the clock is a test that fails at midnight.
    private var now: Date {
        DateComponents(
            calendar: calendar,
            timeZone: calendar.timeZone,
            year: 2026, month: 8, day: 10, hour: 9
        ).date!
    }

    private func at(_ hour: Int, _ minute: Int = 0) -> Date {
        DateComponents(
            calendar: calendar,
            timeZone: calendar.timeZone,
            year: 2026, month: 8, day: 10, hour: hour, minute: minute
        ).date!
    }

    private func reminder(
        id: String,
        text: String = "A reminder",
        fireAt: Date,
        urgent: Bool = false,
        late: Bool = false,
        state: ReminderDeliveryState = .scheduled,
        completedAt: Date? = nil
    ) -> Reminder {
        Reminder(
            id: id, kind: .commitment, text: text, todoId: nil, eventId: nil,
            wallTime: "09:00", tz: "America/Chicago", rrule: nil,
            scheduledFor: fireAt, nextFireAt: fireAt,
            urgent: urgent, late: late, deferredFrom: nil, supersedesPrevious: false,
            deliveryState: state, createdAt: fireAt, updatedAt: fireAt, completedAt: completedAt
        )
    }

    private func todo(
        id: String,
        text: String = "A to-do",
        dueAt: Date? = nil,
        pinned: Bool = false,
        status: TodoStatus = .open
    ) -> Todo {
        Todo(
            id: id, text: text, goalId: nil, dueAt: dueAt, pinned: pinned,
            status: status, source: .commander, delegatedJobId: nil,
            createdAt: now, updatedAt: now, completedAt: nil
        )
    }

    // MARK: - Prominence

    func testShouldGiveSylTheWholeScreenWhenNothingIsLeft() {
        XCTAssertEqual(HomeSnapshot.prominence(remaining: 0), 1.0, accuracy: 0.0001)
    }

    func testShouldShrinkSylAsTheDayFillsUp() {
        let one = HomeSnapshot.prominence(remaining: 1)
        let three = HomeSnapshot.prominence(remaining: 3)
        let ten = HomeSnapshot.prominence(remaining: 10)

        XCTAssertLessThan(one, 1.0)
        XCTAssertLessThan(three, one)
        XCTAssertLessThan(ten, three)
    }

    /// The decay is asymptotic and never arrives, so four items and forty stay
    /// distinguishable. Same shape as the edge-confidence rule in constraint 6.
    func testShouldNeverShrinkSylToNothingHoweverBusyTheDayIs() {
        let busy = HomeSnapshot.prominence(remaining: 500)

        XCTAssertGreaterThan(busy, 0.35)
        XCTAssertLessThan(busy, HomeSnapshot.prominence(remaining: 20))
    }

    // MARK: - Greeting

    func testShouldGreetByTheCommandersWallClockNotUTC() {
        XCTAssertEqual(HomeSnapshot.greeting(at: at(7), calendar: calendar), "Good morning")
        XCTAssertEqual(HomeSnapshot.greeting(at: at(14), calendar: calendar), "Good afternoon")
        XCTAssertEqual(HomeSnapshot.greeting(at: at(19), calendar: calendar), "Good evening")
        XCTAssertEqual(HomeSnapshot.greeting(at: at(2), calendar: calendar), "Still awake")
    }

    // MARK: - Building the spine

    func testShouldOrderTheDayByTimeWithUndatedItemsLast() {
        let snapshot = HomeSnapshot.build(
            reminders: [reminder(id: "r1", text: "Later", fireAt: at(15))],
            todos: [
                todo(id: "t1", text: "Floating", pinned: true),
                todo(id: "t2", text: "Earlier", dueAt: at(11)),
            ],
            now: now,
            calendar: calendar
        )

        XCTAssertEqual(snapshot.moments.map(\.title), ["Earlier", "Later", "Floating"])
    }

    func testShouldMarkAPassedReminderAsDueRatherThanDroppingIt() {
        let snapshot = HomeSnapshot.build(
            reminders: [reminder(id: "r1", fireAt: at(7), late: true)],
            todos: [],
            now: now,
            calendar: calendar
        )

        XCTAssertEqual(snapshot.moments.count, 1)
        XCTAssertEqual(snapshot.moments.first?.standing, .due)
        XCTAssertEqual(snapshot.remaining, 1)
    }

    func testShouldNotCountFinishedWorkAgainstTheDay() {
        let snapshot = HomeSnapshot.build(
            reminders: [
                reminder(id: "r1", fireAt: at(7), state: .completed, completedAt: at(7)),
                reminder(id: "r2", fireAt: at(15)),
            ],
            todos: [],
            now: now,
            calendar: calendar
        )

        XCTAssertEqual(snapshot.moments.count, 2)
        XCTAssertEqual(snapshot.remaining, 1)
        XCTAssertEqual(snapshot.moments.first?.standing, .done)
    }

    /// Proposal B's capture rule: a to-do with only text must appear in the right
    /// places. It has no time, so it cannot be placed on the timeline — but it must
    /// still be on the screen.
    func testShouldShowAPinnedTodoThatHasNoTimeAtAll() {
        let snapshot = HomeSnapshot.build(
            reminders: [],
            todos: [todo(id: "t1", text: "Text only", pinned: true)],
            now: now,
            calendar: calendar
        )

        XCTAssertEqual(snapshot.moments.map(\.title), ["Text only"])
        XCTAssertNil(snapshot.moments.first?.at)
    }

    /// The spine is today, not the backlog. An unpinned to-do due next week belongs to
    /// the list; putting it here would push today's next commitment below the fold.
    func testShouldKeepTomorrowsBacklogOffTodaysSpine() {
        let nextWeek = calendar.date(byAdding: .day, value: 7, to: now)!

        let snapshot = HomeSnapshot.build(
            reminders: [],
            todos: [todo(id: "t1", text: "Later this month", dueAt: nextWeek)],
            now: now,
            calendar: calendar
        )

        XCTAssertTrue(snapshot.moments.isEmpty)
        XCTAssertTrue(snapshot.isClear)
    }

    func testShouldIgnoreTodosThatAreAlreadyDoneOrDropped() {
        let snapshot = HomeSnapshot.build(
            reminders: [],
            todos: [
                todo(id: "t1", dueAt: at(10), status: .done),
                todo(id: "t2", dueAt: at(11), status: .dropped),
            ],
            now: now,
            calendar: calendar
        )

        XCTAssertTrue(snapshot.moments.isEmpty)
    }

    // MARK: - The note

    func testShouldSayNothingWhenThereIsNothingWorthSaying() {
        let snapshot = HomeSnapshot.build(
            reminders: [reminder(id: "r1", fireAt: at(15))],
            todos: [],
            now: now,
            calendar: calendar
        )

        XCTAssertNil(snapshot.note, "an invented affirmation is Syl saying something she did not say")
    }

    func testShouldOwnUpToBeingLateBeforeAnythingElse() {
        let snapshot = HomeSnapshot.build(
            reminders: [
                reminder(id: "r1", text: "Urgent thing", fireAt: at(8), urgent: true),
                reminder(id: "r2", text: "Late thing", fireAt: at(7), late: true),
            ],
            todos: [],
            now: now,
            calendar: calendar
        )

        XCTAssertEqual(snapshot.note?.tone, .late)
        XCTAssertTrue(snapshot.note?.text.contains("Late thing") == true)
    }

    /// At most one card, ever. Two cards is a feed, and a feed is how a helpful thing
    /// becomes noise.
    func testShouldRaiseAtMostOneNoteHoweverBadTheDayIs() {
        let snapshot = HomeSnapshot.build(
            reminders: [
                reminder(id: "r1", text: "One", fireAt: at(6), late: true),
                reminder(id: "r2", text: "Two", fireAt: at(7), late: true),
                reminder(id: "r3", text: "Three", fireAt: at(8), urgent: true),
            ],
            todos: [],
            now: now,
            calendar: calendar
        )

        XCTAssertNotNil(snapshot.note)
        XCTAssertTrue(snapshot.note?.text.contains("One") == true)
    }

    // MARK: - The ribbon's appearance

    func testShouldRenderNothingAtAllWhenSheIsAbsent() {
        let absent = RibbonAppearance.forState(.absent)

        XCTAssertEqual(absent.brightness, 0)
        XCTAssertEqual(absent.amplitude, 0)
        XCTAssertEqual(absent.sparks, 0)
    }

    func testShouldStopMeanderingWhenAlert() {
        let alert = RibbonAppearance.forState(.alert)
        let idle = RibbonAppearance.forState(.idle)

        XCTAssertGreaterThan(alert.straightness, 0.8)
        XCTAssertGreaterThan(alert.brightness, idle.brightness)
        XCTAssertGreaterThan(alert.warmth, 0.5, "alert is the one warm state")
    }

    func testShouldDroopAndDimWhenConcerned() {
        let concerned = RibbonAppearance.forState(.concerned)
        let idle = RibbonAppearance.forState(.idle)

        XCTAssertGreaterThan(concerned.rise, 0, "positive rise sits her low")
        XCTAssertLessThan(concerned.speed, idle.speed)
        XCTAssertGreaterThan(concerned.desaturation, 0.5)
    }

    func testShouldShedSparksOnlyWhenThinkingOrDelighted() {
        for state in PresenceState.allCases {
            let sparks = RibbonAppearance.forState(state).sparks
            switch state {
            case .thinking, .delighted:
                XCTAssertGreaterThan(sparks, 0, "\(state) should shed sparks")
            default:
                XCTAssertEqual(sparks, 0, "\(state) should not shed sparks")
            }
        }
    }

    func testShouldBlendBetweenStatesRatherThanSnapping() {
        let from = RibbonAppearance.forState(.idle)
        let to = RibbonAppearance.forState(.alert)
        let half = RibbonAppearance.lerp(from, to, 0.5)

        XCTAssertEqual(half.brightness, (from.brightness + to.brightness) / 2, accuracy: 0.0001)
        XCTAssertGreaterThan(half.straightness, from.straightness)
        XCTAssertLessThan(half.straightness, to.straightness)
    }

    func testShouldClampBlendProgressSoCallersCannotOvershoot() {
        let from = RibbonAppearance.forState(.idle)
        let to = RibbonAppearance.forState(.alert)

        XCTAssertEqual(RibbonAppearance.lerp(from, to, -3), from)
        XCTAssertEqual(RibbonAppearance.lerp(from, to, 12), to)
    }

    func testShouldStartAndEndATransitionAtRest() {
        XCTAssertEqual(RibbonAppearance.ease(0), 0, accuracy: 0.0001)
        XCTAssertEqual(RibbonAppearance.ease(1), 1, accuracy: 0.0001)
        XCTAssertEqual(RibbonAppearance.ease(0.5), 0.5, accuracy: 0.0001)
        // Smoothstep, so it leaves 0 slower than a straight line would.
        XCTAssertLessThan(RibbonAppearance.ease(0.25), 0.25)
    }

    /// An alert that eases in over a second is not an alert. Settling back to idle is
    /// slow on purpose — a fast decay reads as being switched off.
    func testShouldArriveAtAlertFasterThanItSettlesBackToIdle() {
        XCTAssertLessThan(
            RibbonAppearance.transitionDuration(to: .alert),
            RibbonAppearance.transitionDuration(to: .idle)
        )
    }

    func testShouldScatterSparksDeterministicallySoTheyDoNotFlicker() {
        XCTAssertEqual(Scatter.hash(7), Scatter.hash(7))
        XCTAssertNotEqual(Scatter.hash(7), Scatter.hash(8))

        for index in 0..<200 {
            let value = Scatter.hash(index)
            XCTAssertGreaterThanOrEqual(value, 0)
            XCTAssertLessThan(value, 1)
        }
    }
}
