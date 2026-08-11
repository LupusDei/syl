import Foundation

/// What she remembers, in the shape a sky needs.
///
/// ## Why this is not the SylKit model
///
/// The service's memory graph is built for an instrument: seeds, edge budgets, dream
/// nights, feedback. The constellation needs seven fields and no opinions, and it needs
/// them as a value it can be handed in a preview, a test or a render with no store, no
/// network and no object graph behind it. That is the same split `HomeSnapshot` and
/// `GoalListSnapshot` already make, and it is what lets the one screen in this project
/// whose acceptance is *aesthetic* be looked at before its transport exists.
///
/// ## Named `Constellation*` rather than `Memory*`, and that turned out to be load-bearing
///
/// The device-scoped read was built in parallel and landed `MemoryStar`, `MemoryFilament`,
/// `MemoryConstellation`, `MemoryNodeKind`, `MemoryTier` and `MemoryEdgeSpecies` in SylKit
/// while this was being drawn. Three of these types were first written as `MemoryNodeKind`,
/// `MemoryNodeTier` and `MemoryEdgeSpecies` — two of which collide exactly.
///
/// A same-named type in the app module and in an imported one does not fail to build. It
/// *shadows*, silently, and whichever one a file gets depends on what it imports — which
/// is the worst possible failure mode for the adapter that will convert between them. So
/// everything here carries the `Constellation` prefix without exception, and the SylKit
/// names are left alone.
struct ConstellationSnapshot: Equatable, Sendable {
    var nodes: [ConstellationNode] = []
    var edges: [ConstellationEdge] = []
    /// When the graph was read. Nil until anything has been.
    var capturedAt: Date?

    static let empty = ConstellationSnapshot()

    var isEmpty: Bool { nodes.isEmpty }
}

/// One thing she knows.
struct ConstellationNode: Equatable, Sendable, Identifiable {
    /// The node's id in the graph — and the seed for everything about how it is drawn.
    ///
    /// It must be stable across launches, or the sky rearranges itself, which is the one
    /// failure the whole layout exists to avoid.
    var id: String
    var kind: ConstellationKind
    var tier: ConstellationTier
    /// `0...1`. Brightness **is** this number; nothing quantises it.
    var confidence: Double
    /// Her words for it. Unused by the drawing, and carried anyway — the card and the
    /// accessibility pass in later phases both need it, and a snapshot that had to be
    /// re-fetched to say what a star *is* would make those phases a transport change.
    var label: String
    /// The person or goal this orbits. Nil for the anchors themselves.
    var anchorId: String?
    /// When she learned it. Depth is age, so nil reads as brand new.
    var learnedAt: Date?
    /// Her longer words, when there are any. The label is the sentence; this is the
    /// paragraph.
    var body: String?
    /// Where it came from. **The answer to the only question that matters about a memory**,
    /// and the whole content of the card the star opens.
    var provenance: ConstellationProvenance = .unattested

    /// Whether this node holds a position of its own rather than orbiting one.
    ///
    /// People and goals, and only those: they are the few nodes he actually thinks in
    /// terms of.
    var isAnchor: Bool { kind.isAnchor }
}

/// A line she drew between two things.
struct ConstellationEdge: Equatable, Sendable, Identifiable {
    var id: String
    var from: String
    var to: String
    var species: ConstellationSpecies
    /// `0...1`, decaying asymptotically toward zero. It never arrives, which is why a
    /// filament fades rather than vanishing.
    var confidence: Double
    /// What this connection *is*, in the graph's own word. Kept verbatim: a client that
    /// rewrote her vocabulary would be describing a different graph from the one she
    /// reasons over.
    var relation: String = ""
    /// Why she drew it, in her words. Nil on an observation.
    ///
    /// **The most interesting field in the graph.** It is the only place the inference
    /// engine ever explains itself to him, and it is why edges are selectable at all.
    var reasoning: String?
    /// When it was last touched.
    var touchedAt: Date?
}

/// How a star came to be known, **including the case where nothing says**.
///
/// Not ``ConstellationSpecies`` with a third case bolted on: an edge is always one or the
/// other, and a star with no filaments in this region is neither. Folding them together
/// would force a `nil` and lose the difference between *she has no idea where this came
/// from* and *this is not connected to anything*.
enum ConstellationStarSpecies: String, Equatable, Sendable, CaseIterable {
    case observed
    case inferred
    /// A star nothing connects to. Present, drawn, and honest about it.
    case unattested
}

/// Where a star came from.
struct ConstellationProvenance: Equatable, Sendable {
    var species: ConstellationStarSpecies = .unattested
    /// Who said so, by name rather than by id. Nil unless `observed`.
    var assertedBy: String?
    /// Why she believes it, in her words. Nil unless `inferred`.
    var reasoning: String?
    /// When the belief behind it was last touched. Nil when `unattested`, which is why
    /// depth is taken from the node's own `learnedAt` and never from this.
    var learnedAt: Date?

    /// Nothing says. The honest default, and the state of every star the read has not
    /// found a filament for.
    static let unattested = ConstellationProvenance()
}

/// The seven kinds in the graph.
enum ConstellationKind: String, Equatable, Sendable, CaseIterable {
    case fact
    case memory
    case person
    case source
    case event
    case goal
    case decision

    /// People and goals hold the sky up. Everything else orbits one of them.
    var isAnchor: Bool {
        switch self {
        case .person, .goal: return true
        case .fact, .memory, .source, .event, .decision: return false
        }
    }
}

/// How far back a node sits.
enum ConstellationTier: String, Equatable, Sendable, CaseIterable {
    case hot
    case cold
    /// Not gone. The dimmest thing on the field — present if he goes looking, invisible
    /// when he is not. Constraint 6, drawn.
    case suppressed
}

/// He said it, or she worked it out.
enum ConstellationSpecies: String, Equatable, Sendable, CaseIterable {
    case observed
    case inferred
}
