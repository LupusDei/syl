import Foundation

/// What lights up when he touches something. **The graph answering, not a highlight.**
///
/// A selection highlight is a ring drawn around a thing to say *this one*. That is a
/// control-panel idea, and on this screen it would be the only piece of user interface in a
/// field that has deliberately refused a filter bar, a legend and a count.
///
/// What happens instead is the sky reacting: the thing he touched burns brighter, every
/// thread it is part of catches light, the things at the far ends of those threads stay as
/// they were — and *everything else recedes*. Nothing is added to the drawing and nothing is
/// removed from it. The same stars are in the same places at the same instant of the same
/// hover; only the weight of the light has moved, which is the one language this screen
/// already speaks. **Brightness means confidence here, so borrowing it for attention is a
/// real cost** — and it is worth paying because it is spent for one touch at a time, and
/// because the alternative is drawing a rectangle on a night sky.
///
/// Computed once when the selection changes, never per frame. It is a set membership test
/// inside a function that runs twenty-four times a second, and the `Canvas` is handed a
/// finished value here exactly as it is handed a finished ``PreparedSky``.
struct ConstellationEmphasis: Equatable, Sendable {
    /// What he touched. Nil means nothing is selected and the sky is at rest.
    var selection: ConstellationHit?
    /// The selected star, plus every star at the far end of one of its threads. A lit
    /// filament running into a dimmed star reads as broken, so the neighbours hold their
    /// own brightness rather than joining the field that recedes.
    var litStars: Set<String> = []
    /// Every filament the selection is an end of, or is.
    var litFilaments: Set<String> = []

    /// The sky at rest.
    static let none = ConstellationEmphasis()

    var isActive: Bool { selection != nil }

    init() {}

    /// Work out what a selection lights.
    ///
    /// One pass over the filaments. The sky is a few dozen stars and a few dozen threads by
    /// construction — a region, never the whole graph — so this is genuinely linear and
    /// nothing here builds an adjacency table that would have to be kept in step with one.
    init(selecting hit: ConstellationHit?, in sky: PreparedSky) {
        guard let hit else { return }

        switch hit {
        case .star(let id):
            // **A selection this sky does not contain is not a selection.** A refresh
            // between the tap and the next frame can drop the star he touched, and an
            // emphasis that kept the id would dim the entire sky with nothing lit — the
            // whole field receded in answer to a question about something that is no longer
            // there. The card handles the same case by not appearing; this is its half.
            guard sky.stars.contains(where: { $0.id == id }) else { return }
            selection = hit
            litStars.insert(id)
            for filament in sky.filaments {
                if filament.fromId == id {
                    litFilaments.insert(filament.id)
                    litStars.insert(filament.toId)
                } else if filament.toId == id {
                    litFilaments.insert(filament.id)
                    litStars.insert(filament.fromId)
                }
            }

        case .filament(let id):
            guard let filament = sky.filaments.first(where: { $0.id == id }) else { return }
            selection = hit
            litFilaments.insert(id)
            // A thread's subject is the two things it relates, so both ends hold their
            // light. It is the one selection where the *pair* is the answer.
            litStars.insert(filament.fromId)
            litStars.insert(filament.toId)
        }
    }

    // MARK: - Weights

    /// How much brighter or dimmer a star is drawn.
    ///
    /// `additive` is the appearance — see ``recede(additive:)`` for why receding is the one
    /// number here that has to know.
    func weight(forStar id: String, additive: Bool) -> Double {
        guard isActive else { return 1 }
        if selection == .star(id) { return Self.touched }
        if litStars.contains(id) { return 1 }
        return Self.recede(additive: additive)
    }

    /// How much brighter or dimmer a filament is drawn.
    func weight(forFilament id: String, additive: Bool) -> Double {
        guard isActive else { return 1 }
        if selection == .filament(id) { return Self.touchedFilament }
        if litFilaments.contains(id) { return Self.lit }
        return Self.recede(additive: additive)
    }

    /// The dimmest the touched thing may be drawn, whatever its own confidence.
    ///
    /// **A multiplier alone is not enough, and the render is why.** The first pass lit a
    /// selection by weight only, and touching the thread between Kate and the Mandarin she
    /// set down — an inferred edge, at half confidence, running into a suppressed goal —
    /// produced a line barely brighter than the ones receding around it. Three separate
    /// factors were multiplying it toward nothing before the weight ever arrived, and every
    /// one of them was correct: that is what the edge *is worth*.
    ///
    /// So the answer to a touch has a floor. It is spent on **one** thing at a time and it
    /// does not lie about anything, because the card that rose beside it says *she holds
    /// this loosely* in words. Brightness is confidence everywhere on this screen except on
    /// the single object he is pointing at, where it is attention — and a selection that
    /// cannot be seen is not a selection, it is a shrug.
    func floor(forStar id: String) -> Double {
        selection == .star(id) ? Self.touchedFloor : 0
    }

    func floor(forFilament id: String) -> Double {
        if selection == .filament(id) { return Self.touchedFloor }
        // A lit thread has to actually light. The faintest inferred edges in a real graph
        // sit around a tenth, and two doublings of a tenth is still a whisper.
        return litFilaments.contains(id) ? Self.litFloor : 0
    }

    static let touchedFloor: Double = 0.90
    static let litFloor: Double = 0.42

    /// Whether a star should be drawn larger than its confidence alone earns.
    ///
    /// Only the one he touched, and only a little. A star that doubles in size on selection
    /// is a button pressing itself.
    func swell(forStar id: String) -> Double {
        selection == .star(id) ? 1.32 : 1
    }

    /// The thing he touched. Brighter, and capped at full white by the drawing.
    static let touched: Double = 1.75

    /// A filament he touched directly. Higher than a star's because a gossamer inferred
    /// thread starts from roughly a third of an observed one's brightness, and a weight that
    /// lit them equally would leave the faintest ones still looking unselected.
    static let touchedFilament: Double = 2.9

    /// A thread the selection is an end of.
    static let lit: Double = 2.1

    /// Everything he did not touch, drawn as **emitted light**.
    ///
    /// **Dimmed, never hidden.** A quarter is far enough that the answer is unmistakable and
    /// near enough that the sky is still a sky behind it — and it matters here more than it
    /// would anywhere else, because on this screen faint already means *she barely holds
    /// this*. A field that dropped to nothing would be claiming, in the only visual language
    /// this screen has, that everything he did not touch had been forgotten.
    static let receded: Double = 0.26

    /// Everything he did not touch, drawn as **pigment**.
    ///
    /// Twice as much, and the daylight render is why. Against near-black a quarter of the
    /// light is still light; against a pale veil a quarter of the *ink* is nothing at all,
    /// and the first daylight card came back with a beautiful card floating over an empty
    /// page. It is the same asymmetry ``SylTheme/Colour/luminance`` and ``SylTheme/Colour/warmth``
    /// each document at length and each had to be corrected for once: **there is nothing for
    /// a wash to add to on white paper.**
    ///
    /// The selection still reads, because it is floored near full and the field is not — but
    /// the field survives, which is the promise.
    static let recededAsInk: Double = 0.55

    /// How far the untouched field falls back, in this appearance.
    static func recede(additive: Bool) -> Double { additive ? receded : recededAsInk }
}
