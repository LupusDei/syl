import Foundation

/// How many transcript rows SwiftUI actually built.
///
/// ## Why a counter here, when the test beside it argues against counters
///
/// `ChatInlineRenderCostTests` measures with a **stopwatch**, deliberately, and says why:
/// a counter we keep ourselves can agree with a system that is wrong, so the parse cost
/// had to be measured from outside. That reasoning stands, and it does not apply here.
///
/// "How many rows did the `LazyVStack` materialise" has no external proxy. A stopwatch
/// cannot tell fifty cheap rows from two thousand cheap rows on a fast machine, and the
/// quantity in the requirement (FR-005: *lay out only rows at or near the viewport*) is
/// the count itself. The honest move is not to find a worse proxy; it is to make the
/// counter incapable of quietly agreeing:
///
/// - it is incremented at **exactly one** place, `ChatTurn.body` — the construction whose
///   cost is the whole question, not a bookkeeping line beside it;
/// - every test that reads it is proven against a mutation that must move it, because a
///   probe nobody has broken on purpose is a probe nobody has tested.
///
/// The number is unavailable outside `DEBUG`, so nothing in a shipped build can read it
/// and no behaviour can come to depend on it.
@MainActor
enum ChatRowCensus {
    #if DEBUG
        /// Rows built since the last ``reset()``.
        private(set) static var rowsBuilt = 0

        static func reset() {
            rowsBuilt = 0
        }
    #endif

    /// One transcript row was constructed.
    static func recordRowBuild() {
        #if DEBUG
            rowsBuilt += 1
        #endif
    }
}
