import SwiftUI

/// Where he types.
///
/// Three things were wrong with the original and only one of them was styling. It sat on
/// `.bar` with a `Color(.secondarySystemBackground)` field, so it belonged to iOS rather
/// than to Syl; the send glyph took the ambient tint, which resolved to stock system
/// blue because `AccentColor.colorset` ships empty; and the button was a `.title2`
/// glyph — roughly 28pt of tappable area, **below Apple's floor and below
/// `Metric.minimumTouchTarget`, which this repo already defines**. That last one is a
/// defect, not a preference.
struct ChatComposer: View {
    /// Observed here and **nowhere else**. `ChatView` holds it as a plain `let` and passes
    /// it down without subscribing, so a keystroke redraws this bar and not the
    /// transcript. See `ChatDraft`.
    @ObservedObject var draft: ChatDraft
    var isFocused: FocusState<Bool>.Binding
    let send: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var canSend: Bool {
        !draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        HStack(alignment: .bottom, spacing: SylTheme.Metric.step) {
            field
            SendControl(isArmed: canSend, action: send)
        }
        .padding(.horizontal, SylTheme.Metric.gutter)
        .padding(.vertical, SylTheme.Metric.step)
        .background(alignment: .top) {
            // Glass rather than `.bar`, so the veil goes on existing behind the
            // composer instead of being cut off by an opaque strip. A hairline at the
            // top edge only — a full border would box the bar, and nothing else in this
            // app is boxed.
            ZStack(alignment: .top) {
                Rectangle().fill(.ultraThinMaterial)
                Rectangle()
                    .fill(SylTheme.Colour.hairline)
                    .frame(height: SylTheme.Metric.hair)
            }
            .ignoresSafeArea(edges: .bottom)
        }
    }

    private var field: some View {
        TextField(
            "",
            text: $draft.text,
            prompt: Text("Message").foregroundStyle(SylTheme.Colour.inkFaint),
            axis: .vertical
        )
        .lineLimit(1...6)
        .textFieldStyle(.plain)
        .font(SylTheme.Typeface.Prose.body)
        .foregroundStyle(SylTheme.Colour.ink)
        .tint(SylTheme.Colour.luminance)
        .padding(.horizontal, SylTheme.Metric.step)
        .padding(.vertical, SylTheme.Metric.snug + 2)
        .frame(minHeight: SylTheme.Metric.minimumTouchTarget)
        .sylGlass(radius: 18, presence: 0.4)
        .focused(isFocused)
    }
}

/// The send control: a mote that ignites.
///
/// Disabled is a hairline ring — present, obviously inert, and no grey-blue mud. Armed,
/// it fills with her light and throws a small glow, which is the only place in the
/// composer where anything glows. That asymmetry is the affordance: the control tells
/// you it will do something by *lighting up*, which is how everything else about Syl
/// signals presence.
private struct SendControl: View {
    let isArmed: Bool
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
                            .strokeBorder(
                                SylTheme.Colour.hairline,
                                lineWidth: SylTheme.Metric.hair
                            )
                            .opacity(isArmed ? 0 : 1)
                    }
                    // The glow exists only when there is something to send. A permanent
                    // glow is decoration; a conditional one is information.
                    .shadow(
                        color: SylTheme.Colour.luminance.opacity(isArmed ? 0.45 : 0),
                        radius: isArmed ? 10 : 0,
                        y: 2
                    )

                Image(systemName: "arrow.up")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(
                        isArmed ? SylTheme.Colour.luminanceCore : SylTheme.Colour.inkFaint
                    )
            }
            // The whole 44pt disc is the target, not just the glyph.
            .frame(width: diameter, height: diameter)
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(!isArmed)
        .animation(reduceMotion ? nil : SylTheme.Motion.responsive, value: isArmed)
        .accessibilityLabel("Send")
        // Without this the control announces nothing about why it is inert, and a
        // VoiceOver user is left tapping a button that silently does nothing.
        .accessibilityHint(isArmed ? "" : "Type a message first")
    }
}
