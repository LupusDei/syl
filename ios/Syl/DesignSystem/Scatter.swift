import Foundation

/// Stable pseudo-randomness for things that are drawn every frame.
///
/// ## Why not `Double.random`
///
/// A particle whose position is re-rolled each frame is television static. Sparks and
/// motes have to sit still and *drift* — which means their scatter must be a pure
/// function of their index, evaluated fresh every frame and identical every time.
///
/// ## Why this lives on its own
///
/// It started as a static on the ribbon and the mote field reached across to borrow it.
/// Two callers is the point at which a helper stops belonging to one of them. It is also
/// `nonisolated`, which a static on a `View` cannot be: `View` is `@MainActor` under
/// Swift 6, so a static declared there is main-actor isolated and unusable from a test
/// or from any non-isolated drawing context.
enum Scatter {
    /// Deterministic `0..<1` from an index.
    ///
    /// Knuth's multiplicative constant, then a xorshift and a second multiply to break
    /// up the low bits — consecutive indices otherwise produce visibly adjacent values
    /// and the field lines up into stripes. Not a cryptographic hash and not trying to
    /// be one; the only requirements are that it is stable, cheap, and looks unordered.
    static func hash(_ index: Int) -> Double {
        var x = UInt64(truncatingIfNeeded: index &* 2_654_435_761)
        x ^= x >> 13
        x = x &* 0x9E37_79B9_7F4A_7C15
        x ^= x >> 7
        return Double(x % 10_000) / 10_000
    }
}
