import SwiftUI
import UIKit

/// The gesture that brings her to life, and the numbers that make it deliberate.
///
/// ## Why there is no button
///
/// The Commander's ruling, 2026-08-22: **a long press on the videos of her on the home
/// screen opens the live session.** Not a button, not a tab, not a menu item. The clips
/// on the home screen already *are* her face, so pressing and holding one brings that
/// face to life — the still becomes the living thing, and nothing has to be explained
/// because the target is already the most obvious thing on the screen.
///
/// Everything below follows from that plus one fact: **it costs about twenty cents a
/// minute the moment it opens.**
enum LiveFace {
    /// How long he has to hold her.
    ///
    /// The system default is 0.5s, which is what a *menu* costs — and a menu is free.
    /// This is not: a press that opens by accident is money, and the mis-fires would all
    /// be on the one screen he opens forty times a day, with his thumb resting on her
    /// while he reads the day below.
    ///
    /// 0.8s is long enough that nobody arrives here without meaning to and short enough
    /// that it does not feel broken. The haptic below is the other half of the answer:
    /// **he is told the instant it takes**, so "did I hold it long enough" is never a
    /// question he has to ask.
    static let minimumPressDuration: TimeInterval = 0.8

    /// How far his thumb may drift before it stops being a press and starts being a
    /// scroll. The default is 10 points; the day is one flick below her, so this is
    /// tightened — a scroll that opens a session is the accidental spend in its most
    /// annoying form.
    static let allowableMovement: CGFloat = 8

    /// How long she may take to come through before the wait is declared a failure.
    ///
    /// **This is not the thing that decides when to show her.** She is shown when her
    /// video track actually plays and at no other moment; this number is the opposite
    /// signal — the point past which *nothing has played and nothing is going to*, so
    /// the session is settled and he is told in words.
    ///
    /// It exists because the worst failure on this surface is silence. The observed wait
    /// is five to thirty seconds, and the failures he has actually hit ("could not
    /// establish signal connection") produce no state at all from inside the page — so
    /// without a deadline a dead session would warm invisibly, forever, at twenty cents
    /// a minute. Forty-five is comfortably past the slowest good case and well short of
    /// the point where he would give up and press again.
    ///
    /// ## DO NOT REMOVE THIS AS REDUNDANT NOW THAT THE SIGNALS WORK
    ///
    /// It looks like belt-and-braces beside `audible`, `playing` and the `connected`
    /// grace. It is not, and the history says so with unusual force: **this backstop is
    /// the only reason the Commander has ever seen her face at all.**
    ///
    /// It was added on the principle that silence must never resolve to nothing, argued
    /// as a safety net against a *fragile* report chain. The chain was not fragile — it
    /// was never connected. `connected` and `playing` could not fire, because the page
    /// passed handlers `AvatarCall` does not accept (`syl-chzl.10`), so for a full day
    /// every session on his phone was presented by this line and by nothing else.
    ///
    /// **A fallback justified by the wrong reason was carrying the whole feature.** That
    /// is the argument for keeping it, not against it: the fix repaired the signals we
    /// know about, and this is what stands behind the next vendor prop that silently does
    /// not exist. A backstop is worth most exactly when the reasoning that motivated it
    /// turns out to have been wrong.
    static let readyDeadline: TimeInterval = 45

    /// How long `playing` gets to arrive once the room is joined, before she is presented
    /// on `connected` alone (`syl-chzl.8`).
    ///
    /// **The fallback that stops silence resolving to nothing.** Presenting her used to be
    /// gated strictly on `playing`, which is right in the abstract — show her when there
    /// is a moving picture — and made the whole feature depend on the single most fragile
    /// signal in the system with nothing behind it. When that chain goes quiet he waits
    /// forty-five seconds behind an opaque screen and is then told the session he paid for
    /// has been closed. **A face that appears slightly early is a far smaller failure than
    /// a face that never appears.**
    ///
    /// One second, because `connected` and `playing` are milliseconds apart on a healthy
    /// page — the SDK reports the connection, the media element gets its first frame — so
    /// a second is several times the margin the race actually needs. The beat that checks
    /// it runs once a second (`LiveFaceView.beat()`), so what he experiences is one to two
    /// seconds after the room is joined. Both ends of that are inside the moment he is
    /// still expecting something to happen from having pressed.
    static let playingGrace: TimeInterval = 1

    /// The page's lifecycle as rungs, for the states that mean it got **further**.
    ///
    /// Mirrors `CLIENT_STATES` in `backend/src/face/client-report.ts`, minus every word
    /// that is an ending rather than a step — the fatal set belongs to ``failure(
    /// forPageState:detail:wasHere:)`` and must not appear here, or a failure would count
    /// as progress and be shown instead of said.
    ///
    /// Rungs rather than an index into a flat list because some of these are alternatives
    /// at the same depth: `camera_blocked` is the fence firing during the same media
    /// request `mic_requested` announces, and `mic_denied` is as far along as
    /// `mic_granted` — a mute conversation is still a conversation, and the page carries
    /// on.
    private static let ladder: [[String]] = [
        ["booting"],
        ["sdk_loaded"],
        ["mic_requested", "camera_blocked"],
        ["mic_granted", "mic_denied"],
        ["connecting"],
        ["connected"],
        // Between the room and the picture, because that is exactly where it
        // happens: her audio track subscribes and plays without waiting for
        // her video track. See ``LiveFaceModel/pageSaid(_:detail:)`` — this
        // rung does not merely count as progress, it presents her.
        ["audible"],
        ["playing"],
    ]

    /// How far this word says the page got, or nil if it says nothing about that.
    ///
    /// One-based, so zero can mean *it has not spoken*.
    static func reach(forPageState state: String) -> Int? {
        ladder.firstIndex { $0.contains(state) }.map { $0 + 1 }
    }

    /// The rung past which giving up on her is the worse answer.
    ///
    /// `sdk_loaded`: the parts that draw her are in memory, so there is something behind
    /// the layer that could be her. Below it there is not — a page that only ever said
    /// `booting` never loaded the SDK, and raising an empty layer over that would replace
    /// an honest sentence with a blank rectangle.
    ///
    /// Derived rather than written down, so renumbering the ladder cannot silently move
    /// the threshold. ``Int/max`` if that rung is ever removed, which fails to the safe
    /// side: she is not presented, and the sentence he gets is the one that exists today.
    static var reachWorthShowing: Int { reach(forPageState: "sdk_loaded") ?? .max }

    /// What the home screen says while nothing has happened yet.
    static let wakingPhrase = "Waking her"

    /// What the page's own progress reports are called on his screen.
    ///
    /// Nil for the states that are measurement rather than progress — `camera_blocked`
    /// is how we know the SDK asks for a camera it was told not to want, and it is not
    /// news he can act on. See `backend/src/face/client-report.ts` for the closed
    /// vocabulary these names come from; anything not listed there cannot arrive.
    static func phrase(forPageState state: String) -> String? {
        switch state {
        case "booting", "sdk_loaded": return wakingPhrase
        case "mic_requested", "mic_granted": return "Reaching for the microphone"
        // Not fatal: she can still be seen. It is the half of the conversation that is
        // about to be missing, so it is said rather than swallowed.
        case "mic_denied": return "She will not be able to hear you"
        case "connecting": return "Connecting"
        case "connected": return "Almost here"
        default: return nil
        }
    }

    /// The states that mean she is never going to play, and what to say about each.
    ///
    /// Nil means *keep waiting* — the vocabulary is closed and a word this function does
    /// not know is a word the page did not send. Returning a sentence here settles the
    /// session, so a state added to the wrong side of this switch either bills forever
    /// or hangs up on a healthy face.
    static func failure(forPageState state: String, detail: String, wasHere: Bool) -> String? {
        switch state {
        case "sdk_failed":
            return "I could not load the parts that draw me" + note(detail)
        case "failed":
            return "Something went wrong bringing me through" + note(detail)
        case "no_media":
            return "I connected, and then nothing of me ever played."
        case "autoplay_blocked":
            return "I am here, but this phone will not start my video."
        case "no_session":
            return "That page opened with no session in it."
        case "ended":
            return wasHere ? "I have gone." : "I dropped before I could reach you."
        default:
            return nil
        }
    }

    /// The page's own words for what broke, bounded.
    ///
    /// Shown because it is the difference between "it did not work" and "could not
    /// establish signal connection", and the second is the one he can act on. Bounded
    /// because it is a string a failing import graph chose, not one we wrote.
    /// Joined with a dash rather than a full stop, because the page's own words are a
    /// fragment written by a failing SDK — `could not establish signal connection`, with
    /// no capital and no punctuation. Ending our sentence first and starting theirs after
    /// it reads as a typo; hanging it off a dash reads as a quotation, which it is.
    private static func note(_ detail: String) -> String {
        let trimmed = detail.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "." }
        return " — " + String(trimmed.prefix(140))
    }
}

/// What the **home screen** says about a face that is on its way, or one that never came.
///
/// A value rather than a view so the decision and the drawing are separable: the model
/// decides what he is owed and the home screen draws it, which is the same split every
/// other surface in this app makes and the reason any of this is assertable.
struct FaceNotice: Equatable {
    enum Kind: Equatable {
        /// She is coming. Small, quiet, and cancellable.
        case waking
        /// She is not coming, and this says why. **The case that matters most** — a long
        /// press followed by silence is indistinguishable from a dead gesture.
        case failed
    }

    var kind: Kind
    var sentence: String
    /// Whether pressing again could plausibly work. False against a spent ceiling.
    var offersRetry: Bool = false
}

/// The hint over her figure while she is on her way, and the sentence when she is not.
///
/// ## Why there is anything here at all
///
/// The haptic on `.began` is kept and is not enough on its own. It answers *"did I hold
/// it long enough"* and nothing else: it says the gesture landed, not that something is
/// now happening that will take a moment, and it is silent on a phone with haptics off,
/// in a thick case, or on a table. Thirty seconds of a home screen that looks exactly as
/// it did before is a dead gesture, and a dead gesture gets pressed again.
///
/// ## Why it is this small
///
/// Because the alternative is what we are removing. A modal or a spinner over the whole
/// screen is the thirty-second block this change exists to delete — he must be able to
/// read his day, scroll it, tap a door and walk away while she warms. So this is one
/// line over her own figure, it hit-tests only itself, and the only thing it takes from
/// him is the space it occupies.
struct AwakeningNotice: View {
    let notice: FaceNotice
    /// Cancel the wait, or dismiss the failure. Settles the session either way.
    var onCancel: () -> Void
    /// Press again. Absent when there is nothing to press again for.
    var onRetry: (() -> Void)?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        // **One line while she is coming, a paragraph only when something is wrong.**
        // The waiting case is the one he will see forty times and it earns the least
        // room on the screen; the failing case is the one he has to read, and it is the
        // only one allowed to grow.
        HStack(alignment: .top, spacing: SylTheme.Metric.snug) {
            mark
                // Optically against the first line's cap height rather than the text
                // block's centre — a dot beside three lines of prose must not float in
                // the middle of them.
                .padding(.top, 6)

            VStack(alignment: .leading, spacing: SylTheme.Metric.snug) {
                Text(notice.sentence)
                    .font(SylTheme.Typeface.detail)
                    .foregroundStyle(SylTheme.Colour.ink)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)

                if notice.kind == .failed {
                    HStack(spacing: SylTheme.Metric.gutter) {
                        if notice.offersRetry, let onRetry {
                            Button("Try again", action: onRetry)
                                .foregroundStyle(SylTheme.Colour.accent)
                        }
                        Button("Dismiss", action: onCancel)
                            .foregroundStyle(SylTheme.Colour.inkSoft)
                    }
                    .font(SylTheme.Typeface.detail)
                    .buttonStyle(.plain)
                }
            }

            if notice.kind == .waking {
                Button("Cancel", action: onCancel)
                    .font(SylTheme.Typeface.detail)
                    .buttonStyle(.plain)
                    .foregroundStyle(SylTheme.Colour.inkSoft)
                    .padding(.leading, SylTheme.Metric.tight)
            }
        }
        .padding(.horizontal, SylTheme.Metric.step)
        .padding(.vertical, SylTheme.Metric.snug)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: SylTheme.Metric.cardRadius, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: SylTheme.Metric.cardRadius, style: .continuous)
                .strokeBorder(SylTheme.Colour.luminance.opacity(0.18), lineWidth: SylTheme.Metric.hair)
        }
        .frame(maxWidth: 320)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(notice.sentence)
    }

    /// A breathing point of her light, **not a spinner**. A progress indicator is the
    /// vocabulary of a blocked screen, and this screen is not blocked.
    @ViewBuilder
    private var mark: some View {
        let dot = Circle()
            .fill(notice.kind == .waking ? SylTheme.Colour.luminance : SylTheme.Colour.inkFaint)
            .frame(width: SylTheme.Metric.snug, height: SylTheme.Metric.snug)

        if notice.kind == .waking && !reduceMotion {
            TimelineView(.animation(minimumInterval: 1.0 / 20.0)) { timeline in
                let t = timeline.date.timeIntervalSinceReferenceDate
                dot.opacity(0.35 + 0.45 * (0.5 + 0.5 * sin(t / 1.4 * .pi * 2)))
            }
        } else {
            dot
        }
    }
}

/// A transparent layer over her face that recognises exactly one thing.
///
/// ## Why UIKit, on a screen made entirely of SwiftUI
///
/// Because a `UILongPressGestureRecognizer` is an **object with a duration you can read
/// and an action you can fire**, and a SwiftUI gesture is an opaque value that only a
/// running render loop can exercise. The requirements here are that the gesture exists,
/// that a tap is unaffected, and that a refusal is never silent — and the only way to
/// assert the first two is to be able to look at the recogniser and call the handler.
///
/// This is the same trade `SceneVideo` already makes one file over: the thing that has to
/// be right is worth a representable.
///
/// ## What it must not do
///
/// **A plain tap keeps doing whatever it did before.** ``UIGestureRecognizer/
/// cancelsTouchesInView`` is off and both delay flags are off, so every touch still
/// reaches whatever was going to get it — the scroll view that carries the day, the orbs
/// composited over her, anything added later. Nothing here adds a tap recogniser, and
/// ``LivingFaceTouchView/respond(to:)`` ignores every gesture state except `.began`, so
/// a quick tap is not merely unhandled — it is unreachable.
final class LivingFaceTouchView: UIView {
    /// What a completed press does. A `var` so `updateUIView` can refresh the closure
    /// without rebuilding the view and losing the recogniser mid-press.
    var onPress: () -> Void

    /// Fired when the press lands, so he knows he held it long enough **before** the
    /// screen has had time to change. Without it the only feedback is a session opening,
    /// which takes a round trip — and a gesture with no acknowledgement is one he holds
    /// twice.
    var onFeedback: () -> Void

    let press: UILongPressGestureRecognizer

    init(
        onPress: @escaping () -> Void,
        onFeedback: @escaping () -> Void = { UIImpactFeedbackGenerator(style: .soft).impactOccurred() }
    ) {
        self.onPress = onPress
        self.onFeedback = onFeedback
        self.press = UILongPressGestureRecognizer()
        super.init(frame: .zero)

        backgroundColor = .clear
        isOpaque = false

        press.minimumPressDuration = LiveFace.minimumPressDuration
        press.allowableMovement = LiveFace.allowableMovement
        press.numberOfTouchesRequired = 1
        // The three flags that keep every other touch on this screen behaving exactly
        // as it did. See the note above — this is the "additive" in "the gesture is
        // additive", expressed as configuration rather than as a promise.
        press.cancelsTouchesInView = false
        press.delaysTouchesBegan = false
        press.delaysTouchesEnded = false
        press.addTarget(self, action: #selector(handle))
        addGestureRecognizer(press)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not from a nib") }

    /// The press, decided on state alone.
    ///
    /// Split out from the `@objc` action so it can be driven directly: a test can fire
    /// every gesture state at it and assert that only one of them opens a session, with
    /// no simulator, no touch synthesis and no render loop.
    func respond(to state: UIGestureRecognizer.State) {
        // `.began` and nothing else. A long press reports `.began` once, when the
        // duration elapses, and then `.changed`/`.ended` as the thumb moves and lifts —
        // firing on `.ended` too would open a second session on every press.
        guard state == .began else { return }
        onFeedback()
        onPress()
    }

    @objc private func handle(_ recogniser: UILongPressGestureRecognizer) {
        respond(to: recogniser.state)
    }
}

/// ``LivingFaceTouchView``, as a SwiftUI view.
struct LivingFaceTouch: UIViewRepresentable {
    var onPress: () -> Void

    func makeUIView(context: Context) -> LivingFaceTouchView {
        LivingFaceTouchView(onPress: onPress)
    }

    func updateUIView(_ view: LivingFaceTouchView, context: Context) {
        view.onPress = onPress
    }
}
