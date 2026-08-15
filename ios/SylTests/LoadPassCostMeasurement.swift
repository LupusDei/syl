import Foundation
import SylKit
import XCTest

@testable import Syl

/// Where the time in `ChatSnapshotLoader.load()` actually goes (`syl-025.2.6`).
///
/// **A measurement, run before designing the delta protocol rather than after.** Four
/// O(window) passes survive `syl-025.2.5`, and they are not the same size as each other.
/// Making the cheap ones incremental while the expensive one stays linear would be a
/// large, risky change to grouping — the place staleness is least visible — bought for a
/// fraction of the cost. Three theories died to measurement tonight; this one gets
/// measured first.
///
/// This is a stopwatch used for the one question a stopwatch can answer: **which of these
/// four is heaviest.** It is deliberately not counting anything — every pass here is
/// known by inspection to visit the whole window, so "how many" is not in doubt and the
/// counter argument from `ChatRowCensus` does not apply.
final class LoadPassCostMeasurement: XCTestCase {
    private static let window = 2_000

    func testMeasureWhereTheTimeGoesForOneArrivingMessage() throws {
        let database = try SylDatabase.inMemory()
        let store = LocalStore(database: database)
        let base = try Instant.parse("2026-08-09T07:00:03.114Z")
        try store.upsert(
            (1...Self.window).map { seq in
                Message(
                    id: "syl:message:0198f2c0-0001-7000-8000-\(String(format: "%012d", seq))",
                    conversationId: SylIDs.interactiveConversation,
                    clientId: nil,
                    role: seq.isMultiple(of: 2) ? .assistant : .user,
                    text: ChatFreezeFixture.paragraphs[seq % ChatFreezeFixture.paragraphs.count],
                    createdAt: base.addingTimeInterval(
                        Double(seq) * (MessageGrouping.maximumGap + 1)
                    ),
                    seq: seq
                )
            }
        )

        let markdown = MarkdownCache()

        // Warm everything exactly as a steady-state app has it: the cache holds the whole
        // window, and one message then arrives. Measuring a cold cache would report the
        // parse cost, which `syl-025.2.5` already took out of the recurring path.
        let warm = try store.messages(conversationId: SylIDs.interactiveConversation,
                                      limit: Self.window + 1)
        _ = markdown.blocks(for: warm)

        var read = 0.0, group = 0.0, parse = 0.0, rows = 0.0, slice = 0.0
        let runs = 5
        for _ in 0..<runs {
            let t0 = DispatchTime.now().uptimeNanoseconds
            let page = try store.messages(conversationId: SylIDs.interactiveConversation,
                                          limit: Self.window + 1)
            let t1 = DispatchTime.now().uptimeNanoseconds
            let messages = page.count > Self.window ? Array(page.dropFirst()) : page
            let pendingIds = Set(try store.pendingMessages().map(\.id))

            let t2 = DispatchTime.now().uptimeNanoseconds
            let groups = MessageGrouping.group(messages, pendingIds: pendingIds)
            let t3 = DispatchTime.now().uptimeNanoseconds
            let parsed = markdown.blocks(for: messages)
            let t4 = DispatchTime.now().uptimeNanoseconds
            let builtRows = TranscriptRhythm.rows(for: groups)
            let t5 = DispatchTime.now().uptimeNanoseconds
            var byGroup: [SylID: [[MarkdownBlock]]] = [:]
            byGroup.reserveCapacity(groups.count)
            for g in groups {
                byGroup[g.id] = g.messages.map { parsed[$0.id] ?? [.paragraph($0.text)] }
            }
            let t6 = DispatchTime.now().uptimeNanoseconds

            read += Double(t1 - t0) / 1_000_000
            group += Double(t3 - t2) / 1_000_000
            parse += Double(t4 - t3) / 1_000_000
            rows += Double(t5 - t4) / 1_000_000
            slice += Double(t6 - t5) / 1_000_000
            XCTAssertEqual(builtRows.isEmpty, false)
        }

        let n = Double(runs)
        let total = (read + group + parse + rows + slice) / n
        print("""
            SYL_LOAD_PASSES window \(Self.window), mean of \(runs) runs, milliseconds
              read+decode  \(String(format: "%7.2f", read / n))
              group        \(String(format: "%7.2f", group / n))
              parse-lookup \(String(format: "%7.2f", parse / n))
              rows         \(String(format: "%7.2f", rows / n))
              byGroup      \(String(format: "%7.2f", slice / n))
              TOTAL        \(String(format: "%7.2f", total))
            """)

        XCTAssertGreaterThan(total, 0, "the measurement must have measured something")
    }
}
