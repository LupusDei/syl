import SwiftUI

/// Which light the app is in: `System | Day | Night`.
///
/// ## Why this setting exists at all
///
/// iOS already has an appearance switch, so an app-level one usually earns nothing but a
/// row of duplication. It earns its place here because the app was not *able* to follow
/// iOS: the home screen forced `.dark` unconditionally the moment scene clips were
/// bundled, so setting iOS to Light gave the Commander a bright conversation next to a
/// black home. That is precisely the "one product" failure `syl-008` spent a day fixing
/// on the other screen, reappearing on this one.
///
/// The fix is not simply to stop forcing — the reasoning behind the forcing was correct
/// and is preserved in ``HomeView/scheme(for:sceneIsPresent:system:)``. It is to make the
/// forcing conditional on *nobody having said otherwise*.
enum AppearanceChoice: String, CaseIterable, Identifiable, Sendable {
    /// Whatever iOS says, moment to moment.
    case system
    /// Light, regardless of iOS.
    case day
    /// Dark, regardless of iOS.
    case night

    var id: String { rawValue }

    /// The word on the control, and the word VoiceOver speaks.
    ///
    /// Day and Night rather than Light and Dark. The palette is a place — morning fog and
    /// the same light seen at night — and it is the vocabulary the whole design system
    /// already uses in its own comments. "Light/Dark" would be the platform's words for
    /// the platform's setting; these are hers.
    var title: String {
        switch self {
        case .system: return "System"
        case .day: return "Day"
        case .night: return "Night"
        }
    }

    /// What is announced under the title, so the choice is legible without experiment.
    var explanation: String {
        switch self {
        case .system: return "Follows iOS."
        case .day: return "Always light. Syl is shown as a still, in daylight."
        case .night: return "Always dark. Her scene plays."
        }
    }

    /// What ``SwiftUI/View/preferredColorScheme(_:)`` should be handed at the root.
    ///
    /// `nil` for System, and that `nil` is the entire mechanism: it leaves the window
    /// unpinned, so iOS changing appearance moves the app with it and no relaunch is
    /// involved. Reading the current trait and passing it back would look identical on
    /// the first frame and then never change again.
    var preferredColorScheme: ColorScheme? {
        switch self {
        case .system: return nil
        case .day: return .light
        case .night: return .dark
        }
    }
}

// MARK: - Storage

/// The store of record for the appearance choice.
///
/// **`UserDefaults`, deliberately, and it is not the same argument as `ServerProfile`'s.**
/// That one is in `UserDefaults` because a launch path with no object graph has to read
/// it. This one is there because of what it *is*: a display preference belonging to this
/// installation of the app on this device, not a fact about the Commander. His data
/// belongs in `syl.db` and syncs; how bright he likes his phone at 6am does not, and
/// pushing it through the outbox would make a second device silently redecorate the
/// first.
///
/// It also means the choice survives the app being unpaired, which is right — the app
/// still has to be looked at on the pairing screen.
@MainActor
final class AppearanceStore: ObservableObject {
    /// Named so nothing spells it twice. A renamed key is a preference that quietly
    /// resets itself on the update that renames it, with no error anywhere.
    nonisolated static let choiceKey = "syl.appearance.choice"

    private let defaults: UserDefaults

    /// Written through on every change rather than at some later save point. There is no
    /// later: the app is killed by the system, not quit.
    @Published var choice: AppearanceChoice {
        didSet {
            guard choice != oldValue else { return }
            defaults.set(choice.rawValue, forKey: Self.choiceKey)
        }
    }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        // An unreadable or unrecognised value falls back to System rather than to a
        // pinned appearance. A future build's new case landing in an old build must not
        // strand this one in a scheme it cannot name, and System is the only answer that
        // is never wrong.
        self.choice =
            defaults.string(forKey: Self.choiceKey)
                .flatMap(AppearanceChoice.init(rawValue:))
            ?? .system
    }
}

// MARK: - The environment

private struct AppearanceChoiceKey: EnvironmentKey {
    /// System, so anything rendered without `RootView` above it — a preview, the
    /// snapshot harness, a test — follows the environment rather than forcing anything.
    static let defaultValue: AppearanceChoice = .system
}

extension EnvironmentValues {
    /// The Commander's explicit appearance choice, as distinct from the appearance that
    /// resulted from it.
    ///
    /// Both are needed and they are not the same question. `\.colorScheme` answers "what
    /// is this frame painted in"; this answers "did he *ask* for that". A screen that
    /// wants to override the appearance — and the home screen has a real reason to —
    /// cannot tell from `\.colorScheme` alone whether it would be overriding iOS or
    /// overriding him.
    var sylAppearance: AppearanceChoice {
        get { self[AppearanceChoiceKey.self] }
        set { self[AppearanceChoiceKey.self] = newValue }
    }
}

// MARK: - The control

/// The appearance row in Settings.
///
/// A hand-built segmented control rather than a `Picker`. Two reasons, and the first one
/// is the epic's own acceptance criterion: a segmented `Picker` paints itself from stock
/// system colours, which is the single thing this design system exists to stop. The
/// second is that the selected segment has to stay legible in *both* appearances against
/// a list row it does not control — a job the palette can do and a tint cannot.
struct AppearanceSection: View {
    /// A binding rather than the store, so this renders in a preview and in the snapshot
    /// harness with no `UserDefaults` and no object graph. `ContentView` defaults it to a
    /// constant for exactly that reason.
    @Binding var choice: AppearanceChoice

    var body: some View {
        Section {
            AppearanceControl(choice: $choice)
                // The control draws its own track and pills, and a list row's own
                // insets would crop the outer pill's stroke against the separator.
                .listRowInsets(EdgeInsets(
                    top: SylTheme.Metric.step,
                    leading: SylTheme.Metric.step,
                    bottom: SylTheme.Metric.step,
                    trailing: SylTheme.Metric.step
                ))
        } header: {
            Text("Appearance")
        } footer: {
            Text(choice.explanation)
                .font(SylTheme.Typeface.detail)
                .foregroundStyle(SylTheme.Colour.inkFaint)
        }
    }
}

/// Three segments, one selected.
struct AppearanceControl: View {
    @Binding var choice: AppearanceChoice

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Namespace private var pill

    var body: some View {
        HStack(spacing: 0) {
            ForEach(AppearanceChoice.allCases) { option in
                segment(option)
            }
        }
        .padding(SylTheme.Metric.tight)
        .background {
            // The track. `hairline` is the palette's own ink at 22% and is therefore
            // visible against both a near-white list row and a near-black one, which a
            // fixed grey is not.
            Capsule(style: .continuous)
                .fill(SylTheme.Colour.hairline)
        }
        // One container VoiceOver announces before reading the segments, so he hears
        // "Appearance" once rather than three unattached words.
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Appearance")
    }

    private func segment(_ option: AppearanceChoice) -> some View {
        let isSelected = option == choice

        return Button {
            if reduceMotion {
                choice = option
            } else {
                withAnimation(SylTheme.Motion.responsive) { choice = option }
            }
        } label: {
            Text(option.title)
                .font(SylTheme.Typeface.detail)
                // Selected reads at full ink; the others recede to `inkSoft`. Both are
                // defined for either appearance, so the contrast holds in Day and Night
                // without a second palette.
                .foregroundStyle(isSelected ? SylTheme.Colour.ink : SylTheme.Colour.inkSoft)
                .frame(maxWidth: .infinity)
                .frame(minHeight: SylTheme.Metric.minimumTouchTarget)
                .background {
                    if isSelected {
                        selection
                    }
                }
                // The pill is drawn behind the label, so the tap target must be the
                // whole cell rather than the glyphs.
                .contentShape(Capsule(style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(option.title)
        .accessibilityHint(option.explanation)
        // `.isSelected` is what makes VoiceOver say "selected" rather than leaving three
        // identical buttons and no way to hear which one is on.
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
    }

    /// The selected pill.
    ///
    /// Slides between segments via `matchedGeometryEffect`, which is the one piece of
    /// motion on this control — and it is skipped entirely under Reduce Motion, where the
    /// pill simply appears where it belongs.
    @ViewBuilder
    private var selection: some View {
        let shape = Capsule(style: .continuous)
            .fill(SylTheme.Colour.accent.opacity(0.28))
            .overlay {
                Capsule(style: .continuous)
                    .strokeBorder(SylTheme.Colour.accent.opacity(0.55), lineWidth: 1)
            }

        if reduceMotion {
            shape
        } else {
            shape.matchedGeometryEffect(id: "selection", in: pill)
        }
    }
}

// MARK: - Previews

#Preview("Day") {
    AppearancePreview(initial: .day).preferredColorScheme(.light)
}

#Preview("Night") {
    AppearancePreview(initial: .night).preferredColorScheme(.dark)
}

/// A live binding, so the preview can actually be tapped through all three states —
/// which is the only way to check the third one is legible.
private struct AppearancePreview: View {
    let initial: AppearanceChoice
    @State private var choice: AppearanceChoice = .system

    var body: some View {
        List {
            AppearanceSection(choice: $choice)
        }
        .onAppear { choice = initial }
    }
}
