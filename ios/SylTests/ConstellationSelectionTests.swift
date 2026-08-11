import CoreGraphics
import Foundation
import XCTest

@testable import Syl

/// **Selection is the graph answering, not a highlight** — and the card is what it answers
/// with.
///
/// Two things are being defended here. The first is that dimming the field is a *weight on
/// the light* and never a disappearance: brightness on this screen means confidence, so a
/// field that dropped to nothing when he touched something would be claiming, in the only
/// visual language the screen has, that everything he did not touch had been forgotten.
///
/// The second is what a card says. Provenance is the answer to the only question that
/// matters about a memory, and a filament's `reasoning` is the only place in the entire app
/// where the inference engine explains itself to him. Neither may be dropped, truncated or
/// rewritten on its way to the glass.
final class ConstellationSelectionTests: XCTestCase {
    private let phone = CGSize(width: 393, height: 852)

    private var sky: PreparedSky {
        SkyPreparer(now: ConstellationFixture.now).prepare(.fixture, size: phone)
    }

    private let british = Locale(identifier: "en_GB")

    // MARK: - What lights up

    func testShouldLeaveTheWholeSkyAtItsOwnBrightnessWhenNothingIsSelected() {
        let sky = sky
        let rest = ConstellationEmphasis(selecting: nil, in: sky)

        XCTAssertFalse(rest.isActive)
        for star in sky.stars { XCTAssertEqual(rest.weight(forStar: star.id, additive: true), 1) }
        for filament in sky.filaments { XCTAssertEqual(rest.weight(forFilament: filament.id, additive: true), 1) }
    }

    func testShouldLightEveryThreadTheTouchedStarIsPartOf() {
        let sky = sky
        let emphasis = ConstellationEmphasis(selecting: .star("person.kate"), in: sky)

        let expected = Set(
            sky.filaments
                .filter { $0.fromId == "person.kate" || $0.toId == "person.kate" }
                .map(\.id))

        XCTAssertFalse(expected.isEmpty, "the fixture star has no threads to light")
        XCTAssertEqual(emphasis.litFilaments, expected)
        for id in expected {
            XCTAssertGreaterThan(emphasis.weight(forFilament: id, additive: true), 1)
        }
    }

    /// A lit thread running into a dimmed star reads as broken, so the far ends hold their
    /// own brightness instead of joining the field that recedes.
    func testShouldHoldTheFarEndOfEveryLitThreadAtItsOwnBrightness() {
        let sky = sky
        let emphasis = ConstellationEmphasis(selecting: .star("person.kate"), in: sky)

        for filament in sky.filaments where emphasis.litFilaments.contains(filament.id) {
            XCTAssertGreaterThanOrEqual(
                emphasis.weight(forStar: filament.fromId, additive: true), 1,
                "\(filament.id) runs into a dimmed star at its from end")
            XCTAssertGreaterThanOrEqual(
                emphasis.weight(forStar: filament.toId, additive: true), 1,
                "\(filament.id) runs into a dimmed star at its to end")
        }
    }

    /// A thread's subject is the pair it relates, so both ends stay lit.
    func testShouldLightBothEndsOfATouchedFilament() {
        let sky = sky
        let filament = try! XCTUnwrap(sky.filaments.first { $0.id == "e.kate.mandarin" })
        let emphasis = ConstellationEmphasis(selecting: .filament(filament.id), in: sky)

        XCTAssertEqual(emphasis.litStars, [filament.fromId, filament.toId])
        XCTAssertGreaterThan(emphasis.weight(forFilament: filament.id, additive: true), 1)
        XCTAssertEqual(emphasis.weight(forStar: filament.fromId, additive: true), 1)
    }

    /// **Dimmed, never hidden.**
    ///
    /// The one that matters, as arithmetic rather than as a promise: with a selection
    /// active, the faintest star and the faintest thread in the sky are both still above the
    /// threshold the drawing skips at. On a screen where faint already means *she barely
    /// holds this*, a receded field that vanished would be saying the wrong thing in the
    /// only language it has.
    func testShouldRecedeTheRestOfTheSkyWithoutEverHidingIt() {
        let sky = sky
        let emphasis = ConstellationEmphasis(selecting: .star("person.dad"), in: sky)

        for additive in [true, false] {
            for star in sky.stars where emphasis.weight(forStar: star.id, additive: additive) < 1 {
                XCTAssertGreaterThan(
                    star.alpha * emphasis.weight(forStar: star.id, additive: additive)
                        * (1 - ConstellationMotion.breathDepth),
                    PreparedSky.faintestDrawn,
                    "\(star.id) disappears when something else is touched")
            }

            for filament in sky.filaments
            where emphasis.weight(forFilament: filament.id, additive: additive) < 1 {
                XCTAssertGreaterThan(
                    filament.alpha * emphasis.weight(forFilament: filament.id, additive: additive),
                    PreparedSky.faintestDrawn,
                    "\(filament.id) disappears when something else is touched")
            }
        }
    }

    /// **Ink recedes less than light does, and the daylight render is why.**
    ///
    /// Against near-black a quarter of the light is still light. Against the pale veil a
    /// quarter of the *ink* is nothing at all: the first daylight card came back as a
    /// beautiful card floating over a blank page, with the entire rest of the sky gone. It
    /// is the same asymmetry `luminance` and `warmth` each document and each had to be
    /// corrected for once — there is nothing for a wash to add to on white paper.
    ///
    /// The threshold in the test above cannot catch this, because it is the *drawing's*
    /// threshold and a 0.04 star clears it while being invisible to a human being. So the
    /// rule is asserted as a rule.
    func testShouldRecedeLessWhenTheSkyIsDrawnAsPigment() {
        XCTAssertGreaterThan(
            ConstellationEmphasis.recede(additive: false),
            ConstellationEmphasis.recede(additive: true) * 1.5,
            "the light appearance dims as hard as the dark one, and its sky will vanish")

        // And it is still unmistakably a recession rather than a no-op.
        XCTAssertLessThan(ConstellationEmphasis.recede(additive: false), 0.75)

        let sky = sky
        let emphasis = ConstellationEmphasis(selecting: .star("person.dad"), in: sky)
        let untouched = try! XCTUnwrap(sky.stars.first { $0.id == "goal.novel" })
        XCTAssertGreaterThan(
            emphasis.weight(forStar: untouched.id, additive: false),
            emphasis.weight(forStar: untouched.id, additive: true))
    }

    /// The touched thing is unmistakably the brightest, and the gap is real rather than a
    /// rounding difference.
    func testShouldMakeTheTouchedThingClearlyTheBrightest() {
        XCTAssertGreaterThan(
            ConstellationEmphasis.touched / ConstellationEmphasis.receded, 5)
        XCTAssertGreaterThan(
            ConstellationEmphasis.touchedFilament / ConstellationEmphasis.receded, 5)
        XCTAssertGreaterThan(ConstellationEmphasis.receded, 0, "the field went out entirely")
    }

    /// **A selection this sky no longer contains is not a selection.**
    ///
    /// A refresh between the tap and the next frame can drop the star he touched. Keeping
    /// the id would dim the whole field in answer to a question about something that is not
    /// there any more.
    func testShouldLeaveTheSkyAloneWhenTheSelectionIsNoLongerInIt() {
        let sky = sky
        for hit in [ConstellationHit.star("gone"), .filament("also gone")] {
            let emphasis = ConstellationEmphasis(selecting: hit, in: sky)
            XCTAssertFalse(emphasis.isActive)
            XCTAssertEqual(emphasis.weight(forStar: "person.dad", additive: true), 1)
            XCTAssertEqual(emphasis.weight(forFilament: "e.kate.dad", additive: true), 1)
        }
    }

    func testShouldFindNoSubjectForAThingTheSkyHasLost() {
        XCTAssertNil(sky.subject(for: .star("gone")))
        XCTAssertNil(sky.subject(for: .filament("gone")))
        XCTAssertNotNil(sky.subject(for: .star("person.dad")))
    }

    // MARK: - What the card says about a star

    /// Provenance, in her register rather than as a field with a value after it.
    func testShouldSayWhoToldHerWhenSomebodyDid() {
        XCTAssertEqual(
            ConstellationWords.provenance(species: .observed, assertedBy: "Dad"),
            "Dad said so.")
        XCTAssertEqual(
            ConstellationWords.provenance(species: .observed, assertedBy: nil),
            "She was told this.")
    }

    func testShouldSayShePutItTogetherWhenSheDid() {
        XCTAssertEqual(
            ConstellationWords.provenance(species: .inferred, assertedBy: nil),
            "She worked this out.")
    }

    /// **Not an error, and not silence.** Silence would let the card imply she was told.
    func testShouldSayWhenNothingYetSaysWhereAMemoryCameFrom() {
        let sentence = ConstellationWords.provenance(species: .unattested, assertedBy: nil)
        XCTAssertEqual(sentence, "Nothing yet says where this came from.")
        XCTAssertFalse(sentence.lowercased().contains("error"))
        XCTAssertFalse(sentence.lowercased().contains("unknown"))
    }

    /// **Nothing on this card may ever imply something was destroyed.**
    ///
    /// Constraint 6 is a property of the store and this is the easiest surface in the app to
    /// break it on by accident — *gone*, *removed*, *empty* and a bare zero all read as
    /// deleted, and none of them is true. Confidence decays asymptotically toward zero and
    /// never arrives.
    func testShouldNeverSayAMemoryWasDestroyed() {
        let forbidden = ["deleted", "removed", "gone", "erased", "discarded", "lost"]

        for step in 0...200 {
            let confidence = Double(step) / 200
            let sentence = ConstellationWords.certainty(confidence).lowercased()
            for word in forbidden {
                XCTAssertFalse(
                    sentence.contains(word),
                    "at \(confidence) the card says '\(sentence)'")
            }
        }

        XCTAssertTrue(
            ConstellationWords.certainty(0.01).contains("not been forgotten"),
            "the faintest memory must be told it has not been forgotten")
    }

    /// It says something different at every strength, or it is not saying anything.
    func testShouldTellCertaintiesApart() {
        let said = Set((0...100).map { ConstellationWords.certainty(Double($0) / 100) })
        XCTAssertGreaterThanOrEqual(said.count, 4)
        XCTAssertNotEqual(
            ConstellationWords.certainty(0.99), ConstellationWords.certainty(0.2))
    }

    func testShouldSayWhenSheLearnedSomething() {
        let date = ConstellationFixture.day("2026-02-02")
        let sentence = try! XCTUnwrap(ConstellationWords.learned(date, locale: british))
        XCTAssertTrue(sentence.hasPrefix("Learned "))
        XCTAssertTrue(sentence.contains("2026"))
        XCTAssertNil(ConstellationWords.learned(nil, locale: british))
    }

    // MARK: - What the card says about a filament

    /// **Her reasoning, verbatim.** Not truncated, not summarised, not turned into a field.
    func testShouldCarryEveryInferredFilamentsReasoningThroughUnchanged() {
        let sky = sky
        let snapshot = ConstellationSnapshot.fixture
        var checked = 0

        for filament in sky.filaments {
            let edge = try! XCTUnwrap(snapshot.edges.first { $0.id == filament.id })
            XCTAssertEqual(filament.detail.reasoning, edge.reasoning, "\(filament.id)")
            if filament.species == .inferred, let reasoning = edge.reasoning {
                XCTAssertEqual(filament.detail.reasoning, reasoning)
                checked += 1
            }
        }

        XCTAssertGreaterThan(checked, 5, "the fixture has almost no reasoning to carry")
    }

    /// An observation has no reasoning, and the card must not invent one.
    func testShouldGiveAnObservedFilamentNoReasoningAtAll() {
        let sky = sky
        let observed = try! XCTUnwrap(sky.filaments.first { $0.id == "e.kate.dad" })
        XCTAssertEqual(observed.species, .observed)
        XCTAssertNil(observed.detail.reasoning)
        XCTAssertEqual(ConstellationWords.origin(of: .observed), "She was told this.")
        XCTAssertEqual(ConstellationWords.origin(of: .inferred), "She worked this out.")
    }

    /// **Labels, not ids.** An id on this card would be a debug field on the one surface
    /// that is meant to sound like her.
    func testShouldNameWhatAFilamentRelatesByLabel() {
        let sky = sky
        let filament = try! XCTUnwrap(sky.filaments.first { $0.id == "e.kate.mandarin" })

        XCTAssertEqual(filament.detail.fromLabel, "Kate")
        XCTAssertEqual(filament.detail.toLabel, "Learn Mandarin")
        XCTAssertFalse(filament.detail.fromLabel.contains("person."))
    }

    /// Her word for the relation, only unpicked from the casing the graph stores it in.
    func testShouldUnpickARelationWithoutRewritingIt() {
        XCTAssertEqual(ConstellationWords.relation("set_it_down_for"), "set it down for")
        XCTAssertEqual(ConstellationWords.relation("knows"), "knows")
        XCTAssertEqual(ConstellationWords.relation(""), "relates to")
        XCTAssertEqual(ConstellationWords.relation("   "), "relates to")
    }

    /// Confidence reaches the card as the decayed number it actually is.
    func testShouldCarryAFilamentsOwnConfidenceToTheCard() {
        let sky = sky
        let filament = try! XCTUnwrap(sky.filaments.first { $0.id == "e.strong.novel" })
        XCTAssertEqual(filament.detail.confidence, 0.19, accuracy: 1e-9)
        XCTAssertEqual(
            ConstellationWords.certainty(filament.detail.confidence),
            ConstellationWords.certainty(0.19))
    }

    // MARK: - Provenance reaches the star's card

    func testShouldCarryAStarsProvenanceThroughToItsCard() {
        let sky = sky
        let worked = try! XCTUnwrap(sky.stars.first { $0.id == "memory.dad.workshop" })
        XCTAssertEqual(worked.detail.species, .inferred)
        XCTAssertNotNil(worked.detail.reasoning)
        XCTAssertNotNil(worked.detail.body)

        let told = try! XCTUnwrap(sky.stars.first { $0.id == "fact.dad.knee" })
        XCTAssertEqual(told.detail.species, .observed)
        XCTAssertEqual(told.detail.assertedBy, "Dad")

        let nothing = try! XCTUnwrap(sky.stars.first { $0.id == "source.marcus.email" })
        XCTAssertEqual(nothing.detail.species, .unattested)
        XCTAssertNil(nothing.detail.assertedBy)
    }

    /// Every star has *something* to say, or touching it was a dead end.
    func testShouldGiveEveryStarACardWithSomethingOnIt() {
        for star in sky.stars {
            XCTAssertFalse(star.label.isEmpty, "\(star.id) has no words")
            XCTAssertFalse(
                ConstellationWords.provenance(
                    species: star.detail.species, assertedBy: star.detail.assertedBy
                ).isEmpty)
        }
    }

    // MARK: - Said out loud

    /// **A `Canvas` is invisible to VoiceOver**, so every star needs a label that says what
    /// it is rather than where it is.
    func testShouldGiveEveryStarASpokenLabelThatSaysWhatItIs() {
        for star in sky.stars {
            let spoken = ConstellationWords.spoken(for: star)
            XCTAssertTrue(spoken.contains(star.label), "\(star.id) is not named aloud")
            XCTAssertTrue(
                spoken.contains(
                    ConstellationWords.provenance(
                        species: star.detail.species, assertedBy: star.detail.assertedBy)),
                "\(star.id) does not say where it came from")
            XCTAssertFalse(spoken.contains(star.id), "the label reads out an id")
        }
    }

    func testShouldGiveEveryFilamentASpokenLabelThatSaysWhatItRelates() {
        for filament in sky.filaments {
            let spoken = ConstellationWords.spoken(for: filament)
            XCTAssertTrue(spoken.contains(filament.detail.fromLabel))
            XCTAssertTrue(spoken.contains(filament.detail.toLabel))
            XCTAssertTrue(spoken.contains(ConstellationWords.origin(of: filament.species)))
            XCTAssertFalse(spoken.contains(filament.id), "the label reads out an id")
        }
    }

    /// A sighted user learns there is more by watching a card rise. This is the same promise
    /// made in words — and it names her reasoning specifically, because that is the one
    /// thing on this screen worth going and getting.
    func testShouldTellAVoiceOverUserThatHerReasoningIsBehindTheTap() {
        XCTAssertTrue(
            ConstellationWords.hint(for: ConstellationSpecies.inferred)
                .lowercased().contains("reasoning"))
        XCTAssertFalse(
            ConstellationWords.hint(for: ConstellationSpecies.observed)
                .lowercased().contains("reasoning"))
        XCTAssertTrue(
            ConstellationWords.hint(for: ConstellationStarSpecies.inferred)
                .lowercased().contains("why"))
    }

    // MARK: - A thing is not its own evidence

    /// **The hub must not cite itself.**
    ///
    /// The Commander's graph hangs entirely off one `source` node called *"Conversation with
    /// the Commander"*, and that node asserts everything — including itself. So its card read
    /// *"Conversation with the Commander"* in the title and *"Conversation with the Commander
    /// said so."* underneath: redundant, and slightly absurd.
    func testShouldNotHaveAStarCiteItselfAsItsOwnSource() {
        let hub = "Conversation with the Commander"
        let sentence = ConstellationWords.provenance(
            species: .observed, assertedBy: hub, describing: hub)

        XCTAssertFalse(
            sentence.contains(hub),
            "a star whose asserter is itself must not repeat its own title back at him")
        XCTAssertFalse(sentence.isEmpty, "and it must still say what the node is")
    }

    /// The other half, or the rule would silently swallow every real attribution.
    func testShouldStillNameTheSourceWhenSomethingElseAssertedIt() {
        XCTAssertEqual(
            ConstellationWords.provenance(
                species: .observed, assertedBy: "Conversation with the Commander",
                describing: "Lives in Buda, TX"),
            "Conversation with the Commander said so.")
    }

    /// And it holds through the whole prepared sky, which is where the card actually reads it.
    func testShouldNotCiteItselfAnywhereInHisOwnSky() {
        let sky = SkyPreparer(now: ConstellationFixture.now)
            .prepare(.hubAndSpokes, size: phone, chrome: .phone)

        for star in sky.stars {
            let sentence = ConstellationWords.provenance(
                species: star.detail.species, assertedBy: star.detail.assertedBy,
                describing: star.label)
            XCTAssertFalse(
                sentence.contains(star.label),
                "\(star.id) cites itself: \(sentence)")
        }
    }
}
