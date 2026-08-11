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
/// Named `Constellation*` rather than `Memory*` on purpose: the device-scoped read is
/// being built in parallel and will land its own types in SylKit. Two modules owning a
/// `MemoryNode` is an ambiguity the compiler resolves quietly and in whichever direction
/// it likes.
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
    var kind: MemoryNodeKind
    var tier: MemoryNodeTier
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
    var species: MemoryEdgeSpecies
    /// `0...1`, decaying asymptotically toward zero. It never arrives, which is why a
    /// filament fades rather than vanishing.
    var confidence: Double
}

/// The seven kinds in the graph.
enum MemoryNodeKind: String, Equatable, Sendable, CaseIterable {
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
enum MemoryNodeTier: String, Equatable, Sendable, CaseIterable {
    case hot
    case cold
    /// Not gone. The dimmest thing on the field — present if he goes looking, invisible
    /// when he is not. Constraint 6, drawn.
    case suppressed
}

/// He said it, or she worked it out.
enum MemoryEdgeSpecies: String, Equatable, Sendable, CaseIterable {
    case observed
    case inferred
}
