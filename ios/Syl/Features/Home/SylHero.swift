import SwiftUI
import SylKit

/// Syl herself, floating in the veil.
///
/// ## What changed, and why the ribbon did not lose
///
/// The first home screen led with the day and kept Syl to a thin band. The Commander's
/// answer was that it was not as beautiful as the concept, and he is right — an app you
/// open forty times a day earns the right to be looked at, and a spine of text does not
/// do that on its own.
///
/// So the figure leads. This is not a reversal of proposal F's "a ribbon of light, not a
/// face" — F budgets exactly this as **`manifest`, shipped as pre-rendered art in the
/// bundle**, and is emphatic only that the *live, per-frame* character must not be a
/// photoreal head driven by a metered avatar service. That still holds: the art below is
/// a still, costing nothing per interaction, and the ribbon still carries every state
/// change. She is the portrait; the ribbon is the pulse.
///
/// ## Two paintings, not one painting on two backgrounds
///
/// `SylHero` resolves to a *different generated image* per appearance, through the
/// asset catalogue's `luminosity` variant. That is not a nicety — it is the only clean
/// fix for a real defect. The art carries its own background, so the pale daylight
/// version rendered on the night veil as a **bright rectangle floating in the dark**,
/// corners and all. No amount of edge masking removes that: masking a light box on a
/// dark ground just turns it into a light oval.
///
/// So the night appearance gets a version painted on a dark starfield, and each one
/// meets its own veil. Generating a second image costs eight credits against a grant
/// with roughly 481,000 left; fighting the first one with vignettes would have cost an
/// evening and still looked wrong.
///
/// **The scene clips only ever got the night painting**, which is why the appearance now
/// decides whether they play at all. In Day the hero shows the still, and the still is
/// the daylight painting — so the daylight case is covered by an asset that has existed
/// since the beginning rather than by a clip nobody rendered.
///
/// ## The motion
///
/// A still image of someone floating is a poster. Three cheap, slow transforms make her
/// weightless instead:
///
/// - **Buoyancy** — a vertical drift on a 9-second cycle.
/// - **Roll** — a sub-degree rotation on 13 seconds, coprime with the drift so the pair
///   never resynchronise into a visible loop.
/// - **Breath** — a scale swell under 1%, on 7 seconds.
///
/// None is individually perceptible. Together they read as suspended in air. The one
/// thing deliberately *not* done is a fast or large movement: she is drifting, not
/// bobbing, and the difference is entirely in the amplitude.
struct SylHero: View {
    /// Drives the aura's intensity so the art participates in presence rather than
    /// sitting on top of it, indifferent.
    var presence: PresenceState
    var intensity: Double

    /// Show the still even when scene clips are bundled.
    ///
    /// Set by the offscreen render path. `ImageRenderer` cannot capture an
    /// `AVPlayerLayer`, so with the scene playing the hero renders as an empty box and
    /// the resulting image proves nothing about the layout it exists to check.
    var prefersStill: Bool = false

    /// Hold her, and she is here (`syl-chzl.7`). Nil means the surface above has no live
    /// face to open — a preview, an offscreen render, a device that is not paired.
    ///
    /// **This is the whole opening mechanism and it is deliberately not a control.** The
    /// Commander's ruling: the clips are already her face, so pressing and holding one
    /// brings that face to life, and nothing new has to be explained because the target
    /// is the most obvious thing on the screen. See ``LiveFace`` for why the press is
    /// long, and ``LivingFaceTouchView`` for why nothing a tap used to do changed.
    ///
    /// Optional rather than a defaulted empty closure, because the difference is
    /// load-bearing: with no handler there is **no touch layer at all**, so a hero
    /// rendered offscreen or in a preview is exactly the view it was before this existed.
    var onAwaken: (() -> Void)?

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    /// The appearance this hero is actually being painted in — already resolved by
    /// `HomeView`, so an explicit Day arrives here as `.light` whatever iOS is set to.
    /// It decides between the clip and the still; see the note on "two paintings" above.
    @Environment(\.colorScheme) private var scheme

    /// Whether this view is actually on screen.
    ///
    /// **Scene phase is not enough, and assuming it was is a real defect the Commander
    /// hit.** `scenePhase == .active` means *the app is foregrounded*, which stays true
    /// the entire time he is reading chat or changing a setting. So the eight scene
    /// clips went on decoding forever behind another tab: a hardware video pipeline, a
    /// two-item-deep `AVQueuePlayer` and a `CADisplayLink`'s worth of compositing, all
    /// producing frames nobody can see, for as long as the app is open.
    ///
    /// A video that plays where it cannot be watched is pure cost — battery, thermals,
    /// and the memory a jetsam kill is measured against.
    @State private var isOnScreen = false

    /// Width ÷ height of the shipped art.
    ///
    /// Hard-coded, and it has to be. The edge masks below only work if they are measured
    /// against *the picture*, and SwiftUI will not tell you where a `.fit` image actually
    /// landed inside its frame — `.aspectRatio(.fit)` letterboxes, and a `.mask` applied
    /// afterwards is measured against the frame, so the gradient spends its whole fade
    /// in the empty margin and the picture keeps a hard rectangular edge. That shipped:
    /// the device showed a sharp-cornered rectangle floating on the veil.
    ///
    /// Knowing the ratio lets the frame be sized to the art exactly, so there is no
    /// letterbox and mask space and image space are the same space.
    ///
    /// **The scene clips set this value, and the stills were re-cropped to match.** The
    /// video is the primary medium now, so it is the video's shape that everything else
    /// conforms to; cropping the fallback stills costs 70 pixels of margin, while
    /// cropping the clips would have taken 70 pixels off her. Tests pin both the stills
    /// and every bundled clip against this constant.
    static let artAspect: Double = 784.0 / 1168.0

    var body: some View {
        GeometryReader { geometry in
            Group {
                if reduceMotion {
                    figure(in: geometry.size, drift: 0, roll: 0, breath: 1)
                } else {
                    TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { timeline in
                        let t = timeline.date.timeIntervalSinceReferenceDate
                        figure(
                            in: geometry.size,
                            drift: sin(t / 9 * .pi * 2) * 9,
                            roll: sin(t / 13 * .pi * 2) * 0.7,
                            breath: 1 + 0.008 * sin(t / 7 * .pi * 2)
                        )
                    }
                }
            }
            // **`GeometryReader` places its content top-LEADING, not centred**, and that
            // became visible the moment the art started filling rather than fitting.
            //
            // Fitting made the picture exactly as wide as the reader, so alignment never
            // mattered and nobody had to know. Filling makes it WIDER — and every point
            // of that overflow then hung off the right-hand edge, so the whole figure sat
            // pushed to the right of the screen. The Commander spotted it immediately;
            // it is not the art, which is centred in every clip.
            //
            // Framing to the reader's own size re-centres it, and clipping keeps the
            // overflow from painting under the day below.
            .frame(width: geometry.size.width, height: geometry.size.height)
            .clipped()
            // Over the whole figure, still or clip alike. Both are her, and a gesture
            // that worked on the video and not on the daylight still would be a gesture
            // that stops existing when he turns on Low Power Mode.
            //
            // Inside the `GeometryReader` and outside `figure(in:…)` on purpose: the
            // figure carries the buoyancy, roll and breath transforms, and a touch
            // target that drifts a centimetre on a nine-second cycle is a touch target
            // that misses.
            .overlay {
                if let onAwaken {
                    LivingFaceTouch(onPress: onAwaken)
                }
            }
        }
        .accessibilityElement()
        .accessibilityLabel("Syl")
        .accessibilityValue(HomeSnapshot.phrase(for: presence) ?? "Not present")
        // **VoiceOver cannot perform a long press**, so without this the one way into
        // her live face would be unreachable to the one person most likely to want to
        // talk rather than read. A named action is the same intent through the rotor —
        // and it is absent, not inert, when there is nothing to open, for the reason
        // `SylOrb.isReady` exists: an affordance that does nothing reads as broken.
        .modifier(AwakenAction(onAwaken: onAwaken))
    }

    private func figure(in size: CGSize, drift: Double, roll: Double, breath: Double) -> some View {
        // Fit the art to the space *by computing it*, so the view's bounds and the
        // picture's bounds are identical and the masks below land on the picture.
        // **Fill, not fit.** Fitting left the art standing in its own rectangle with the
        // veil around it, and because the art carries its own dark starfield that
        // rectangle was VISIBLE — a hard vertical seam down each side, which no amount
        // of edge fading removes, because a fade between two different darks is still a
        // boundary between two different darks. The Commander called them silly and he
        // is right.
        //
        // Filling the width deletes the problem rather than hiding it: there are no side
        // edges left to see. What overflows vertically is cropped, which costs a little
        // of the starfield above her head and nothing of her.
        let width = max(size.width, size.height * Self.artAspect)
        let height = width / Self.artAspect

        return ZStack {
            // The aura behind her. Brightens with presence, so `alert` genuinely lights
            // her up and `absent` leaves only the art.
            RadialGradient(
                colors: [
                    SylTheme.Colour.luminanceCore.opacity(0.55 * auraStrength),
                    SylTheme.Colour.luminance.opacity(0.20 * auraStrength),
                    .clear,
                ],
                center: .center,
                startRadius: 0,
                endRadius: width * 0.62
            )
            .blendMode(.plusLighter)

            // A bundled loop when there is one, the still otherwise. Both are framed
            // and masked identically, which is the whole point: swapping the media
            // must not change the composition by a pixel.
            Group {
                if !prefersStill, SceneCatalogue.shouldPlay(reduceMotion: reduceMotion, appearance: scheme) {
                    SceneVideo(isPlaying: isOnScreen && scenePhase == .active)
                        .onAppear { isOnScreen = true }
                        .onDisappear { isOnScreen = false }
                } else {
                    Image("SylHero")
                        .resizable()
                        // No `.fit` and no letterbox: the frame is already the art's own
                        // ratio, so `.fill` and `.fit` would agree. Stated as `.fill`
                        // because it is the one that cannot leave a margin if the ratio
                        // is ever slightly off.
                        .aspectRatio(contentMode: .fill)
                }
            }
                .frame(width: width, height: height)
                .clipped()
                // Melts her into the veil instead of ending at a rectangle.
                //
                // This was a single radial with `endRadius: width * 0.78`, and it did
                // nothing: on a frame roughly as tall as it is wide, the bottom edge
                // sits about 0.64 of the way along that radius — still fully opaque —
                // so the image ended in a hard horizontal seam across the screen. Two
                // axis-aligned gradients are both more predictable and easier to tune
                // than one radius that has to be right in every direction at once.
                //
                // The vertical stops are deliberately asymmetric: a short fade at the
                // top where she meets the status bar, and a long one at the bottom so
                // her dress dissolves into the veil rather than being cut off at the
                // ankles.
                // One mask now, and only vertical.
                //
                // The horizontal one is gone because there is nothing left for it to do:
                // the art fills the width, so it has no side edges. It was never really
                // fading an edge anyway — it was fading a seam between the art's own
                // starfield and the veil, which is a boundary a gradient cannot dissolve.
                //
                // The vertical stops stay asymmetric: a short fade at the top where she
                // meets the status bar, and a long one at the bottom so she dissolves
                // into the veil rather than being cut off at the ankles. The bottom fade
                // is longer than before, because the type and the orbs now sit ON it.
                .mask {
                    LinearGradient(
                        stops: [
                            .init(color: .clear, location: 0.00),
                            .init(color: .white, location: 0.10),
                            .init(color: .white, location: 0.52),
                            .init(color: .white.opacity(0.55), location: 0.78),
                            .init(color: .clear, location: 1.00),
                        ],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                }
                .scaleEffect(breath)
                .rotationEffect(.degrees(roll))
                .offset(y: drift)
        }
    }

    /// How hard the aura is driven, per state.
    ///
    /// `absent` is zero — she is not present, so nothing about her is lit, and only the
    /// art remains. That keeps the restraint rule intact even though the figure is now
    /// always on screen: presence is expressed by *light*, not by whether she exists.
    private var auraStrength: Double {
        switch presence {
        case .absent: return 0
        case .idle: return 0.35 + 0.15 * intensity
        case .concerned: return 0.30
        case .alert, .delighted, .manifest: return 0.9 + 0.1 * intensity
        default: return 0.6 + 0.3 * intensity
        }
    }
}

/// The rotor's way in, present only when there is a way in.
///
/// Its own modifier because `accessibilityAction` cannot be applied conditionally
/// inline — each branch would be a different view type.
private struct AwakenAction: ViewModifier {
    let onAwaken: (() -> Void)?

    func body(content: Content) -> some View {
        if let onAwaken {
            content.accessibilityAction(named: Text("Bring her here"), onAwaken)
        } else {
            content
        }
    }
}

/// One of the three doors under her.
///
/// A glass orb, not a button with an icon in it. The difference is the specular arc
/// across the top-left and the fact that the fill is a material rather than a colour —
/// both are what stop it reading as a circular `Button` with a tint.
struct SylOrb: View {
    let title: String
    let symbol: String
    /// Shown under the label when there is something to say. Nil for most of them, most
    /// of the time — a badge on every orb is a dashboard, which is what we already threw
    /// out once.
    var detail: String?

    /// Whether this orb leads anywhere yet.
    ///
    /// **An orb that looks exactly like the two beside it and does nothing when tapped is
    /// worse than one that is visibly not ready.** Memory belongs to `syl-010` and is not
    /// built; the Commander tapped it, and reasonably concluded the app was broken.
    ///
    /// So an unready orb dims, loses its press response, refuses the touch outright — a
    /// dead tap is the thing being fixed, not the thing to keep — and says so to
    /// VoiceOver rather than announcing a door that is a wall.
    var isReady: Bool = true

    var action: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pressed = false

    private let diameter: CGFloat = 82

    var body: some View {
        Button(action: action) {
            VStack(spacing: SylTheme.Metric.snug) {
                ZStack {
                    // A glass sphere, not a translucent disc.
                    //
                    // The first version was `.ultraThinMaterial` plus a rim, and against
                    // a pale veil it rendered as a plain white circle — the material had
                    // nothing darker behind it to frost, so it contributed nothing. What
                    // actually reads as glass here is the *shading across the sphere*: a
                    // diagonal wash that is lighter than the background at the top-left
                    // and darker at the bottom-right, so the eye infers a curved surface
                    // lit from where the veil's light already comes from.
                    Circle()
                        .fill(.ultraThinMaterial)
                        .overlay {
                            Circle().fill(
                                LinearGradient(
                                    colors: [
                                        SylTheme.Colour.luminanceCore.opacity(0.75),
                                        SylTheme.Colour.card.opacity(0.30),
                                        SylTheme.Colour.luminance.opacity(0.28),
                                    ],
                                    startPoint: .topLeading,
                                    endPoint: .bottomTrailing
                                )
                            )
                        }
                        .overlay {
                            // The specular highlight: a small bright arc near the top
                            // left, which is the single detail that most says "sphere".
                            Circle()
                                .trim(from: 0.56, to: 0.80)
                                .stroke(
                                    SylTheme.Colour.luminanceCore.opacity(0.95),
                                    style: StrokeStyle(lineWidth: 2.4, lineCap: .round)
                                )
                                .blur(radius: 1.4)
                                .padding(7)
                        }
                        .overlay {
                            Circle()
                                .strokeBorder(
                                    LinearGradient(
                                        colors: [
                                            SylTheme.Colour.luminanceCore.opacity(0.95),
                                            SylTheme.Colour.luminance.opacity(0.55),
                                            SylTheme.Colour.accent.opacity(0.40),
                                        ],
                                        startPoint: .topLeading,
                                        endPoint: .bottomTrailing
                                    ),
                                    lineWidth: 1.2
                                )
                        }
                        // Two shadows: a coloured bloom for the light it throws, and a
                        // tighter deeper one so it sits *above* the veil rather than
                        // being printed on it.
                        .shadow(color: SylTheme.Colour.luminance.opacity(0.45), radius: 16, y: 2)
                        .shadow(color: SylTheme.Colour.veilDeep.opacity(0.35), radius: 6, y: 3)
                        .frame(width: diameter, height: diameter)

                    Image(systemName: symbol)
                        .font(.system(size: 27, weight: .ultraLight))
                        .foregroundStyle(SylTheme.Colour.ink.opacity(0.75))
                }

                VStack(spacing: 1) {
                    Text(title)
                        .font(.system(.subheadline, design: .serif))
                        .foregroundStyle(SylTheme.Colour.ink)

                    if let detail {
                        Text(detail)
                            .font(SylTheme.Typeface.numeral)
                            .foregroundStyle(SylTheme.Colour.inkFaint)
                    }
                }
            }
            .scaleEffect(pressed && isReady && !reduceMotion ? 0.94 : 1)
            .animation(SylTheme.Motion.responsive, value: pressed)
            .contentShape(Rectangle())
            // Enough to read as "not yet", not so much that it reads as broken. The
            // composition keeps its third door; it simply is not open.
            .opacity(isReady ? 1 : 0.4)
        }
        .buttonStyle(.plain)
        .disabled(!isReady)
        .allowsHitTesting(isReady)
        // The press state has to come from a gesture rather than a ButtonStyle
        // configuration because the label is built here; a simultaneous zero-distance
        // drag gives press-and-release without eating the tap.
        .simultaneousGesture(
            DragGesture(minimumDistance: 0)
                .onChanged { _ in pressed = true }
                .onEnded { _ in pressed = false }
        )
        .accessibilityLabel(detail.map { "\(title), \($0)" } ?? title)
        .accessibilityHint(isReady ? "" : "Not here yet")
    }
}
