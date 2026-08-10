import SwiftUI

/// The control that commits what he just typed: a mote that ignites.
///
/// Disabled is a hairline ring — present, obviously inert, and no grey-blue mud. Armed,
/// it fills with her light and throws a small glow, which is the only place in a
/// composing row where anything glows. That asymmetry *is* the affordance: the control
/// says it will do something by lighting up, which is how everything else about Syl
/// signals presence.
///
/// ## Why this is in the design system
///
/// `ChatComposer.SendControl` established this vocabulary and is a private copy of it.
/// Capture needs the same control with a different glyph, and the honest choice between
/// "copy thirty lines of styling into a second file" and "share it" is to share it — a
/// glow that drifts apart between two screens is exactly the ad-hoc styling `SylTheme`
/// exists to end. `ChatComposer` is deliberately **not** edited here: two other squads
/// are in that file this week, and a merge conflict over a refactor nobody asked for is a
/// bad trade. Folding it in is `syl-011.4.7`.
struct CommitControl: View {
    /// Whether there is anything to commit. Drives every visual difference.
    let isArmed: Bool
    /// SF Symbol. The verb, in one glyph.
    var symbol: String = "arrow.up"
    /// What VoiceOver calls this control.
    let label: String
    /// Why it is inert, when it is. Without this a VoiceOver user is left tapping a
    /// button that silently does nothing.
    var disabledHint: String

    let action: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private let diameter = SylTheme.Metric.minimumTouchTarget

    var body: some View {
        Button(action: action) {
            ZStack {
                Circle()
                    .fill(SylTheme.Colour.luminance.opacity(isArmed ? 0.92 : 0))
                    .overlay {
                        Circle()
                            .strokeBorder(SylTheme.Colour.hairline, lineWidth: SylTheme.Metric.hair)
                            .opacity(isArmed ? 0 : 1)
                    }
                    // The glow exists only when there is something to commit. A permanent
                    // glow is decoration; a conditional one is information.
                    .shadow(
                        color: SylTheme.Colour.luminance.opacity(isArmed ? 0.45 : 0),
                        radius: isArmed ? 10 : 0,
                        y: 2
                    )

                Image(systemName: symbol)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(
                        isArmed ? SylTheme.Colour.luminanceCore : SylTheme.Colour.inkFaint
                    )
            }
            // The whole 44pt disc is the target, not just the glyph. `SendControl`'s own
            // history is the reason this is stated: it shipped as a bare `.title2` glyph,
            // roughly 28pt of tappable area — under Apple's floor and under a constant
            // this repo already defines.
            .frame(width: diameter, height: diameter)
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(!isArmed)
        .animation(reduceMotion ? nil : SylTheme.Motion.responsive, value: isArmed)
        .accessibilityLabel(label)
        .accessibilityHint(isArmed ? "" : disabledHint)
    }
}
