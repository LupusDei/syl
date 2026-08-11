import CoreGraphics
import Foundation

/// The sky, finished. Everything the `Canvas` needs and nothing it has to work out.
///
/// ## Why this exists at all
///
/// The same reason `ChatSnapshotLoader` does, and the same reason it was expensive to
/// learn: a `Canvas` inside a `TimelineView` redraws twenty-four times a second, and
/// anything computed inside `draw` is computed twenty-four times a second. Placement,
/// nearest-neighbour territories, depth, alpha and the filament list are all pure
/// functions of data that changes when a graph is read — roughly never — so they are
/// computed once, off the main actor, into a value the drawing pass only reads.
///
/// `syl-008` shipped a quadratic comparison into a transcript and it cost the Commander
/// two crashes. A graph is the easiest place in this app to repeat that, and the shape of
/// the defence is: **the view assigns a finished value, and the drawing does arithmetic on
/// it.**
struct PreparedSky: Equatable, Sendable {
    var stars: [PreparedStar] = []
    var filaments: [PreparedFilament] = []
    /// The size this sky was laid out for. A `Canvas` handed a sky prepared for a
    /// different size would draw it in the wrong place rather than fail, so the size
    /// travels with it and the view re-prepares when it changes.
    var size: CGSize = .zero

    static let empty = PreparedSky()

    var isEmpty: Bool { stars.isEmpty }
}

/// One star, ready to draw.
struct PreparedStar: Equatable, Sendable, Identifiable {
    var id: String
    /// Her words for it. Nothing draws this yet; the card and VoiceOver in phase 4 both
    /// need it, and carrying it costs a pointer.
    var label: String
    /// **The truth.** Motion is added to this and taps are tested against it.
    var anchor: CGPoint
    var seed: Int
    /// 1 is nearest the eye. Tier sets the band, age places within it.
    var depth: Double
    /// `0...1`, straight from the graph. Kept beside `alpha` because the two are not the
    /// same question: alpha is what gets drawn, confidence is what is true.
    var confidence: Double
    var alpha: Double
    var coreRadius: Double
    var isAnchor: Bool
    var tint: StarTint
    /// Whether this star gets diffraction spikes — the detail that makes a point of light
    /// read as a *star* rather than as a dot. Rare on purpose.
    var hasSpikes: Bool
}

/// One filament, ready to draw.
///
/// It carries both endpoints' seeds and depths so it can follow their drift. A filament
/// drawn between two fixed points while the stars at its ends hover would detach from
/// them within a second, which is the sort of thing nobody notices in a screenshot and
/// everybody notices in the hand.
struct PreparedFilament: Equatable, Sendable, Identifiable {
    var id: String
    var from: CGPoint
    var to: CGPoint
    var fromSeed: Int
    var toSeed: Int
    var fromDepth: Double
    var toDepth: Double
    var species: ConstellationSpecies
    var alpha: Double
    var width: Double
    /// How far the line bows out of true, as a fraction of its own length. Seeded, so a
    /// filament always has the same curve.
    ///
    /// A straight line between two stars reads as a diagram. A slight bow reads as
    /// something suspended.
    var bow: Double
}

/// What colour a star burns.
///
/// Three, and they are the palette's own. Deliberately not a per-kind key: nobody needs to
/// know *why* one star is warmer than another for the field to be more beautiful for the
/// variation, and the moment a colour needs explaining the screen has acquired a legend.
enum StarTint: Equatable, Sendable {
    /// Her light. Almost everything.
    case cool
    /// The palette's one warm note, spent on the people he thinks in terms of. Scarcity is
    /// the point — a handful of stars in a field of a hundred.
    case warm
    /// A spren dimming rather than a UI greying out. What `suppressed` looks like.
    case dim
}

/// Builds a finished sky from a snapshot. `Sendable` and holding no view, no view model
/// and no store, so it genuinely leaves the main actor instead of being hopped back by an
/// implicit capture.
struct SkyPreparer: Sendable {
    var now: Date

    init(now: Date = .now) {
        self.now = now
    }

    func prepare(_ snapshot: ConstellationSnapshot, size: CGSize) -> PreparedSky {
        guard size.width > 1, size.height > 1, !snapshot.nodes.isEmpty else {
            return PreparedSky(stars: [], filaments: [], size: size)
        }

        let layout = ConstellationLayout(size: size)
        let placements = layout.place(snapshot)

        var stars: [PreparedStar] = []
        stars.reserveCapacity(snapshot.nodes.count)

        for node in snapshot.nodes {
            guard let placement = placements[node.id] else { continue }

            let depth = ConstellationLayout.depth(
                tier: node.tier, learnedAt: node.learnedAt, now: now)

            stars.append(
                PreparedStar(
                    id: node.id,
                    label: node.label,
                    anchor: placement.point,
                    seed: placement.seed,
                    depth: depth,
                    confidence: node.confidence,
                    alpha: ConstellationLayout.alpha(confidence: node.confidence, depth: depth),
                    coreRadius: ConstellationLayout.coreRadius(
                        confidence: node.confidence, depth: depth, isAnchor: placement.isAnchor),
                    isAnchor: placement.isAnchor,
                    tint: tint(for: node),
                    hasSpikes: placement.isAnchor
                        || (node.tier == .hot && node.confidence >= 0.88)
                )
            )
        }

        // Far first, so a near star is drawn over the haze behind it rather than under it.
        // A sort on a few dozen elements, once per read — not per frame.
        stars.sort { $0.depth < $1.depth }

        var depths: [String: Double] = [:]
        var seeds: [String: Int] = [:]
        depths.reserveCapacity(stars.count)
        for star in stars {
            depths[star.id] = star.depth
            seeds[star.id] = star.seed
        }

        var filaments: [PreparedFilament] = []
        filaments.reserveCapacity(snapshot.edges.count)

        for edge in snapshot.edges {
            // An edge to something not in this region is not an error and not drawn. The
            // sky shows a region; the graph is larger than the region by design.
            guard
                let from = placements[edge.from], let to = placements[edge.to],
                let fromDepth = depths[edge.from], let toDepth = depths[edge.to]
            else { continue }

            let haze = min(fromDepth, toDepth)
            let strength = min(max(edge.confidence, 0), 1)
            let bowSeed = ConstellationSeed.of(edge.id)

            filaments.append(
                PreparedFilament(
                    id: edge.id,
                    from: from.point,
                    to: to.point,
                    fromSeed: seeds[edge.from] ?? from.seed,
                    toSeed: seeds[edge.to] ?? to.seed,
                    fromDepth: fromDepth,
                    toDepth: toDepth,
                    species: edge.species,
                    alpha: Self.filamentAlpha(
                        species: edge.species, confidence: strength, haze: haze,
                        betweenAnchors: from.isAnchor && to.isAnchor),
                    width: edge.species == .observed ? 1.15 : 0.75,
                    bow: (Scatter.hash(bowSeed) - 0.5) * 0.30
                )
            )
        }

        // Faintest first. Additive blending is commutative in the maths and not in the
        // clipping, so the brightest threads land last and stay bright.
        filaments.sort { $0.alpha < $1.alpha }

        return PreparedSky(stars: stars, filaments: filaments, size: size)
    }

    /// How strongly a filament is drawn.
    ///
    /// **`observed` and `inferred` differ by roughly three times.** He must be able to
    /// tell, from looking and without a key, which parts of what she knows are things he
    /// told her and which are things she worked out. That is one of the four success
    /// criteria for this feature, and the only mechanism it gets is this number and the
    /// missing core pass in the drawing.
    ///
    /// The weights were 0.62 and 0.22 and the first render is why they are not. The threads
    /// between the anchors are what make this a *constellation* rather than six separate
    /// clusters — they are the lines somebody drew between the stars — and at those values
    /// they were whispers nobody would notice was a whisper.
    ///
    /// **A thread between two anchors is drawn at full strength; one from an anchor to what
    /// orbits it is drawn at half.** Not a different kind of edge — the same edge, given
    /// less emphasis, because there are forty of them and they are all radial. At equal
    /// weight every cluster rendered as a dandelion and the lines across the sky lost to
    /// the spokes inside it, which is R1's hairball arriving by the side door.
    static func filamentAlpha(
        species: ConstellationSpecies,
        confidence: Double,
        haze: Double,
        betweenAnchors: Bool = true
    ) -> Double {
        let weight: Double = species == .observed ? 0.88 : 0.32
        return weight
            * (0.18 + 0.82 * confidence)
            * (0.30 + 0.70 * min(max(haze, 0), 1))
            * (betweenAnchors ? 1.0 : 0.5)
    }

    private func tint(for node: ConstellationNode) -> StarTint {
        if node.tier == .suppressed { return .dim }
        return node.kind == .person ? .warm : .cool
    }
}
