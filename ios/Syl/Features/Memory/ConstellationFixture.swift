import Foundation

/// A sky worth looking at, before there is one to read.
///
/// The device-scoped read is being built in parallel, and this feature's acceptance is
/// **aesthetic** — it cannot be settled by a green suite, only by rendering it and looking.
/// So the sky gets a cast now: seven anchors and thirty-odd things she has learned about
/// them, at every confidence from certain to nearly forgotten and every tier from hot to
/// suppressed, because a fixture where everything is bright proves nothing about the one
/// property the whole design rests on.
///
/// The cast is the same life the goals previews already describe — the novel, the fifty-
/// year-old body, the boat his father taught him on. One product, one person, whichever
/// screen you are looking at.
///
/// Not gated behind `DEBUG`, exactly as `HomeSnapshot.preview` is not: previews and the
/// render harness both need it, and a fixture that vanishes from a Release build is a
/// fixture whose Release build was never compiled.
enum ConstellationFixture {
    /// The instant the fixture is read at, so ages — and therefore depths — are stable.
    static let now: Date = day("2026-08-10")

    static func day(_ iso: String) -> Date {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.date(from: iso) ?? Date(timeIntervalSinceReferenceDate: 0)
    }
}

extension ConstellationSnapshot {
    /// The rich sky. Seven anchors, thirty-one orbiting them, forty-one threads.
    static let fixture: ConstellationSnapshot = {
        /// One star. `told` is what he said; `worked` is what she put together, and it
        /// carries her reasoning — which is the field the whole detail card exists for, so
        /// a fixture without any would render a card that proved nothing.
        func node(
            _ id: String, _ kind: ConstellationKind, _ tier: ConstellationTier,
            _ confidence: Double, _ label: String, _ anchor: String? = nil,
            _ learned: String? = nil,
            body: String? = nil,
            told: String? = "You",
            worked: String? = nil,
            unattested: Bool = false
        ) -> ConstellationNode {
            let learnedAt = learned.map(ConstellationFixture.day)
            let provenance: ConstellationProvenance
            if unattested {
                provenance = .unattested
            } else if let worked {
                provenance = ConstellationProvenance(
                    species: .inferred, reasoning: worked, learnedAt: learnedAt)
            } else {
                provenance = ConstellationProvenance(
                    species: .observed, assertedBy: told, learnedAt: learnedAt)
            }

            return ConstellationNode(
                id: id, kind: kind, tier: tier, confidence: confidence, label: label,
                anchorId: anchor, learnedAt: learnedAt, body: body, provenance: provenance
            )
        }

        let nodes: [ConstellationNode] = [
            // MARK: The people
            node("person.dad", .person, .hot, 1.00, "Dad", nil, "2026-01-04"),
            node("person.kate", .person, .hot, 0.96, "Kate", nil, "2026-01-04"),
            node("person.marcus", .person, .cold, 0.71, "Marcus", nil, "2026-02-18"),

            // MARK: The goals
            node("goal.strong", .goal, .hot, 0.94, "Be strong at fifty", nil, "2026-01-01"),
            node("goal.novel", .goal, .hot, 0.88, "Finish the novel", nil, "2026-01-01"),
            node("goal.sail", .goal, .cold, 0.64, "Learn to sail", nil, "2026-05-20"),
            node("goal.mandarin", .goal, .suppressed, 0.38, "Learn Mandarin", nil, "2026-01-15"),

            // MARK: Around Dad
            node("fact.dad.boat", .fact, .hot, 0.93, "Taught him to sail on the lake",
                 "person.dad", "2026-01-06"),
            node("memory.dad.workshop", .memory, .hot, 0.81,
                 "The workshop bench they built together", "person.dad", "2026-02-02",
                 body: "Two weekends in February, and the vice is still his father's.",
                 worked: "He mentions the bench whenever he is deciding something, and it is "
                    + "always the same weekend he is describing. I have taken it to matter "
                    + "more than a bench usually does."),
            node("fact.dad.birthday", .fact, .hot, 0.99, "Birthday is the ninth of March",
                 "person.dad", "2026-01-06"),
            node("event.dad.call", .event, .cold, 0.58, "They spoke on Sunday, for an hour",
                 "person.dad", "2026-06-14"),
            node("fact.dad.knee", .fact, .cold, 0.44, "His knee has been bad since the spring",
                 "person.dad", "2026-04-11", told: "Dad"),
            node("memory.dad.silence", .memory, .suppressed, 0.19,
                 "They did not speak for most of a year", "person.dad", "2025-03-20"),

            // MARK: Around Kate
            node("fact.kate.cello", .fact, .hot, 0.97, "Plays the cello, badly and happily",
                 "person.kate", "2026-01-09"),
            node("fact.kate.coffee", .fact, .hot, 0.90, "Takes her coffee black, after ten",
                 "person.kate", "2026-01-22"),
            node("memory.kate.trip", .memory, .cold, 0.66, "The trip they did not take",
                 "person.kate", "2026-03-30",
                 worked: "Booked in March and never spoken of since. He changed the subject "
                    + "twice, so I have kept it and stopped raising it."),
            node("decision.kate.mandarin", .decision, .cold, 0.61,
                 "They agreed to stop the lessons", "person.kate", "2026-04-02",
                 worked: "The Mandarin hour and the cello hour were the same hour."),
            node("event.kate.recital", .event, .hot, 0.86, "Her recital is in November",
                 "person.kate", "2026-07-28"),
            node("fact.kate.allergy", .fact, .cold, 0.52, "Cannot be near lilies",
                 "person.kate", "2026-02-14"),
            node("memory.kate.first", .memory, .suppressed, 0.27, "A quarrel about the move",
                 "person.kate", "2025-06-01"),

            // MARK: Around Marcus
            node("fact.marcus.work", .fact, .cold, 0.69, "Runs the studio on Ninth",
                 "person.marcus", "2026-02-19"),
            node("event.marcus.dinner", .event, .cold, 0.47, "Dinner, postponed twice",
                 "person.marcus", "2026-05-02"),
            // The one star nothing attests. Present, drawn, and honest about it — the card
            // says nothing yet says where it came from, which is a fact about the graph and
            // not an error state.
            node("source.marcus.email", .source, .suppressed, 0.22, "An old thread about the lease",
                 "person.marcus", "2025-09-12", unattested: true),

            // MARK: Around being strong at fifty
            node("fact.strong.deadlift", .fact, .hot, 0.95, "Deadlifts five by five at 145",
                 "goal.strong", "2026-06-20"),
            node("event.strong.swim", .event, .hot, 0.83, "Swims two thousand on Thursdays",
                 "goal.strong", "2026-07-02"),
            node("fact.strong.physio", .fact, .cold, 0.55, "The physio is still not booked",
                 "goal.strong", "2026-05-30"),
            node("decision.strong.why", .decision, .hot, 0.91,
                 "The fifty-year-old gets what the forty-one-year-old sends him",
                 "goal.strong", "2026-01-01",
                 worked: "He has said a version of this three times now, each time about a "
                    + "different decision. It is the reason under the goal rather than the "
                    + "goal itself."),
            node("memory.strong.shoes", .memory, .cold, 0.41, "The shoes he keeps not replacing",
                 "goal.strong", "2026-03-15",
                 worked: "Mentioned in March and again in June, both times as an aside."),

            // MARK: Around the novel
            node("fact.novel.act", .fact, .hot, 0.89, "The second act was cut, in January",
                 "goal.novel", "2026-01-30"),
            node("memory.novel.four", .memory, .cold, 0.63, "It has been four years",
                 "goal.novel", "2026-01-01"),
            node("source.novel.draft", .source, .cold, 0.57, "The draft, last touched in March",
                 "goal.novel", "2026-03-02"),
            node("decision.novel.morning", .decision, .cold, 0.49,
                 "Writing moved to the mornings", "goal.novel", "2026-02-08"),
            node("fact.novel.stall", .fact, .suppressed, 0.24, "Chapter eleven, twice abandoned",
                 "goal.novel", "2025-11-04"),

            // MARK: Around the boat
            node("memory.sail.lake", .memory, .cold, 0.72, "The lake, and the summer of it",
                 "goal.sail", "2026-05-20"),
            node("fact.sail.since", .fact, .cold, 0.60, "He has not been out since",
                 "goal.sail", "2026-05-20"),
            node("source.sail.club", .source, .suppressed, 0.31, "The club's joining page",
                 "goal.sail", "2026-05-21"),

            // MARK: Around the Mandarin he set down
            node("decision.mandarin.stop", .decision, .suppressed, 0.35,
                 "Set down, for the cello hour", "goal.mandarin", "2026-04-02"),
            node("fact.mandarin.hsk", .fact, .suppressed, 0.29, "Finished HSK 1 in February",
                 "goal.mandarin", "2026-02-01"),
            node("memory.mandarin.trip", .memory, .suppressed, 0.17, "It was for a trip",
                 "goal.mandarin", "2026-01-15"),
        ]

        func edge(
            _ id: String, _ from: String, _ to: String, _ species: ConstellationSpecies,
            _ confidence: Double, _ relation: String, _ reasoning: String? = nil,
            _ touched: String? = nil
        ) -> ConstellationEdge {
            ConstellationEdge(
                id: id, from: from, to: to, species: species, confidence: confidence,
                relation: relation, reasoning: reasoning,
                touchedAt: touched.map(ConstellationFixture.day))
        }

        /// The graph's own word for what a thread is, in the graph's own casing.
        ///
        /// `snake_case` on purpose: the card unpicks it and shows nothing else, so a fixture
        /// written in tidy prose would never exercise the one transformation the relation
        /// ever gets — and would quietly hide the day the server starts sending
        /// `asserted_about`.
        func relation(for kind: ConstellationKind) -> String {
            switch kind {
            case .fact: return "asserted_about"
            case .memory: return "remembered_about"
            case .event: return "happened_with"
            case .decision: return "decided_for"
            case .source: return "documents"
            case .person, .goal: return "relates_to"
            }
        }

        // Every orbiter is threaded to what it orbits, at its own confidence. Facts he
        // stated are `observed`; the ones she put together are `inferred`, and the
        // difference has to be visible without a key. The thread's provenance is the
        // star's — she does not conclude a connection to something she was told about.
        var edges: [ConstellationEdge] = nodes.compactMap { node in
            guard let anchorId = node.anchorId else { return nil }
            let inferred = node.provenance.species == .inferred
            return ConstellationEdge(
                id: "e.\(node.id)",
                from: node.id,
                to: anchorId,
                species: inferred ? .inferred : .observed,
                confidence: node.confidence,
                relation: relation(for: node.kind),
                reasoning: node.provenance.reasoning,
                touchedAt: node.learnedAt
            )
        }

        // And the threads between the anchors — the ones that make it a constellation
        // rather than seven separate clusters. These are the connections she drew, and the
        // inferred ones carry the only thing in this system that is her *thinking* rather
        // than her records.
        edges += [
            edge("e.dad.sail", "person.dad", "goal.sail", .observed, 0.88, "taught_him",
                 nil, "2026-05-20"),
            edge("e.kate.mandarin", "person.kate", "goal.mandarin", .inferred, 0.54,
                 "set_it_down_for",
                 "The Mandarin hour and the cello hour are the same hour on a Tuesday, and "
                    + "the lessons stopped in the same week her recital was announced. I do "
                    + "not think he chose against Mandarin. I think he chose Kate.",
                 "2026-04-02"),
            edge("e.kate.novel", "person.kate", "goal.novel", .inferred, 0.37, "reads_it",
                 "She is the only person he has shown a chapter to, and he described her "
                    + "note about the second act before he described the cut.",
                 "2026-01-30"),
            edge("e.dad.strong", "person.dad", "goal.strong", .inferred, 0.44, "is_the_reason",
                 "The goal is named for an age, and his father's knee went at about the "
                    + "same one. He has never connected the two out loud.",
                 "2026-05-30"),
            edge("e.marcus.novel", "person.marcus", "goal.novel", .inferred, 0.26,
                 "might_publish_it",
                 "Marcus runs a studio and the dinner has been postponed twice, both times "
                    + "in weeks he was writing. This one is thin and I am holding it "
                    + "loosely.",
                 "2026-05-02"),
            edge("e.strong.novel", "goal.strong", "goal.novel", .inferred, 0.19,
                 "competes_with",
                 "The mornings went to the novel and the swim went to Thursdays. They are "
                    + "the same hours, and one of them keeps losing.",
                 "2026-02-08"),
            edge("e.kate.dad", "person.kate", "person.dad", .observed, 0.79, "knows",
                 nil, "2026-03-09"),
        ]

        return ConstellationSnapshot(
            nodes: nodes, edges: edges, capturedAt: ConstellationFixture.now)
    }()
}
