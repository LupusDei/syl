import SwiftUI

/// The sky, for someone who cannot look at it.
///
/// **A `Canvas` is one opaque rectangle to VoiceOver.** It has no children, no labels and
/// no positions, so without this the screen does not exist — and this is the screen whose
/// entire purpose is to be looked at, which makes its absence worse rather than more
/// forgivable. A blind user opening the Memory door would find a door onto nothing.
///
/// So every star and every filament becomes a real element, at the place on the glass where
/// it actually is, saying what it is, how strongly she holds it and **where it came from**.
/// The last of those is not a nicety: provenance is the answer to the only question that
/// matters about a memory, and a label that read "star, 0.93" would be the picture's
/// coordinates rather than its meaning.
///
/// ## The order is the sky's own
///
/// Anchors first — the people and goals he actually thinks in terms of — then what orbits
/// them, then the threads between. That is the structure of the layout read aloud, and it
/// is a far better tour than the top-to-bottom sweep the positions would otherwise give,
/// which would interleave five clusters into one undifferentiated list.
///
/// ## What the tap says it will do
///
/// The hint names what is behind the activation, and for an inferred thing it names her
/// reasoning specifically. A sighted user learns there is more by watching a card rise; this
/// is the same promise, made in words.
struct ConstellationVoice: View {
    var sky: PreparedSky
    var transform: ConstellationTransform
    var onSelect: (ConstellationHit) -> Void

    var body: some View {
        ZStack(alignment: .topLeading) {
            ForEach(sky.stars) { star in
                element(
                    label: ConstellationWords.spoken(for: star),
                    hint: ConstellationWords.hint(for: star.detail.species),
                    at: transform.apply(star.anchor)
                ) { onSelect(.star(star.id)) }
                .accessibilitySortPriority(star.isAnchor ? 2 : 1)
            }

            ForEach(sky.filaments) { filament in
                element(
                    label: ConstellationWords.spoken(for: filament),
                    hint: ConstellationWords.hint(for: filament.species),
                    at: transform.apply(ConstellationHitTest.apex(of: filament))
                ) { onSelect(.filament(filament.id)) }
                .accessibilitySortPriority(0)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    /// One element, a touch target wide, over the point the thing is actually drawn at.
    ///
    /// Sized to ``SylTheme/Metric/minimumTouchTarget`` rather than to the star, so
    /// explore-by-touch finds a three-point core the same way it finds a button. Nothing is
    /// drawn — this whole tree exists only to be read.
    private func element(
        label: String,
        hint: String,
        at point: CGPoint,
        activate: @escaping () -> Void
    ) -> some View {
        Color.clear
            .frame(
                width: SylTheme.Metric.minimumTouchTarget,
                height: SylTheme.Metric.minimumTouchTarget)
            .position(point)
            .accessibilityElement()
            .accessibilityLabel(label)
            .accessibilityHint(hint)
            .accessibilityAddTraits(.isButton)
            .accessibilityAction(.default, activate)
    }

}
