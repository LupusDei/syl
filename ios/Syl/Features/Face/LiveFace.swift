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
