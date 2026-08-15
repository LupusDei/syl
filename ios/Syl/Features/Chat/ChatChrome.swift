import SwiftUI
import SylKit

/// The connection state, said plainly.
///
/// The server genuinely will be unreachable sometimes — the Mac reboots, the tailnet
/// drops on a WiFi-to-cellular handoff, the phone goes through a tunnel. An assistant
/// that silently fails to sync is worse than one that says so, which is why this is kept
/// rather than designed away.
///
/// It used to appear and disappear with no animation at all — a bare `if` in a `VStack`,
/// so the entire transcript jumped every time the connection state changed. That is now
/// a transition, because a layout that moves without being animated reads as a glitch.
struct ConnectionBanner: View {
    let summary: String
    let notice: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(summary)
                .font(SylTheme.Typeface.detail.weight(.medium))
                .foregroundStyle(SylTheme.Colour.ink)
            if let notice {
                Text(notice)
                    .font(SylTheme.Typeface.numeral)
                    .foregroundStyle(SylTheme.Colour.inkFaint)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, SylTheme.Metric.gutter)
        .padding(.vertical, SylTheme.Metric.snug)
        // A hairline and nothing else.
        //
        // This carried `.ultraThinMaterial` across the full width and it was the one
        // element left on the screen that read as iOS rather than as Syl — an opaque
        // grey strip capping the veil, exactly like a system banner. Nothing else in
        // this app puts a filled bar above content. The rule alone separates it, and
        // the veil runs unbroken from the navigation bar to the composer.
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(SylTheme.Colour.hairline)
                .frame(height: SylTheme.Metric.hair)
        }
        .accessibilityElement(children: .combine)
    }
}

/// The conversation before there is one.
///
/// Deliberately two lines and no more. Starter-prompt chips were considered and
/// rejected: they are useful for ten minutes on day one and dead weight for the
/// following year, and this is a daily tool for one person who knows what it is for.
struct EmptyConversation: View {
    var body: some View {
        VStack(spacing: SylTheme.Metric.snug) {
            Text("Nothing here yet.")
                .font(SylTheme.Typeface.title)
                .foregroundStyle(SylTheme.Colour.ink)
            Text("Ask her for something, or wait — she starts most mornings.")
                .font(SylTheme.Typeface.detail)
                .foregroundStyle(SylTheme.Colour.inkSoft)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, SylTheme.Metric.gutter)
        .padding(.vertical, SylTheme.Metric.chapter)
        .accessibilityElement(children: .combine)
    }
}

/// Syl, present in her own conversation.
///
/// `ChatViewModel` has published `presence` since the screen was written and `ChatView`
/// never rendered it — she was visible on the home screen and absent from the one place
/// the Commander is actually waiting on her.
///
/// The ribbon and nothing else: no three grey dots. Three dots are another app's
/// furniture, and this app already has a vocabulary for "she is doing something" —
/// light. It appears only while she is *active*, which is the same rule the home screen
/// applies, and for the same reason: drawn continuously it stops meaning anything.
struct PresenceInTranscript: View {
    let presence: PresenceState
    let intensity: Double

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            if reduceMotion {
                // Reduce Motion asks for no movement, not for no information. A moving
                // ribbon conveys "thinking" to everyone else; this conveys it here.
                Text(label)
                    .sylLabelStyle()
                    .foregroundStyle(SylTheme.Colour.inkSoft)
                    .padding(.horizontal, SylTheme.Metric.step)
                    .frame(height: SylTheme.Metric.minimumTouchTarget)
                    .sylGlass(radius: SylTheme.Metric.minimumTouchTarget / 2, presence: 0.7)
            } else {
                SylRibbon(state: presence, intensity: intensity)
                    .frame(height: 44)
                    .opacity(0.75)
                    .blendMode(.plusLighter)
            }
        }
        .accessibilityElement()
        .accessibilityLabel(label)
    }

    private var label: String {
        switch presence {
        case .thinking: return "Thinking"
        case .speaking: return "Replying"
        case .listening: return "Listening"
        case .alert: return "Something needs attention"
        case .delighted, .manifest: return "Here"
        case .absent, .idle, .concerned: return "Here"
        }
    }
}

/// What the head of the transcript is currently saying (`syl-025.4.4`).
///
/// Four states, and **two of them look terminal while meaning opposite things**:
/// `beginning` is *there is nothing more*, `unreachable` is *there is more and I cannot
/// reach it right now*. If those two are not distinguishable at a glance the feature is
/// broken even when every query behind it is correct — he either stops scrolling at a
/// network error believing he has read everything, or keeps tapping at the true start of
/// his own history.
///
/// `beginning` comes from `LocalStore.hasWholeHistory`, which is deliberately two
/// conditions: the server confirmed where history starts AND the device still holds a row
/// at or below it. A confirmation alone says where the beginning *is*, not that we have
/// reached it, so a cleared device with a standing marker must not draw an ending over
/// nothing.
enum EarlierMessagesState: Equatable, Sendable, CaseIterable {
    /// There is more, and he can ask for it.
    case idle
    /// A page is in flight.
    case loading
    /// The true start of the conversation. Terminal — the first thing either of them said.
    case beginning
    /// Older history exists and the network cannot reach it. Retryable.
    case unreachable
}

/// What the control DRAWS, which is not always what the state is.
///
/// The two differ for exactly one reason: a local page resolves in milliseconds, and a
/// control that changes its wording and changes it back inside one frame is worse than a
/// control that never changed. See ``EarlierMessages/loadingAppearsAfter``.
enum EarlierMessagesAppearance: Equatable, Sendable {
    case ask
    case working
    case ending
    case offline
}

extension EarlierMessagesState {
    /// Whether a tap does anything.
    ///
    /// **Follows the STATE, never the appearance.** While a load is in flight the control
    /// still *reads* "Earlier messages" for the first fraction of a second, and it must
    /// not be tappable during that window — otherwise the anti-flash delay below would
    /// buy a smoother control at the price of letting him start a second load.
    var isActionable: Bool {
        switch self {
        case .idle, .unreachable: return true
        case .loading, .beginning: return false
        }
    }

    /// What VoiceOver says.
    ///
    /// **Also follows the STATE rather than the appearance, and that asymmetry is
    /// deliberate.** The visual delay exists to stop a sighted reader seeing a flicker;
    /// it is not a reason to tell a VoiceOver user that nothing is happening. He hears
    /// the truth the moment it is true.
    ///
    /// `beginning` reads as an arrival, not an error. There is no "cannot", no "no more",
    /// nothing that sounds like a failure — it is the top of everything he and Syl have
    /// ever said to each other, and it should feel like reaching it.
    var accessibilityLabel: String {
        switch self {
        case .idle: return "Load earlier messages"
        case .loading: return "Loading earlier messages"
        case .beginning: return "The beginning of your conversation with Syl."
        case .unreachable:
            return "Earlier messages could not be loaded. Double tap to try again."
        }
    }

    /// The drawing, given whether the loading appearance has earned its place yet.
    ///
    /// Pure, so the rule is testable without a hosted view and without waiting on a
    /// clock. The view owns only the timer that flips the flag.
    func appearance(loadingIsVisible: Bool) -> EarlierMessagesAppearance {
        switch self {
        case .idle: return .ask
        case .loading: return loadingIsVisible ? .working : .ask
        case .beginning: return .ending
        case .unreachable: return .offline
        }
    }
}

/// The head of the transcript: the way back, or the word that there is no further back.
///
/// `ChatSnapshotLoader` was hard-capped at 200 messages with no way to reach anything
/// older, so a conversation that had run for a month had no beginning. This is the way
/// back — and, at the top of it, the acknowledgement that he has arrived.
///
/// ## Why `beginning` is a divider and not a disabled button
///
/// It borrows `DayDivider`'s language — hairline, label, hairline — on purpose. That is
/// already this app's vocabulary for *a marker in the transcript*, and the beginning of a
/// conversation is exactly that: a boundary, like the turn of a day. A greyed-out button
/// would say the same thing in the language of a refusal, and a spinner that never
/// resolves is the single most likely way this feature reads as broken while working
/// perfectly. No chevron, no control, nothing to press. Type and spacing do the work.
struct EarlierMessages: View {
    let state: EarlierMessagesState
    let action: () -> Void

    /// How long a load must run before it is allowed to say so.
    ///
    /// A local page comes back in milliseconds. Showing "Loading earlier…" for two frames
    /// and then taking it away is a flicker at the top of the transcript, which reads as
    /// a glitch rather than as progress — so below this threshold the control simply
    /// never changes. Above it, the wait is real and worth narrating.
    static let loadingAppearsAfter: Duration = .milliseconds(150)

    @State private var loadingIsVisible = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var appearance: EarlierMessagesAppearance {
        state.appearance(loadingIsVisible: loadingIsVisible)
    }

    var body: some View {
        Group {
            if appearance == .ending {
                ending
            } else {
                Button(action: action) { row }
                    .buttonStyle(.plain)
                    .disabled(!state.isActionable)
            }
        }
        .animation(reduceMotion ? nil : SylTheme.Motion.settle, value: appearance)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(state.accessibilityLabel)
        // Only the two states a tap does anything in are offered as buttons; the ending
        // is a piece of the transcript, and the loading row is not a target.
        .accessibilityAddTraits(state.isActionable ? .isButton : [])
        .task(id: state) {
            guard state == .loading else {
                loadingIsVisible = false
                return
            }
            try? await Task.sleep(for: Self.loadingAppearsAfter)
            guard !Task.isCancelled else { return }
            loadingIsVisible = true
        }
    }

    /// Idle, working and offline all draw as one row, so the height never jumps.
    private var row: some View {
        HStack(spacing: SylTheme.Metric.snug) {
            if appearance == .offline {
                // The one glyph in this control, and it belongs to the state that has to
                // be told apart from the ending at a glance.
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 11, weight: .semibold))
            }
            Text(rowText)
                .sylLabelStyle()
        }
        .foregroundStyle(appearance == .offline ? SylTheme.Colour.ink : SylTheme.Colour.inkSoft)
        .frame(maxWidth: .infinity)
        // The full target on every row, so the tappable states are never smaller than
        // the reach they advertise.
        .frame(height: SylTheme.Metric.minimumTouchTarget)
        .contentShape(Rectangle())
    }

    private var rowText: String {
        switch appearance {
        case .ask, .ending: return "Earlier messages"
        case .working: return "Loading earlier…"
        case .offline: return "Tap to try again"
        }
    }

    /// The top of his whole history with her.
    private var ending: some View {
        HStack(spacing: SylTheme.Metric.step) {
            hairline
            Text("The beginning")
                .sylLabelStyle()
                // `inkFaint` rather than `inkSoft`: quieter than a day rule, because
                // this one is said once and never again.
                .foregroundStyle(SylTheme.Colour.inkFaint)
                .fixedSize()
            hairline
        }
        .padding(.vertical, SylTheme.Metric.step)
    }

    private var hairline: some View {
        Rectangle()
            .fill(SylTheme.Colour.hairline)
            .frame(height: SylTheme.Metric.hair)
    }
}

extension EarlierMessages {
    /// The pre-`syl-025.4.4` shape, kept so `ChatView` keeps compiling.
    ///
    /// **A seam, not an API.** `ChatView` is Track A's file and still constructs this
    /// control with a bare `isLoading`; removing this initialiser would red the build for
    /// a change that has nothing to do with them. `syl-025.4.3` switches that call site to
    /// the state and deletes this.
    ///
    /// It can only ever produce two of the four states, which is the whole reason the
    /// state exists: `beginning` and `unreachable` are not expressible as a Bool, and
    /// that Bool is why the control could previously only spin or offer.
    init(isLoading: Bool, action: @escaping () -> Void) {
        self.init(state: isLoading ? .loading : .idle, action: action)
    }
}

/// "Syl replied" — the pill that appears when something arrives while he is reading
/// history.
///
/// The transcript used to scroll to the newest turn unconditionally, which meant a
/// message landing while he was reading back through yesterday yanked the view out from
/// under him. Auto-scrolling only when he is already at the bottom fixes that, but it
/// leaves a second problem: he now has no idea anything arrived. This is the answer to
/// the second problem, and the two are only correct together.
struct NewTurnPill: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: SylTheme.Metric.snug) {
                Image(systemName: "arrow.down")
                    .font(.system(size: 11, weight: .semibold))
                Text("Syl replied")
                    .font(SylTheme.Typeface.detail)
            }
            .foregroundStyle(SylTheme.Colour.ink)
            .padding(.horizontal, SylTheme.Metric.step)
            .frame(height: SylTheme.Metric.minimumTouchTarget)
            .sylGlass(radius: SylTheme.Metric.minimumTouchTarget / 2, presence: 0.85)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Syl replied. Scroll to the newest message.")
    }
}
