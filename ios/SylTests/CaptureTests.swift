import SylKit
import XCTest

@testable import Syl

/// He can write one down in a sentence.
///
/// Every test here runs against an in-memory database and never touches the network,
/// which is the point rather than a convenience: capture has to work with the server
/// unreachable, so a test that needed one would be testing the wrong thing.
@MainActor
final class CaptureTests: XCTestCase {
    private var database: SylDatabase!
    private var store: LocalStore!
    private var outbox: Outbox!

    private let now = try! Instant.parse("2026-08-10T15:00:00Z")

    /// `async` rather than `setUpWithError`, deliberately. The class is `@MainActor` — it
    /// builds a `@MainActor` view model — and the throwing overload is nonisolated, so it
    /// cannot touch these properties at all. The async overload inherits the class's
    /// isolation, which is the whole of the fix.
    override func setUp() async throws {
        try await super.setUp()
        database = try SylDatabase.inMemory()
        store = LocalStore(database: database)
        outbox = Outbox(database: database)
    }

    override func tearDown() async throws {
        outbox = nil
        store = nil
        database = nil
        try await super.tearDown()
    }

    // MARK: - What a commit writes

    func testShouldWriteASentenceWithATimestampAndNothingElse() async throws {
        // The heart of proposal B: "They die at capture, not at review." Every column
        // except the text and the clock is null, and this is the assertion that fails the
        // day someone adds a date picker.
        let model = makeModel()

        await model.capture("Call the roofer back")

        let written = try XCTUnwrap(store.openTodos().first)
        XCTAssertEqual(written.text, "Call the roofer back")
        XCTAssertEqual(written.createdAt, now)
        XCTAssertNil(written.dueAt)
        XCTAssertNil(written.goalId)
        XCTAssertNil(written.delegatedJobId)
        XCTAssertNil(written.completedAt)
        XCTAssertFalse(written.pinned)
    }

    func testShouldLandAsOpenBecauseAnExplicitAskIsNeverProvisional() async throws {
        // `proposed` is inferred structure — provisional, and it expires if unresolved.
        // A sentence he typed himself is not an inference about him.
        let model = makeModel()

        await model.capture("Book the car in")

        XCTAssertEqual(try store.openTodos().first?.status, .open)
        XCTAssertEqual(try store.openTodos().first?.source, .commander)
    }

    func testShouldQueueTheIntentInTheSameBreathAsTheRow() async throws {
        // One transaction, because the two halves are the same fact. A row with no outbox
        // entry is a to-do Syl will never hear about; an outbox entry with no row is a
        // capture he cannot see he made.
        let model = makeModel()

        await model.capture("Send the signed quote")

        let queued = try outbox.pending()
        XCTAssertEqual(queued.count, 1)
        XCTAssertEqual(queued.first?.kind, .createTodo)
        XCTAssertFalse(queued.first?.idempotencyKey.isEmpty == true)
        XCTAssertEqual(
            try queued.first?.decodePayload(as: CreateTodoRequest.self).text,
            "Send the signed quote"
        )
    }

    func testShouldCarryNoDateOrGoalInTheQueuedIntentEither() async throws {
        // The refusal is structural, not disciplined: there is no parameter for these,
        // so a second control would have to widen the store first.
        let model = makeModel()

        await model.capture("Replace the hall bulb")

        let body = try XCTUnwrap(
            try outbox.pending().first?.decodePayload(as: CreateTodoRequest.self)
        )
        XCTAssertNil(body.dueAt)
        XCTAssertNil(body.goalId)
        XCTAssertFalse(body.pinned)
    }

    // MARK: - No confirmation step and no inbox

    func testShouldMakeTheRowExistTheMomentHeCommits() async throws {
        // No triage queue, no "added to inbox", no undo bar. The snapshot the list renders
        // from carries the to-do on the very next frame, with nothing having reached the
        // network.
        let model = makeModel()

        await model.capture("Ask about the gutter guard")

        XCTAssertEqual(model.snapshot.rows.map(\.todo.text), ["Ask about the gutter guard"])
        XCTAssertEqual(model.snapshot.openCount, 1)
    }

    func testShouldNotParkACaptureInAnyProvisionalState() async throws {
        // A `proposed` row would be an inbox by another name — something he has to come
        // back and confirm.
        let model = makeModel()

        await model.capture("Collect the prescription")

        XCTAssertTrue(model.snapshot.rows.allSatisfy { $0.todo.status == .open })
        XCTAssertTrue(try outbox.blocked().isEmpty, "a capture is never parked")
    }

    func testShouldSurviveTheServerBeingUnreachable() async throws {
        // Nothing in this test has a network, and nothing in it is allowed to want one.
        // The `flush` seam is never called because the model is built without one.
        let model = makeModel()

        await model.capture("Read the thing she found on sleep debt")

        XCTAssertEqual(try store.openTodos().count, 1)
        XCTAssertEqual(try outbox.pending().count, 1, "queued, with its key, waiting")
    }

    // MARK: - An empty commit writes nothing

    func testShouldWriteNothingForAnEmptyCommit() async throws {
        let model = makeModel()

        await model.capture("")

        XCTAssertTrue(try store.openTodos().isEmpty)
        XCTAssertEqual(try outbox.count(), 0)
    }

    func testShouldWriteNothingForAWhitespaceOnlyCommit() async throws {
        // A stray tap must not leave a blank row in his list forever.
        let model = makeModel()

        for stray in ["   ", "\n", "\t\t", " \n \t "] {
            await model.capture(stray)
        }

        XCTAssertTrue(try store.openTodos().isEmpty)
        XCTAssertEqual(try outbox.count(), 0)
    }

    func testShouldTrimTheSentenceRatherThanStoreItsEdges() async throws {
        let model = makeModel()

        await model.capture("  Book the car in for its service \n")

        XCTAssertEqual(try store.openTodos().first?.text, "Book the car in for its service")
    }

    func testShouldDecideEmptinessInAPureFunctionThatATestCanReach() {
        // The rule lives somewhere assertable rather than inside a `body`, which is why
        // the control can be visibly inert instead of inviting a tap that will refuse him.
        XCTAssertNil(CaptureField.sentence(from: ""))
        XCTAssertNil(CaptureField.sentence(from: "     "))
        XCTAssertNil(CaptureField.sentence(from: "\n\t"))
        XCTAssertEqual(CaptureField.sentence(from: " Roofer "), "Roofer")
        XCTAssertEqual(CaptureField.sentence(from: "Roofer"), "Roofer")
    }

    // MARK: - Repeats and keys

    func testShouldGiveEveryCaptureItsOwnIdempotencyKey() async throws {
        // Two separate to-dos, not one deduplicated into the other. A key shared between
        // captures would make the second one vanish on the server.
        let model = makeModel()

        await model.capture("One")
        await model.capture("Two")

        let keys = Set(try outbox.pending().map(\.idempotencyKey))
        XCTAssertEqual(keys.count, 2)
        XCTAssertEqual(try store.openTodos().count, 2)
    }

    func testShouldWriteTwoRowsWhenHeGenuinelyWritesTheSameThingTwice() async throws {
        // Same words, different intent. Deduplicating on text would be the app deciding
        // he did not mean it — and "buy milk" twice in a fortnight is ordinary.
        let model = makeModel()

        await model.capture("Buy milk")
        await model.capture("Buy milk")

        XCTAssertEqual(try store.openTodos().count, 2)
        XCTAssertEqual(try outbox.pending().count, 2)
    }

    func testShouldRefuseToDuplicateWhenTheSameKeyIsQueuedTwice() async throws {
        // A double tap, a retried launch path. The unique index makes the repeat a no-op
        // rather than failing the whole transaction and losing the capture.
        let fixed = "fixed-key-for-a-double-tap"
        let model = makeModel(key: { fixed })

        await model.capture("One")
        await model.capture("Two")

        XCTAssertEqual(try outbox.pending().count, 1, "one intent, because one key")
    }

    // MARK: - Where a capture lands in the list

    func testShouldPutAFreshCaptureWhereHeCanSeeItRatherThanBeneathEverything() async throws {
        // The list's last ordering term is recency for exactly this reason: capture sits
        // at the head of the list, and a to-do he just wrote down that sorted to the
        // bottom of a long undated group would look like a capture that did nothing.
        try store.upsert((1...20).map { older($0) })
        let model = makeModel()
        await model.refresh()

        await model.capture("The one I just thought of")

        let undated = try XCTUnwrap(model.snapshot.sections.first { $0.band == .undated })
        XCTAssertEqual(undated.rows.first?.todo.text, "The one I just thought of")
    }

    func testShouldStillSitBelowSomethingActuallyDue() async throws {
        // Recency is the *last* term, not the first. A capture must not displace a
        // deadline just by being new.
        try store.upsert([
            Todo(
                id: "syl:todo:due", text: "Due today", goalId: nil,
                dueAt: now.addingTimeInterval(3600), pinned: false, status: .open,
                source: .commander, delegatedJobId: nil,
                createdAt: now, updatedAt: now, completedAt: nil
            )
        ])
        let model = makeModel()

        await model.capture("Just thought of it")

        XCTAssertEqual(model.snapshot.rows.first?.todo.text, "Due today")
    }

    // MARK: - Harness

    private func makeModel(key: @escaping @Sendable () -> String = { UUID().uuidString }) -> TodoListViewModel {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/Chicago")!

        return TodoListViewModel(
            store: store,
            calendar: calendar,
            now: { [now] in now },
            makeIdempotencyKey: key
        )
    }

    /// A to-do written a while ago, so a fresh capture has something to sort above.
    private func older(_ index: Int) -> Todo {
        Todo(
            id: "syl:todo:old-\(String(format: "%04d", index))",
            text: "Older \(index)",
            goalId: nil,
            dueAt: nil,
            pinned: false,
            status: .open,
            source: .commander,
            delegatedJobId: nil,
            createdAt: now.addingTimeInterval(-86_400 * Double(index)),
            updatedAt: now.addingTimeInterval(-86_400 * Double(index)),
            completedAt: nil
        )
    }
}
