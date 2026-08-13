import GRDB
import XCTest

@testable import Syl
@testable import SylKit

/// A row written before a field existed is history, not a broken contract.
///
/// `syl-021`. The Commander's Today screen died on this and then, once `syl-019` landed,
/// told us exactly why:
///
///     DecodingError.keyNotFound: Key 'because' not found in keyed decoding container.
///     "because" is required and nullable — the key must be present, with an explicit
///     null if it has no value.
///
/// `because` had just been added to reminders. Every reminder already on his phone was
/// written without it. `LocalStore.upcomingReminders` decodes its rows together with
/// `try`, so one old row threw and took the entire day with it.
///
/// **The strict rule is right and is not being weakened.** `decodeRequiredNullable`
/// exists so a server that quietly stops sending a field cannot be mistaken for a server
/// sending null, and that check still throws on the wire. What was wrong is that the same
/// rule was applied to payloads this device wrote itself, where an absent key means the
/// row predates the field — a fact about when it was written, which no amount of
/// contract enforcement can fix, because the past cannot be made to know about the
/// future.
///
/// `because` was never the point. **Every field ever added to a stored type reproduces
/// this**, which is why these tests are about the rule rather than about one key.
final class StoredPayloadDecodingTests: XCTestCase {
    private var database: SylDatabase!
    private var store: LocalStore!

    override func setUpWithError() throws {
        try super.setUpWithError()
        database = try SylDatabase.inMemory()
        store = LocalStore(database: database)
    }

    override func tearDown() {
        store = nil
        database = nil
        super.tearDown()
    }

    private let noon = Date(timeIntervalSince1970: 1_786_000_000)

    private func reminder(id: SylID) -> Reminder {
        Reminder(
            id: id, kind: .commitment, text: "Verify the insurance", todoId: nil,
            eventId: nil, wallTime: "09:00", tz: "America/Chicago", rrule: nil,
            scheduledFor: noon, nextFireAt: noon,
            urgent: false, late: false, deferredFrom: nil, supersedesPrevious: false,
            deliveryState: .scheduled, createdAt: noon, updatedAt: noon, completedAt: nil
        )
    }

    /// Rewrites a stored row's payload as an older version of the app would have: with
    /// the named keys simply absent, which is what "written before the field existed"
    /// looks like on disk.
    private func stripKeys(_ keys: [String], fromReminder id: SylID) throws {
        try database.queue.write { db in
            let payload = try XCTUnwrap(
                try Data.fetchOne(db, sql: "SELECT payload FROM reminder WHERE id = ?", arguments: [id])
            )
            var object = try XCTUnwrap(
                try JSONSerialization.jsonObject(with: payload) as? [String: Any]
            )
            for key in keys { object.removeValue(forKey: key) }
            try db.execute(
                sql: "UPDATE reminder SET payload = ? WHERE id = ?",
                arguments: [try JSONSerialization.data(withJSONObject: object), id]
            )
        }
    }

    func testShouldReadARowWrittenBeforeTheFieldExisted() throws {
        let id: SylID = "syl:reminder:0198f2c1-0021-7d21-9f00-1a2b3c4d5e21"
        try store.upsert([reminder(id: id)])
        try stripKeys(["because"], fromReminder: id)

        // The exact failure from his screenshot. Before the fix this threw and every
        // reminder on the device became unreadable along with it.
        let recovered = try store.upcomingReminders(after: noon.addingTimeInterval(-60))

        XCTAssertEqual(recovered.map(\.id), [id])
        XCTAssertNil(recovered.first?.because, "an absent key reads as no value")
    }

    func testShouldNotLoseTheWholeDayToOneOldRow() throws {
        // The blast radius, which is what turned a stale field into a blank screen.
        // `upcomingReminders` decodes its rows together, so the old row must not be
        // able to take the current ones with it.
        let old: SylID = "syl:reminder:0198f2c1-0022-7d21-9f00-1a2b3c4d5e22"
        let current: SylID = "syl:reminder:0198f2c1-0023-7d21-9f00-1a2b3c4d5e23"
        try store.upsert([reminder(id: old), reminder(id: current)])
        try stripKeys(["because", "origin"], fromReminder: old)

        let recovered = try store.upcomingReminders(after: noon.addingTimeInterval(-60))

        XCTAssertEqual(Set(recovered.map(\.id)), [old, current])
    }

    func testShouldStillRefuseAnAbsentKeyFromTheServer() throws {
        // The half that must NOT change. This rule is why a service that quietly stops
        // sending a field cannot be mistaken for one sending null, and relaxing it
        // everywhere would have been the easy fix and the wrong one.
        let wire = """
        {"id":"syl:reminder:0198f2c1-0024-7d21-9f00-1a2b3c4d5e24","kind":"commitment",
         "text":"Verify the insurance","origin":null,"todoId":null,"eventId":null,
         "wallTime":"09:00","tz":"America/Chicago","rrule":null,
         "scheduledFor":"2026-08-09T07:00:00.000Z","nextFireAt":"2026-08-09T07:00:00.000Z",
         "urgent":false,"late":false,"deferredFrom":null,"supersedesPrevious":false,
         "deliveryState":"scheduled","createdAt":"2026-08-09T07:00:00.000Z",
         "updatedAt":"2026-08-09T07:00:00.000Z","completedAt":null}
        """.data(using: .utf8)!

        XCTAssertThrowsError(
            try SylJSON.decoder().decode(Reminder.self, from: wire),
            "the wire dropped a required key and the app accepted it"
        ) { error in
            guard case DecodingError.keyNotFound(let key, _) = error else {
                return XCTFail("expected keyNotFound, got \(error)")
            }
            XCTAssertEqual(key.stringValue, "because")
        }
    }

    func testShouldConfineTheRelaxedRuleToTheDecodeThatAskedForIt() throws {
        // A scope, not a global switch. If the flag leaked past the stored read, the
        // wire's contract check would be silently dead everywhere and nothing would
        // fail to say so.
        _ = try? store.upcomingReminders(after: noon)

        XCTAssertFalse(
            StoredPayloadDecoding.isActive,
            "the stored-history rule escaped its scope and is now in force for the wire"
        )
    }
}
