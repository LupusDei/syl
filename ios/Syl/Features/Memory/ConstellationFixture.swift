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

    /// A day before ``now``. Everything in ``ConstellationSnapshot/hubAndSpokes`` was learned
    /// within a day, which is why his sky is bright.
    static let yesterday: Date = day("2026-08-09")

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
            case .place: return "located_at"
            case .instruction: return "instructed_by"
            case .selfNode: return "concerns"
            case .unrecognised: return "relates_to"
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

    /// **The Commander's actual sky, in shape.** Thirty-three stars, one hub, thirty-two
    /// identical threads, and not one relation between two things she knows.
    ///
    /// ## Why this exists beside ``fixture``
    ///
    /// Everything this feature was accepted on was looked at through ``fixture``, which has
    /// seven anchors, real entity-to-entity edges and six clusters. **His graph has none of
    /// that.** Measured off `~/.syl/syl.db` on 2026-08-11: 33 nodes — 17 `fact`, 8 `goal`,
    /// 6 `person`, 1 `decision`, 1 `source` — and 32 edges, every single one `stated` /
    /// `observed`, every single one from the one source node *"Conversation with the
    /// Commander"* to one of the other 32.
    ///
    /// Two consequences follow and neither is visible in ``fixture``:
    ///
    /// 1. **Nothing orbits anything.** `anchorId` is computed on the server as the far end of
    ///    the strongest filament *whose far end is an anchor*, and the far end of every
    ///    filament here is the source — which is not an anchor kind. So every star comes back
    ///    with `anchorId: nil`, every star is free-standing, and the phyllotaxis field is
    ///    asked for thirty-three slots instead of seven. There are no clusters at all.
    /// 2. **The hub is a star with thirty-two threads on it**, which is the only structure
    ///    the picture has.
    ///
    /// A fixture is a correspondence check — it is the project's standing rule that they come
    /// from captured reality rather than from our own types — and the whole of the trouble on
    /// this screen lived in the gap between the two shapes. The labels are written fresh
    /// rather than copied: what has to match is the shape, the kinds, the counts, the ages and
    /// the confidences, and none of his private prose belongs in a checked-in file.
    ///
    /// Confidences are the decay law's own answer for edges a day old at a 21-day half-life,
    /// which is why they are all near one: his sky is bright because his memories are new.
    static let hubAndSpokes: ConstellationSnapshot = {
        let hub = "source.conversation"

        /// One star off the hub. Everything is `hot`, everything was learned within a day,
        /// and nothing orbits anything — exactly as the wire delivers it.
        func spoke(
            _ id: String, _ kind: ConstellationKind, _ confidence: Double, _ label: String,
            _ body: String
        ) -> ConstellationNode {
            ConstellationNode(
                id: id, kind: kind, tier: .hot, confidence: confidence, label: label,
                anchorId: nil, learnedAt: ConstellationFixture.yesterday, body: body,
                provenance: ConstellationProvenance(
                    species: .observed,
                    assertedBy: "Conversation with the Commander",
                    learnedAt: ConstellationFixture.yesterday))
        }

        var nodes: [ConstellationNode] = [
            // The hub. A `source` node: bookkeeping about where things came from, not
            // something she knows about him. It cites itself as its own provenance, which is
            // the reason `ConstellationWords` has a case for it.
            ConstellationNode(
                id: hub, kind: .source, tier: .hot, confidence: 1.0,
                label: "Conversation with the Commander",
                anchorId: nil, learnedAt: ConstellationFixture.yesterday, body: nil,
                provenance: ConstellationProvenance(
                    species: .observed, assertedBy: "Conversation with the Commander",
                    learnedAt: ConstellationFixture.yesterday))
        ]

        nodes += [
            spoke("person.him", .person, 0.981, "Justin Martin",
                  "An engineering leader and entrepreneur, and the person this whole graph is about."),
            spoke("person.wife", .person, 0.981, "Ela — his wife",
                  "His wife, a yogi, and the other half of every decision in here."),
            spoke("person.daughter", .person, 0.981, "Isla — his daughter",
                  "His daughter, born in November, and the reason several of the goals have dates."),
            spoke("person.son", .person, 0.981, "Rowan — his son",
                  "His son, born in December, energetic in the way that is its own weather."),
            spoke("person.father", .person, 0.987, "Robert C. Martin — his father",
                  "His father, who taught the discipline the video series is about."),
            spoke("person.wife.wants", .person, 0.986, "Ela, on the move",
                  "She wants somewhere to come back to, which is a different goal from his."),

            spoke("goal.company", .goal, 0.984, "Make the company a huge success",
                  "The goal every working hour is spent against."),
            spoke("goal.compound", .goal, 0.984, "A family compound",
                  "Land, eventually, with the whole family on it."),
            spoke("goal.debt", .goal, 0.986, "Get out of debt",
                  "His stated first priority, ahead of everything that costs money."),
            spoke("goal.build", .goal, 0.986, "Build in Tennessee",
                  "His parents would buy the land and the build would follow."),
            spoke("goal.series", .goal, 0.987, "A video series with his dad",
                  "On agentic discipline, recorded in the gaps of a working week."),
            spoke("goal.tennessee", .goal, 0.987, "The Tennessee possibility",
                  "Weighed rather than decided, and still open."),
            spoke("goal.weight", .goal, 0.990, "Get back to 185 pounds",
                  "About thirty pounds, and he has said the number twice."),
            spoke("goal.enterprise", .goal, 0.994, "An enterprise identity solution",
                  "Outlined against a competitor he named."),

            spoke("fact.role", .fact, 0.981, "Head of engineering",
                  "He runs engineering at the startup."),
            spoke("fact.home", .fact, 0.981, "Lives outside Austin",
                  "He and his family live just south of the city."),
            spoke("fact.company", .fact, 0.981, "The company prevents fraud in private markets",
                  "What it is for, in his own words."),
            spoke("fact.method", .fact, 0.981, "Identity and bank account verification",
                  "How the product actually works."),
            spoke("fact.reminders", .fact, 0.981, "Wants unprompted practical reminders",
                  "He values the ones that arrive before he asks."),
            spoke("fact.leaving", .fact, 0.986, "Reasons for leaving the state",
                  "Taxes, opportunity, and the direction of travel."),
            spoke("fact.debt", .fact, 0.986, "Currently in debt",
                  "He says major purchases are out of reach until it is cleared."),
            spoke("fact.house", .fact, 0.986, "The house",
                  "Owned, and expected to carry part of the next move."),
            spoke("fact.debtshape", .fact, 0.986, "The shape of the debt",
                  "A mortgage, a car loan, and one large balance behind both."),
            spoke("fact.treasurer", .fact, 0.986, "An agent holds his financial state",
                  "The numbers live somewhere other than his head."),
            spoke("fact.commute", .fact, 0.987, "Records scenes during his commute",
                  "The series is filmed in a car, on purpose."),
            spoke("fact.times", .fact, 0.987, "Daily commute times",
                  "Out at a quarter to nine, back between five and six."),
            spoke("fact.parents", .fact, 0.987, "His parents have seen the land",
                  "Twice, and they came back in favour."),
            spoke("fact.partnership", .fact, 0.990, "How he and his wife run the week",
                  "A standing arrangement, and it is the reason the days have a shape."),
            spoke("fact.tasks", .fact, 0.990, "Daily tasks he sets for his wife",
                  "Most mornings, against her own goals rather than his."),
            spoke("fact.competitor", .fact, 0.994, "The competitor",
                  "In some ways a competitor to what he is building."),
            spoke("fact.avatar", .fact, 0.999, "Preferred avatar expression",
                  "He liked the earnest one and found the other one wrong."),

            spoke("decision.foundation", .decision, 0.986,
                  "Won't build a family foundation in a declining state",
                  "The decision under the move, stated once and clearly."),
        ]

        // **Every edge is the same edge.** Hub to star, `stated`, `observed`, near enough to
        // one because none of them is a day old. There is not a single connection between two
        // things she knows about him — which is the whole point of this fixture.
        let edges: [ConstellationEdge] = nodes.dropFirst().map { node in
            ConstellationEdge(
                id: "e.\(node.id)",
                from: hub,
                to: node.id,
                species: .observed,
                confidence: node.confidence,
                relation: "stated",
                reasoning: nil,
                touchedAt: ConstellationFixture.yesterday)
        }

        return ConstellationSnapshot(
            nodes: nodes, edges: edges, capturedAt: ConstellationFixture.now)
    }()
}
