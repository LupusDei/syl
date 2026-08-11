import CoreGraphics
import Foundation

/// Where every star sits, and how bright and how far back it is.
///
/// **Position is a pure function of the node. Nothing here knows what time it is.** The
/// motion lives in ``ConstellationMotion`` and is added on top at draw time, which is the
/// whole architecture of this screen in one sentence: a star may drift *around* its
/// anchor and must never travel *to* a new one.
///
/// ## Why not a force simulation
///
/// Because a layout that settles while he watches is a layout that moved. A spring graph
/// puts the same memory somewhere different on every launch, which means the sky can
/// never be learned — and a sky you cannot learn is a picture, not a place.
///
/// ## The four rules
///
/// 1. **Anchors take slots.** People and goals land on a phyllotaxis field — the sunflower
///    packing — so they are evenly spread with no rows, no rings and no clumps. Which slot
///    is chosen comes from the node id, so it is the same slot forever.
/// 2. **An anchor's territory is half the way to its nearest neighbour.** Nothing that
///    orbits an anchor ever reaches past 45% of the distance to the next anchor, so two
///    clusters can never interpenetrate however many nodes arrive. It also self-regulates:
///    a crowded sky gets tight clusters, a sparse one gets generous ones.
/// 3. **Confidence is the orbit radius.** What she is sure of sits close in. Directly, with
///    no bands.
/// 4. **Tier is the depth band and age places within it.** Older sits further back, and the
///    age term is smaller than the gap between tiers, so a `cold` node can never sink
///    behind a `suppressed` one however old it gets.
struct ConstellationLayout: Sendable {
    /// The area the sky is drawn into.
    var size: CGSize

    /// Room at the top for the navigation bar and her title, and at the foot for the home
    /// indicator. A star tucked under a chrome element is a star he cannot see or touch.
    var topInset: CGFloat = 104
    var bottomInset: CGFloat = 72
    var sideInset: CGFloat = 46

    init(size: CGSize) {
        self.size = size
    }

    // MARK: - The field

    /// The ellipse anchors are scattered across, as a centre and two semi-axes.
    var field: (centre: CGPoint, rx: CGFloat, ry: CGFloat) {
        let rx = max(24, (size.width - sideInset * 2) / 2)
        let ry = max(24, (size.height - topInset - bottomInset) / 2)
        let centre = CGPoint(x: size.width / 2, y: topInset + ry)
        return (centre, rx, ry)
    }

    // MARK: - Slots

    /// How many places an anchor can stand: exactly as many as there are anchors.
    ///
    /// **This was a fixed twelve and the first render is why it is not.** A fixed field
    /// with seven anchors in it gives whichever seven slots the hashes happened to pick —
    /// which came back as a crowded vertical band with two thirds of the screen empty. A
    /// sunflower packing of *n* fills its disc evenly at every *n*, so sizing the field to
    /// the data makes the composition balanced by construction rather than by luck, and it
    /// gives every anchor a neighbour far enough away to have a cluster worth looking at.
    ///
    /// The cost is real and worth stating: learning a new person recomposes the sky. That
    /// is a different thing from a force simulation rearranging it on every launch — the
    /// picture changes when the graph does, which is what a picture of a graph should do,
    /// and it happens perhaps monthly against a field with holes in it every single day.
    static func slots(forAnchors count: Int) -> Int { max(1, count) }

    /// The golden angle. Consecutive slots are this far apart, which is what makes a
    /// sunflower packing even at every count rather than only at the ones that divide.
    private static let goldenAngle = Double.pi * (3 - 5.squareRoot())

    /// Slot `index` of `count`, in the unit disc.
    ///
    /// `sqrt` on the radius is not decoration: without it the slots crowd the centre,
    /// because area grows with the square of the radius.
    static func slotInUnitDisc(_ index: Int, of count: Int) -> CGPoint {
        let n = max(count, 1)
        // A lone anchor belongs in the middle, not at 0.7 of the way out on the one axis
        // the packing happens to start along.
        guard n > 1 else { return .zero }
        let r = ((Double(index) + 0.5) / Double(n)).squareRoot()
        let theta = Double(index) * goldenAngle
        return CGPoint(x: r * cos(theta), y: r * sin(theta))
    }

    /// How far an anchor may wander from its slot, as a fraction of the slot spacing.
    ///
    /// The jitter is what stops the field reading as the spiral it is underneath. Kept
    /// well under half the spacing so the separation floor survives it — see
    /// ``ConstellationLayoutTests``, which proves the floor over the whole slot set rather
    /// than sampling it.
    static let slotJitter = 0.15

    /// The widest an anchor's cluster may ever be, in points. The territory rule usually
    /// binds first; this stops a lone anchor from throwing its facts to the screen edge.
    static let maximumOrbit: Double = 92

    /// How near the nearest other anchor an orbit may reach.
    ///
    /// Under a half, so two clusters are separated by a tenth of the distance between
    /// their anchors no matter how many nodes either one holds.
    static let territoryFraction: Double = 0.45

    /// Angles available around an anchor. Prime, so successive laps do not line up into
    /// spokes.
    ///
    /// **Seven, not eleven, and the reason is the drift.** At eleven slots two neighbours in
    /// the same cluster came within eleven points of each other, and a star may hover by
    /// four — so at the worst moment two three-point cores would have been three points
    /// apart and read as one smeared star. Fewer angles is the cheap fix: it widens the
    /// gap far enough that no combination of `t` can close it.
    static let orbitSlots = 7

    // MARK: - Placement

    /// Every node's anchor position, keyed by id.
    ///
    /// Deterministic in the snapshot: the same nodes give the same points, in any order
    /// they arrive in, in any process, on any launch.
    ///
    /// Cost is O(nodes) plus O(anchors²) for the nearest-neighbour pass. Anchors are a
    /// handful by construction, and nothing here is quadratic in the node count — which is
    /// the mistake `syl-008` shipped into a transcript and paid for twice.
    func place(_ snapshot: ConstellationSnapshot) -> [String: ConstellationPlacement] {
        let anchorIds = Set(snapshot.nodes.filter { $0.isAnchor }.map(\.id))

        // A node whose anchor is not in this snapshot stands on its own rather than being
        // dropped. Nothing here is silently discarded.
        func isFreeStanding(_ node: ConstellationNode) -> Bool {
            node.isAnchor || node.anchorId.map { !anchorIds.contains($0) } ?? true
        }

        let anchors = snapshot.nodes.filter(isFreeStanding)
        let orbiters = snapshot.nodes.filter { !isFreeStanding($0) }

        var placements = placeAnchors(anchors)
        let territories = territories(for: anchors, placements: placements)

        var byAnchor: [String: [ConstellationNode]] = [:]
        for node in orbiters {
            guard let anchorId = node.anchorId else { continue }
            byAnchor[anchorId, default: []].append(node)
        }

        for (anchorId, group) in byAnchor {
            guard
                let anchor = placements[anchorId],
                let territory = territories[anchorId]
            else { continue }

            for placement in placeOrbiters(group, around: anchor, territory: territory) {
                placements[placement.id] = placement
            }
        }

        return placements
    }

    /// Anchors onto slots, by id, with collisions probed forward.
    ///
    /// Processing in ascending seed order is what makes the outcome independent of the
    /// order the nodes arrived in — and it means a newly learned person only ever displaces
    /// an anchor it actually collides with, rather than shifting the whole sky along by one.
    private func placeAnchors(_ anchors: [ConstellationNode]) -> [String: ConstellationPlacement] {
        let slotCount = Self.slots(forAnchors: anchors.count)
        let (centre, rx, ry) = field

        var taken = Set<Int>()
        var placements: [String: ConstellationPlacement] = [:]
        placements.reserveCapacity(anchors.count)

        for node in anchors.sorted(by: { ConstellationSeed.of($0.id) < ConstellationSeed.of($1.id) }) {
            let seed = ConstellationSeed.of(node.id)
            var slot = Int(Scatter.hash(seed) * Double(slotCount)) % slotCount
            while taken.contains(slot) { slot = (slot + 1) % slotCount }
            taken.insert(slot)

            let unit = Self.slotInUnitDisc(slot, of: slotCount)
            let spacing = Self.minimumSlotSpacing(of: slotCount)
            let jitterAngle = Scatter.hash(seed &* 7 &+ 1) * 2 * .pi
            let jitterAmount = Scatter.hash(seed &* 7 &+ 2) * Self.slotJitter * spacing

            let ux = unit.x + cos(jitterAngle) * jitterAmount
            let uy = unit.y + sin(jitterAngle) * jitterAmount

            placements[node.id] = ConstellationPlacement(
                id: node.id,
                point: CGPoint(x: centre.x + ux * rx, y: centre.y + uy * ry),
                seed: seed,
                isAnchor: true
            )
        }

        return placements
    }

    /// How far each anchor's cluster may reach: 45% of the way to the nearest other
    /// anchor, capped.
    private func territories(
        for anchors: [ConstellationNode],
        placements: [String: ConstellationPlacement]
    ) -> [String: Double] {
        let points = anchors.compactMap { placements[$0.id] }
        var result: [String: Double] = [:]

        for placement in points {
            var nearest = Double.greatestFiniteMagnitude
            for other in points where other.id != placement.id {
                nearest = min(nearest, hypot(
                    Double(other.point.x - placement.point.x),
                    Double(other.point.y - placement.point.y)
                ))
            }
            let allowed = nearest == .greatestFiniteMagnitude
                ? Self.maximumOrbit
                : min(Self.maximumOrbit, nearest * Self.territoryFraction)
            result[placement.id] = max(18, allowed)
        }

        return result
    }

    /// One anchor's orbiters, onto angle slots around it.
    ///
    /// The radius is confidence, straight: sure things sit close in. Once every angle is
    /// taken the next lap steps half a slot round and pulls in, so a heavily-known person
    /// gets a cluster with genuine structure rather than a ring that starts overwriting
    /// itself at eleven.
    private func placeOrbiters(
        _ nodes: [ConstellationNode],
        around anchor: ConstellationPlacement,
        territory: Double
    ) -> [ConstellationPlacement] {
        let step = 2 * Double.pi / Double(Self.orbitSlots)
        // Each anchor's ring starts at its own angle, so no two clusters show the same
        // spoke pattern.
        let phase = Scatter.hash(anchor.seed &* 13 &+ 5) * 2 * .pi

        var taken = Set<Int>()
        var placements: [ConstellationPlacement] = []
        placements.reserveCapacity(nodes.count)

        for node in nodes.sorted(by: { ConstellationSeed.of($0.id) < ConstellationSeed.of($1.id) }) {
            let seed = ConstellationSeed.of(node.id)
            var slot = Int(Scatter.hash(seed) * Double(Self.orbitSlots)) % Self.orbitSlots
            var lap = 0
            while taken.contains(lap * Self.orbitSlots + slot) {
                slot += 1
                if slot >= Self.orbitSlots {
                    slot = 0
                    lap += 1
                }
            }
            taken.insert(lap * Self.orbitSlots + slot)

            let jitter = (Scatter.hash(seed &* 7 &+ 3) - 0.5) * 2 * Self.orbitAngleJitter * step
            let angle = phase + Double(slot) * step + Double(lap) * step / 2 + jitter

            let fraction = Self.orbitFraction(confidence: node.confidence, lap: lap)
            let radius = territory * fraction

            placements.append(
                ConstellationPlacement(
                    id: node.id,
                    point: CGPoint(
                        x: anchor.point.x + CGFloat(cos(angle) * radius),
                        y: anchor.point.y + CGFloat(sin(angle) * radius)
                    ),
                    seed: seed,
                    isAnchor: false
                )
            )
        }

        return placements
    }

    /// How far an orbiter may wander from its angle slot, as a fraction of the slot.
    static let orbitAngleJitter = 0.15

    /// Confidence as a fraction of the territory. Certain is close; doubtful is far out.
    ///
    /// Never zero and never one: a fact at the anchor's own centre would be hidden by it,
    /// and one at the territory edge would touch the boundary the whole rule exists to
    /// keep clear.
    static func orbitFraction(confidence: Double, lap: Int) -> Double {
        let certainty = min(max(confidence, 0), 1)
        let base = 0.40 + 0.58 * (1 - certainty)
        return base * pow(0.82, Double(lap))
    }

    // MARK: - Brightness and depth

    /// Where a tier sits before age moves it. 1 is nearest the eye.
    ///
    /// The three are 0.34 apart and the age term below is worth at most 0.20, so the bands
    /// cannot cross. `suppressed` is not gone — it is the furthest and faintest thing on
    /// the field, which is constraint 6 drawn rather than described.
    static func tierDepth(_ tier: ConstellationTier) -> Double {
        switch tier {
        case .hot: return 1.00
        case .cold: return 0.66
        case .suppressed: return 0.32
        }
    }

    /// How much of a year of age costs in depth.
    static let ageDepthFalloff = 0.20

    /// A node's depth. 1 is nearest; 0 is as far back as this sky goes.
    static func depth(tier: ConstellationTier, learnedAt: Date?, now: Date) -> Double {
        let aged: Double
        if let learnedAt {
            let days = now.timeIntervalSince(learnedAt) / 86_400
            aged = min(max(days / 365, 0), 1)
        } else {
            aged = 0
        }
        return tierDepth(tier) - ageDepthFalloff * aged
    }

    /// How opaque a star is drawn.
    ///
    /// **Confidence, times how far away it is, and nothing else.** No thresholds, no
    /// buckets, no legend — a faint star is faint because the memory is faint. Quantising
    /// this into three visual classes would throw away the one property that makes this
    /// data worth drawing at all.
    ///
    /// The depth curve is superlinear so distance actually reads as haze rather than as a
    /// uniform dimming; the floors on both terms keep a nearly-decayed memory
    /// present-if-you-look rather than absent.
    ///
    /// **The depth floor was 0.20 with an exponent of 1.35, and the render is why it is
    /// not.** A whole cold cluster — a person she is less sure about, with old and
    /// suppressed things around him — came out as an empty quarter of the screen with two
    /// grey specks in it. That is not "faint because the memory is faint", it is gone, and
    /// gone is the one thing this system is never allowed to imply.
    static func alpha(confidence: Double, depth: Double) -> Double {
        let certainty = min(max(confidence, 0), 1)
        let far = min(max(depth, 0), 1)
        return (0.07 + 0.93 * certainty) * (0.28 + 0.72 * pow(far, 1.15))
    }

    /// The radius of a star's hot core, in points.
    static func coreRadius(confidence: Double, depth: Double, isAnchor: Bool) -> Double {
        let certainty = min(max(confidence, 0), 1)
        let far = min(max(depth, 0), 1)
        return (0.75 + 2.85 * certainty) * (0.62 + 0.38 * far) * (isAnchor ? 1.75 : 1.0)
    }

    // MARK: - Proof helpers

    /// The closest two slots of a phyllotaxis field of `count` ever get, in unit-disc
    /// units.
    ///
    /// Computed exhaustively rather than derived, because the closed form for sunflower
    /// packing is an approximation and this number is load-bearing: the separation floor
    /// the whole layout rests on is this, less the jitter, times the smaller semi-axis.
    static func minimumSlotSpacing(of count: Int) -> Double {
        guard count > 1 else { return 2 }
        var smallest = Double.greatestFiniteMagnitude
        for i in 0..<count {
            let a = slotInUnitDisc(i, of: count)
            for j in (i + 1)..<count {
                let b = slotInUnitDisc(j, of: count)
                smallest = min(smallest, hypot(Double(a.x - b.x), Double(a.y - b.y)))
            }
        }
        return smallest
    }
}

/// Where one node stands, before any motion is added.
struct ConstellationPlacement: Equatable, Sendable {
    var id: String
    /// The truth. Every tap tests against this, and every drift is measured from it.
    var point: CGPoint
    /// The node's stable seed, so brightness, motion and jitter all agree about which
    /// star this is without re-hashing the id at 24 frames a second.
    var seed: Int
    var isAnchor: Bool
}

/// A node id, as a number, identically in every process that ever runs.
///
/// **`String.hashValue` cannot be used here and the reason is a landmine.** Swift seeds
/// its string hashing per process, so `"person:dad".hashValue` is a different number every
/// launch — a sky seeded from it would rearrange itself every time he opened the app,
/// which is precisely the failure deterministic layout exists to prevent, and it would
/// pass every test in a single process.
///
/// FNV-1a instead: no seed, no state, and specified down to the byte.
enum ConstellationSeed {
    static func of(_ id: String) -> Int {
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        for byte in id.utf8 {
            hash ^= UInt64(byte)
            // The FNV-1a 64-bit prime, 0x100000001B3. Grouped from the right, because
            // grouping it from the left silently gives it a thirteenth digit — which is a
            // different hash that still passes for the empty string, and only for that.
            hash = hash &* 0x100_0000_01B3
        }
        // Positive and comfortably inside `Int`, because `Scatter.hash` multiplies its
        // argument and a wrapping negative would be harder to reason about than it is
        // worth.
        return Int(hash % 0x7FFF_FFFF)
    }
}
