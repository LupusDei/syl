import CoreGraphics
import Foundation

/// Where he is standing in the sky. **Pure, and bounded so he can never lose it.**
///
/// The Commander's extension to this feature, in his words: *"Wandering critical. Pinch drag
/// zoom and select to view details."* Wander is the difference between something he looks at
/// and somewhere he is, and the whole of it is two numbers — a scale and a translation —
/// applied to a sky whose coordinates never change.
///
/// ## The one rule, and everything it decides
///
/// > **The centre of the screen is always looking at part of the sky.**
///
/// That single constraint is the entire bound, and it is chosen over the two obvious
/// alternatives on purpose:
///
/// - *Content covers the viewport*, the photo-viewer clamp, gives **zero** pan at rest —
///   the sky is laid out to the screen and sits inside it, so a drag on first open would do
///   nothing at all. A primary verb that is dead on first touch reads as broken.
/// - *No clamp*, or a rubber band that lets go, means he can fling the sky away and arrive
///   at black with nothing to aim at. There is no "back" gesture in a field of nothing.
///
/// What this rule gives instead: at rest the sky slides about half a screen in any
/// direction and then stops, with most of itself still on screen; at any zoom **any star
/// can be brought exactly to the centre and no further**, so nothing can be pushed off an
/// edge and stranded. Both of those are assertions in `ConstellationTransformTests`, not
/// descriptions.
///
/// ## Zoom changes what is legible, never what exists
///
/// There is deliberately no level-of-detail here and no visibility threshold anywhere in
/// the drawing that depends on ``scale``. Every star that exists is drawn at every scale —
/// a sky that grows things as you approach is not a sky, it is a game map. Approaching
/// makes a faint thing *readable*; it does not make it *present*.
struct ConstellationTransform: Equatable, Sendable {
    /// How magnified the sky is. 1 is the whole sky, laid out for this screen.
    var scale: Double
    /// Where the sky's origin sits in view space, after scaling.
    var translation: CGSize

    init(scale: Double = 1, translation: CGSize = .zero) {
        self.scale = scale
        self.translation = translation
    }

    /// The sky as it opens: the whole of it, exactly where the layout put it.
    static let identity = ConstellationTransform()

    /// **Never below one.** At one the whole sky is on screen; below it he would be pushing
    /// the sky away in order to look at margin, which is emptiness with extra steps.
    static let minimumScale: Double = 1.0

    /// Close enough that the faintest thing she holds is legible, and no closer. Past this
    /// the drawing is magnifying a three-point core into a disc, and a disc has nothing more
    /// to say than the point did.
    static let maximumScale: Double = 4.0

    // MARK: - The map

    /// Sky space to view space.
    func apply(_ point: CGPoint) -> CGPoint {
        CGPoint(x: point.x * scale + translation.width, y: point.y * scale + translation.height)
    }

    /// View space back to sky space. Exact, and the reason ``scale`` may never reach zero.
    func invert(_ point: CGPoint) -> CGPoint {
        CGPoint(x: (point.x - translation.width) / scale, y: (point.y - translation.height) / scale)
    }

    // MARK: - Wandering

    /// Drag. The sky follows the finger exactly — nothing here is damped or accelerated,
    /// because a sky that slides further than the finger went is a sky he cannot aim.
    func panned(by delta: CGSize) -> Self {
        ConstellationTransform(
            scale: scale,
            translation: CGSize(
                width: translation.width + delta.width,
                height: translation.height + delta.height
            )
        )
    }

    /// Pinch, about the point between his fingers.
    ///
    /// The focus is held **exactly** still: whatever piece of sky is under the pinch stays
    /// under it. Zooming about the centre of the screen instead is the commonest version of
    /// this and it is wrong — it slides the thing he is looking at out from under his own
    /// fingers.
    func zoomed(by magnification: Double, about focus: CGPoint) -> Self {
        guard magnification > 0, scale > 0 else { return self }
        let wanted = min(max(scale * magnification, Self.minimumScale), Self.maximumScale)
        let ratio = wanted / scale
        return ConstellationTransform(
            scale: wanted,
            translation: CGSize(
                width: focus.x - (focus.x - translation.width) * ratio,
                height: focus.y - (focus.y - translation.height) * ratio
            )
        )
    }

    // MARK: - The bound

    /// The nearest legal transform to this one.
    ///
    /// Scale into range, then translation into the interval that keeps ``invert(_:)`` of the
    /// view's centre inside `bounds`. The axes are independent, so a diagonal fling is
    /// stopped on whichever one runs out first rather than being refused wholesale — the
    /// sky slides along the edge instead of sticking to it.
    ///
    /// `bounds` always contains the centre of `viewSize` — ``PreparedSky/contentBounds``
    /// guarantees exactly that — which is what makes ``identity`` legal for *every* sky.
    /// Without the guarantee, a sky whose stars all sit off to one side would be **nudged
    /// the instant it appeared**, and a sky that moves on its own the moment you look at it
    /// is the one failure the whole deterministic layout exists to prevent.
    func clamped(within bounds: CGRect, viewSize: CGSize) -> Self {
        guard viewSize.width > 0, viewSize.height > 0, !bounds.isNull, !bounds.isInfinite else {
            return self
        }

        let scale = min(max(self.scale, Self.minimumScale), Self.maximumScale)
        let centre = CGPoint(x: viewSize.width / 2, y: viewSize.height / 2)

        // invert(centre).x ∈ [minX, maxX]  ⟺  tx ∈ [centre.x − maxX·s, centre.x − minX·s]
        let x = min(
            max(translation.width, centre.x - bounds.maxX * scale),
            centre.x - bounds.minX * scale)
        let y = min(
            max(translation.height, centre.y - bounds.maxY * scale),
            centre.y - bounds.minY * scale)

        return ConstellationTransform(scale: scale, translation: CGSize(width: x, height: y))
    }

    // MARK: - Making room

    /// Move the sky the smallest distance that puts `skyPoint` inside a band of the screen.
    ///
    /// **This is why selection is a transform rather than a highlight.** A card rising from
    /// the bottom over the star he just touched hides the one thing he asked about, and
    /// tapping through a card to find out what is under it is not an interaction. So the sky
    /// pans the selection clear as the card rises, by exactly as much as the card is about
    /// to take and no more — a screen that jumps further than it needed to reads as a
    /// mistake rather than as room being made.
    ///
    /// Both edges, not only the bottom: at four times magnification a star can equally well
    /// be behind the navigation bar, and a rule that only ever panned upward would leave it
    /// there.
    ///
    /// Clamped, so making room can never break the bound. If the clamp refuses part of the
    /// lift, the star still ends up as clear as the sky allows.
    func revealing(
        _ skyPoint: CGPoint,
        between top: CGFloat,
        and bottom: CGFloat,
        within bounds: CGRect,
        viewSize: CGSize
    ) -> Self {
        guard top <= bottom else { return self }

        let y = apply(skyPoint).y
        let lift: CGFloat
        if y > bottom {
            lift = bottom - y
        } else if y < top {
            lift = top - y
        } else {
            return self
        }

        return panned(by: CGSize(width: 0, height: lift))
            .clamped(within: bounds, viewSize: viewSize)
    }
}
