import Foundation

/// Everything a card says about one star, beyond how it is drawn.
///
/// Separate from ``ConstellationNode`` because the node is *the graph* and this is *what is
/// said about it*. The drawing needs six numbers; the card needs her words and where they
/// came from, and neither should have to carry the other's fields to a `Canvas` that runs
/// twenty-four times a second.
struct ConstellationStarDetail: Equatable, Sendable {
    /// Her longer words for it, when there are any. The label is the sentence; this is the
    /// paragraph.
    var body: String?
    var kind: ConstellationKind
    var tier: ConstellationTier
    /// Whether he told her, she worked it out, or nothing says.
    var species: ConstellationStarSpecies
    /// Who said so, by name. Nil unless `observed`.
    var assertedBy: String?
    /// Why she believes it, **in her words**. Nil unless `inferred`.
    var reasoning: String?
    /// When the belief behind it was last touched. Nil when `unattested`.
    var learnedAt: Date?

    /// What a star carries when the graph says nothing about where it came from. Honest,
    /// and not the same as an empty card.
    static let unknown = ConstellationStarDetail(
        body: nil, kind: .fact, tier: .hot, species: .unattested,
        assertedBy: nil, reasoning: nil, learnedAt: nil)
}

/// Everything a card says about one filament.
///
/// **`reasoning` is the most interesting field in this app.** It is the only place the
/// inference engine ever explains itself to him, and it is the reason edges are selectable
/// at all — the Commander's own addition, and the better call.
struct ConstellationFilamentDetail: Equatable, Sendable {
    /// The relation, in the graph's own word. Shown as she stored it, only unpicked from
    /// `snake_case` — a client that rewrote her vocabulary would be describing a different
    /// graph from the one she reasons over.
    var relation: String
    /// What it relates. Labels rather than ids: an id on this card would be a debug field.
    var fromLabel: String
    var toLabel: String
    /// What the connection is worth **now**, after decay.
    var confidence: Double
    /// Her thinking, verbatim. Nil on an observation.
    var reasoning: String?
    /// When it was last touched.
    var touchedAt: Date?

    static let unknown = ConstellationFilamentDetail(
        relation: "", fromLabel: "", toLabel: "", confidence: 0, reasoning: nil, touchedAt: nil)
}

/// What she says about a star or a filament, in her voice rather than in fields.
///
/// Pure functions returning strings, so the card and the VoiceOver labels are the *same*
/// sentences rather than two independent renderings that drift apart — which is how a screen
/// ends up reading correctly and sounding like a database.
///
/// ## Nothing here may ever imply something was destroyed
///
/// Constraint 6 is a property of the store, and this is the surface where it is easiest to
/// break by accident: "gone", "removed", "empty", even a bare "0%" all say *deleted* to a
/// reader, and none of them is true. Confidence decays asymptotically toward zero and never
/// arrives. So the faintest phrasing available here says *faded*, and says out loud that
/// fading is not forgetting.
enum ConstellationWords {

    // MARK: - How strongly she holds it

    /// Confidence, as something a person would say.
    ///
    /// **Words rather than a number or a bar.** A percentage on this card is an instrument
    /// reading, and the admin is where instruments live; a bar is a percentage with a
    /// rectangle around it. What he actually wants to know is whether she is sure, and
    /// "she is certain of this" answers it in the register the rest of her writing uses.
    static func certainty(_ confidence: Double) -> String {
        switch confidence {
        case 0.85...: return "She is certain of this."
        case 0.60..<0.85: return "She holds this firmly."
        case 0.35..<0.60: return "She holds this loosely."
        case 0.15..<0.35: return "This has begun to fade."
        default: return "This has faded almost to nothing. It has not been forgotten."
        }
    }

    // MARK: - When

    /// When she learned it, or nil if nothing says.
    ///
    /// The locale is a parameter with the sane default rather than a hidden read of
    /// `Locale.current`, so a test pins it and gets the same sentence on every machine.
    static func learned(_ date: Date?, locale: Locale = .autoupdatingCurrent) -> String? {
        guard let date else { return nil }
        return "Learned \(day(date, locale: locale))."
    }

    /// When the connection was last touched, or nil.
    static func touched(_ date: Date?, locale: Locale = .autoupdatingCurrent) -> String? {
        guard let date else { return nil }
        return "Last touched \(day(date, locale: locale))."
    }

    private static func day(_ date: Date, locale: Locale) -> String {
        date.formatted(
            Date.FormatStyle(date: .abbreviated, time: .omitted, locale: locale))
    }

    // MARK: - Where it came from

    /// Provenance, as a sentence. **The only question that matters about a memory.**
    static func provenance(species: ConstellationStarSpecies, assertedBy: String?) -> String {
        switch species {
        case .observed:
            if let assertedBy, !assertedBy.isEmpty { return "\(assertedBy) said so." }
            return "She was told this."
        case .inferred:
            return "She worked this out."
        case .unattested:
            // Not "unknown source", which sounds like an error, and not silence, which
            // would let the card imply she was told. Nothing connects to it yet; that is a
            // fact about the graph and he is entitled to it.
            return "Nothing yet says where this came from."
        }
    }

    /// Whether she was told a connection or drew it.
    static func origin(of species: ConstellationSpecies) -> String {
        species == .observed ? "She was told this." : "She worked this out."
    }

    // MARK: - What a thing is

    /// A relation as she stored it, only unpicked from `snake_case`.
    static func relation(_ raw: String) -> String {
        let unpicked = raw.replacingOccurrences(of: "_", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return unpicked.isEmpty ? "relates to" : unpicked
    }

    /// What kind of thing a star is, for the caption and for VoiceOver.
    static func kind(_ kind: ConstellationKind) -> String {
        switch kind {
        case .fact: return "Fact"
        case .memory: return "Memory"
        case .person: return "Person"
        case .source: return "Source"
        case .event: return "Event"
        case .goal: return "Goal"
        case .decision: return "Decision"
        }
    }

    /// How far back a star sits — and **not one of these means deleted.**
    static func tier(_ tier: ConstellationTier) -> String {
        switch tier {
        case .hot: return "Close at hand"
        case .cold: return "Further back"
        case .suppressed: return "Set aside, not forgotten"
        }
    }

    // MARK: - Said out loud

    /// A star, for VoiceOver.
    ///
    /// Her words for it first, because that is what it *is*; then what kind of thing and how
    /// far back it sits; then how strongly she holds it, where it came from, and when. Built
    /// from the **same functions the card sets in type**, because two independent renderings
    /// of one fact drift apart — and then the screen reads correctly and sounds like a
    /// database.
    static func spoken(for star: PreparedStar) -> String {
        var parts = [
            star.label,
            "\(kind(star.detail.kind)), \(tier(star.detail.tier).lowercased()).",
            certainty(star.confidence),
            provenance(species: star.detail.species, assertedBy: star.detail.assertedBy),
        ]
        if let learned = learned(star.detail.learnedAt) { parts.append(learned) }
        return parts.joined(separator: " ")
    }

    /// A filament, for VoiceOver. What it relates, in the graph's own word for the relation.
    static func spoken(for filament: PreparedFilament) -> String {
        let detail = filament.detail
        return [
            "\(detail.fromLabel), \(relation(detail.relation)), \(detail.toLabel).",
            origin(of: filament.species),
            certainty(detail.confidence),
        ].joined(separator: " ")
    }

    /// What lies behind the tap. **Named specifically when it is her reasoning**, because
    /// that is the one thing on this screen worth going and getting — and a hint that said
    /// only "shows details" would hide it from the one person who cannot see the card rise.
    static func hint(for species: ConstellationStarSpecies) -> String {
        species == .inferred ? "Read why she thinks this" : "Read where this came from"
    }

    static func hint(for species: ConstellationSpecies) -> String {
        species == .inferred ? "Read her reasoning" : "Read what she was told"
    }
}
