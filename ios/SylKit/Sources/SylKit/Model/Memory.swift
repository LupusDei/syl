import Foundation

/// The memory graph, as the phone reads it.
///
/// One endpoint — `GET /memory/constellation` — and the types it hands back. This
/// is deliberately not the admin's `GET /memory/graph`, which carries node seeds,
/// edge budgets and a window of dream nights: those are instrument controls for
/// judging the inferred engine, and the phone has no controls to turn.
///
/// ## Three things here will look like they could be simplified, and cannot
///
/// 1. **`MemoryStarProvenance.species` is not `MemoryEdgeSpecies`.** It has a
///    third case, `unattested`, which is what a star with no filaments in the
///    region is. Reusing the edge enum would force a `nil` and lose the
///    distinction between *she has no idea where this came from* and *this is not
///    connected to anything*.
/// 2. **`confidence` and `inferredConfidence` are different numbers.**
///    `confidence` is the decayed weight — what the connection is worth now, and
///    the only one defined for both species. `inferredConfidence` is how sure
///    reflection was when it drew the edge, and it does not decay. Folding them
///    together would average two things that mean different things.
/// 3. **`tier` is depth, never a filter.** `cold` and `suppressed` are drawn
///    further back and dimmer. Neither means deleted: nodes are superseded and
///    edges demoted. A client that hides them has contradicted the store.

/// What a star IS. Effectively immutable per node — a person does not become an event.
public enum MemoryNodeKind: String, Codable, Equatable, Sendable, CaseIterable {

    case fact, memory, person, source, event, goal, decision, place, instruction
    /// `self_` because `self` is a Swift keyword. The wire value is `"self"`.
    case self_ = "self"

    /// A kind this build has never heard of. Never sent, only received.
    ///
    /// **`syl-025`, and it is `syl-020` again in a different enum.** `MemoryNode.kind`
    /// is non-optional, so an unrecognised value used to fail the decode of the node,
    /// which fails the array, which fails the whole page — not one row skipped, the
    /// screen. The contract had been four migrations behind the store's vocabulary
    /// before anyone noticed, because nothing tested parity and no node of a new kind
    /// had reached a device yet.
    ///
    /// "Keep the list complete" is not a property that survives two release trains: the
    /// app and the service ship independently, so either can be ahead. The list is kept
    /// current anyway — it is just no longer load-bearing.
    case unrecognised

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = MemoryNodeKind(rawValue: raw) ?? .unrecognised
    }
}

/// Depth. **None of the three means deleted** — see this file's header.
public enum MemoryTier: String, Codable, Equatable, Sendable, CaseIterable {
    case hot, cold, suppressed
}

/// `observed` is something he said. `inferred` is something she worked out.
public enum MemoryEdgeSpecies: String, Codable, Equatable, Sendable, CaseIterable {
    case observed, inferred
}

/// How a star came to be known, including the case where nothing says.
public enum MemoryStarSpecies: String, Codable, Equatable, Sendable, CaseIterable {
    case observed, inferred
    /// Not a third species of edge — it is a star nothing connects to.
    case unattested
}

/// Where a star came from. The answer to the only question that matters about a memory.
public struct MemoryStarProvenance: Codable, Equatable, Sendable {
    public let species: MemoryStarSpecies
    /// WHO said so, by label rather than id. `nil` unless `observed`.
    public let assertedBy: String?
    /// WHY she believes it, in her words. `nil` unless `inferred`.
    public let reasoning: String?
    /// When the belief behind it was last touched. `nil` when `unattested`.
    public let learnedAt: Date?

    public init(
        species: MemoryStarSpecies,
        assertedBy: String?,
        reasoning: String?,
        learnedAt: Date?
    ) {
        self.species = species
        self.assertedBy = assertedBy
        self.reasoning = reasoning
        self.learnedAt = learnedAt
    }

    private enum CodingKeys: String, CodingKey {
        case species, assertedBy, reasoning, learnedAt
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        species = try container.decode(MemoryStarSpecies.self, forKey: .species)
        assertedBy = try container.decodeRequiredNullable(String.self, forKey: .assertedBy)
        reasoning = try container.decodeRequiredNullable(String.self, forKey: .reasoning)
        learnedAt = try container.decodeRequiredNullable(Date.self, forKey: .learnedAt)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(species, forKey: .species)
        try container.encodeRequiredNullable(assertedBy, forKey: .assertedBy)
        try container.encodeRequiredNullable(reasoning, forKey: .reasoning)
        try container.encodeRequiredNullable(learnedAt, forKey: .learnedAt)
    }
}

/// One thing she knows. A star: brightness is `confidence`, depth is `tier`.
public struct MemoryStar: Codable, Equatable, Sendable, Identifiable {
    public let id: SylID
    public let kind: MemoryNodeKind
    public let tier: MemoryTier
    public let label: String
    public let body: String?
    /// Brightness, in (0, 1]. The strongest filament touching this star — a
    /// maximum, so one strong live connection is not dimmed by dead ones beside
    /// it. Never zero: decay approaches zero and never arrives.
    public let confidence: Double
    public let provenance: MemoryStarProvenance
    /// Whether the sky is built around this one. People and goals are anchors.
    public let anchor: Bool
    /// The anchor this star orbits. `nil` on an anchor, and on a star connected
    /// to no anchor. Computed by the server, because the honest rule needs the
    /// decayed weights — see the contract.
    public let anchorId: SylID?
    public let createdAt: Date
    public let updatedAt: Date

    public init(
        id: SylID,
        kind: MemoryNodeKind,
        tier: MemoryTier,
        label: String,
        body: String?,
        confidence: Double,
        provenance: MemoryStarProvenance,
        anchor: Bool,
        anchorId: SylID?,
        createdAt: Date,
        updatedAt: Date
    ) {
        self.id = id
        self.kind = kind
        self.tier = tier
        self.label = label
        self.body = body
        self.confidence = confidence
        self.provenance = provenance
        self.anchor = anchor
        self.anchorId = anchorId
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    private enum CodingKeys: String, CodingKey {
        case id, kind, tier, label, body, confidence, provenance, anchor, anchorId
        case createdAt, updatedAt
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(SylID.self, forKey: .id)
        kind = try container.decode(MemoryNodeKind.self, forKey: .kind)
        tier = try container.decode(MemoryTier.self, forKey: .tier)
        label = try container.decode(String.self, forKey: .label)
        body = try container.decodeRequiredNullable(String.self, forKey: .body)
        confidence = try container.decode(Double.self, forKey: .confidence)
        provenance = try container.decode(MemoryStarProvenance.self, forKey: .provenance)
        anchor = try container.decode(Bool.self, forKey: .anchor)
        anchorId = try container.decodeRequiredNullable(SylID.self, forKey: .anchorId)
        createdAt = try container.decode(Date.self, forKey: .createdAt)
        updatedAt = try container.decode(Date.self, forKey: .updatedAt)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(kind, forKey: .kind)
        try container.encode(tier, forKey: .tier)
        try container.encode(label, forKey: .label)
        try container.encodeRequiredNullable(body, forKey: .body)
        try container.encode(confidence, forKey: .confidence)
        try container.encode(provenance, forKey: .provenance)
        try container.encode(anchor, forKey: .anchor)
        try container.encodeRequiredNullable(anchorId, forKey: .anchorId)
        try container.encode(createdAt, forKey: .createdAt)
        try container.encode(updatedAt, forKey: .updatedAt)
    }
}

/// One connection. Both endpoints are always present in `stars` — a filament into
/// a star that is not drawn is a line into nothing.
public struct MemoryFilament: Codable, Equatable, Sendable, Identifiable {
    public let id: SylID
    public let from: SylID
    public let to: SylID
    public let relation: String
    public let species: MemoryEdgeSpecies
    public let tier: MemoryTier
    /// What this connection is worth NOW, after decay, in (0, 1].
    public let confidence: Double
    /// How sure reflection was when it drew this. `nil` on an observation, and it
    /// **does not decay** — a different number from `confidence`, not a copy.
    public let inferredConfidence: Double?
    public let reasoning: String?
    public let assertedBy: SylID?
    public let lastTouchedAt: Date

    public init(
        id: SylID,
        from: SylID,
        to: SylID,
        relation: String,
        species: MemoryEdgeSpecies,
        tier: MemoryTier,
        confidence: Double,
        inferredConfidence: Double?,
        reasoning: String?,
        assertedBy: SylID?,
        lastTouchedAt: Date
    ) {
        self.id = id
        self.from = from
        self.to = to
        self.relation = relation
        self.species = species
        self.tier = tier
        self.confidence = confidence
        self.inferredConfidence = inferredConfidence
        self.reasoning = reasoning
        self.assertedBy = assertedBy
        self.lastTouchedAt = lastTouchedAt
    }

    private enum CodingKeys: String, CodingKey {
        case id, from, to, relation, species, tier, confidence, inferredConfidence
        case reasoning, assertedBy, lastTouchedAt
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(SylID.self, forKey: .id)
        from = try container.decode(SylID.self, forKey: .from)
        to = try container.decode(SylID.self, forKey: .to)
        relation = try container.decode(String.self, forKey: .relation)
        species = try container.decode(MemoryEdgeSpecies.self, forKey: .species)
        tier = try container.decode(MemoryTier.self, forKey: .tier)
        confidence = try container.decode(Double.self, forKey: .confidence)
        inferredConfidence = try container.decodeRequiredNullable(
            Double.self, forKey: .inferredConfidence
        )
        reasoning = try container.decodeRequiredNullable(String.self, forKey: .reasoning)
        assertedBy = try container.decodeRequiredNullable(SylID.self, forKey: .assertedBy)
        lastTouchedAt = try container.decode(Date.self, forKey: .lastTouchedAt)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(from, forKey: .from)
        try container.encode(to, forKey: .to)
        try container.encode(relation, forKey: .relation)
        try container.encode(species, forKey: .species)
        try container.encode(tier, forKey: .tier)
        try container.encode(confidence, forKey: .confidence)
        try container.encodeRequiredNullable(inferredConfidence, forKey: .inferredConfidence)
        try container.encodeRequiredNullable(reasoning, forKey: .reasoning)
        try container.encodeRequiredNullable(assertedBy, forKey: .assertedBy)
        try container.encode(lastTouchedAt, forKey: .lastTouchedAt)
    }
}

/// What this response is NOT, in numbers and in words.
///
/// There is deliberately no total. A count of what the graph holds is a dashboard
/// statistic, and this surface answers *is this all of it?* without answering
/// *how much is there?* — which is the question nobody asked.
public struct MemoryConstellationBound: Codable, Equatable, Sendable {
    /// The most stars this response would have carried.
    public let stars: Int
    public let starsReturned: Int
    public let filamentsReturned: Int
    /// Whether the walk stopped with candidates still waiting. **Exact, not a
    /// guess** — the server sets it when a star is refused, never by comparing
    /// `starsReturned` to `stars`. Those differ exactly when the region is a
    /// whole multiple of the budget, which is the one moment the shortcut lies.
    public let mayHaveMore: Bool
    public let explanation: String

    public init(
        stars: Int,
        starsReturned: Int,
        filamentsReturned: Int,
        mayHaveMore: Bool,
        explanation: String
    ) {
        self.stars = stars
        self.starsReturned = starsReturned
        self.filamentsReturned = filamentsReturned
        self.mayHaveMore = mayHaveMore
        self.explanation = explanation
    }
}

/// A bounded region of the memory graph, at one instant.
public struct MemoryConstellation: Codable, Equatable, Sendable {
    public let generatedAt: Date
    public let bound: MemoryConstellationBound
    public let stars: [MemoryStar]
    public let filaments: [MemoryFilament]

    public init(
        generatedAt: Date,
        bound: MemoryConstellationBound,
        stars: [MemoryStar],
        filaments: [MemoryFilament]
    ) {
        self.generatedAt = generatedAt
        self.bound = bound
        self.stars = stars
        self.filaments = filaments
    }
}
