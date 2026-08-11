import Foundation
import SwiftUI

/// Where a sky comes from.
///
/// A closure rather than a protocol, and rather than a `LocalStore` reference, because the
/// device-scoped read was built in parallel and this screen had to be renderable,
/// previewable and testable before it existed. Its wiring is one adapter function handed in
/// here — not a change to anything that draws.
///
/// **`SkySource`, not `ConstellationSource`, and that is not a stylistic choice.** The
/// parallel squad landed a `ConstellationSource` struct in this same module
/// (`Core/Services/ConstellationSource.swift`) — disk first, network second, wrapping
/// `LocalStore`. Two declarations of one name in one module do not shadow, they fail to
/// build, so this is the name that has to move. The two are complementary and not
/// alternatives: theirs answers *where the bytes come from*, this one is the seam a
/// preview, a test or an offscreen render fills with a value.
typealias SkySource = @Sendable () async -> ConstellationSnapshot

/// Owns the constellation's lifecycle; every view below it stays a pure function of values.
///
/// The same split `HomeScreen` and `GoalsScreen` already make, for the same reason: a view
/// with no observable objects of its own can be rendered offscreen without booting the
/// app's object graph — which on this screen is not a convenience but the primary check on
/// the feature.
@MainActor
final class ConstellationViewModel: ObservableObject {
    /// The finished sky the `Canvas` draws. Assigned, never computed.
    @Published private(set) var sky: PreparedSky = .empty

    /// Whether the source has answered at all.
    ///
    /// Distinct from "the sky is empty", and the distinction is the difference between a
    /// blank screen that is loading and a blank screen that is the truth. Only the second
    /// gets to say so.
    @Published private(set) var hasRead = false

    private let source: SkySource
    private var snapshot: ConstellationSnapshot = .empty
    private var preparedFor: CGSize = .zero

    init(source: @escaping SkySource) {
        self.source = source
    }

    /// Read the graph, then build the sky for this size.
    func read(size: CGSize) async {
        snapshot = await source()
        hasRead = true
        await prepare(size: size)
    }

    /// Rebuild for a new size — a rotation, or a split view.
    ///
    /// Guarded, because `GeometryReader` republishes its size for reasons that are not a
    /// size change, and re-preparing the sky on each of them would be a detached task per
    /// layout pass.
    ///
    /// **The guard is a tolerance, not an equality, and that distinction was a bug he could
    /// see.** With `!=`, a third of a point counted as a new screen — and the sky's layout
    /// is a function of its size, so every star moved. Worse, it closed a ring: a re-laid
    /// sky has a new ``PreparedSky/size``, which sets ``ConstellationBand/tallestCard(in:)``,
    /// which decides what the card fits into, which perturbs the geometry again. Tapping a
    /// star started it, and it looked exactly like what it was — the whole field slowly
    /// scaling and sliding, and no gesture that could catch it.
    ///
    /// A point is the right threshold because it is the smallest change that can move a
    /// pixel on any screen we run on. Below it there is nothing to redraw, so there is
    /// nothing to compute.
    func resize(to size: CGSize) async {
        guard !size.isWithinAPoint(of: preparedFor) else { return }
        await prepare(size: size)
    }

    /// **Off the main actor, always.**
    ///
    /// Placement, nearest-neighbour territories, depth, brightness and the filament list
    /// are all pure functions of data that changes when a graph is read — so they are
    /// computed once, on a detached task, into a value the drawing pass only reads.
    /// `syl-008` shipped a quadratic comparison into a transcript and it cost the Commander
    /// two crashes; a graph is the easiest place in this app to repeat that.
    ///
    /// `SkyPreparer` is a `Sendable` struct holding no view, no view model and no store, so
    /// this genuinely leaves the main actor rather than being hopped straight back by an
    /// implicit capture.
    private func prepare(size: CGSize) async {
        guard size.width > 1, size.height > 1 else { return }

        let snapshot = self.snapshot
        let now = Date.now
        let prepared = await Task.detached(priority: .userInitiated) {
            SkyPreparer(now: now).prepare(snapshot, size: size)
        }.value

        preparedFor = size
        sky = prepared
    }
}

// MARK: - Stillness

extension CGSize {
    /// Whether these two sizes are the same screen as far as anything drawable is concerned.
    ///
    /// Compared per axis rather than by distance: a size is two independent measurements,
    /// and a rotation that swaps them is a real change on both even where the diagonal
    /// barely moves.
    func isWithinAPoint(of other: CGSize) -> Bool {
        abs(width - other.width) < 1 && abs(height - other.height) < 1
    }
}
