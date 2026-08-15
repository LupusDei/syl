import SwiftUI

/// The sky, on the veil, behind the Memory orb — and somewhere he can go.
///
/// ## What this screen is for
///
/// Three things, and deliberately only three: **wander**, **touch a star**, and — the
/// Commander's own addition on 2026-08-11 — **touch a filament**. No filter bar. No search
/// field. No legend. No count of what she knows. Each of those would make this screen more
/// *useful*, and usefulness was explicitly not the bar here — the admin instrument gets the
/// filters and the feedback and the decay curves, and the app gets beauty. A reviewer who
/// adds any of them to make it useful has broken the thing he asked for.
///
/// ## Wander is not a nicety
///
/// > *"Wandering critical. Pinch drag zoom and select to view details. Tapping on edges or
/// > nodes should pop up their details."* — the Commander, 2026-08-11
///
/// It is the difference between something he looks at and somewhere he is. The state for it
/// is two numbers in ``ConstellationTransform``, bounded so no gesture can leave him staring
/// at emptiness with no way back, and everything downstream — the drawing, the hit test, the
/// accessibility elements — reads the same transform, so a pixel, a fingertip and a VoiceOver
/// cursor can never disagree about where a star is.
struct ConstellationView: View {
    /// The finished sky.
    var sky: PreparedSky

    /// Whether the source has answered. Until it has, this is bare veil — which is neither
    /// a spinner nor a false "she knows nothing about you".
    var hasRead: Bool = true

    /// Whether the read failed outright. See ``ConstellationSnapshot/unreachable``.
    var unreachable: Bool = false

    /// What clock the sky is on. See ``ConstellationTime``.
    var time: ConstellationTime = .live

    /// Reports the glass the sky must be laid out for — its size **and** what the app's own
    /// chrome takes off it. See ``ConstellationGlass``.
    var onGlass: (ConstellationGlass) -> Void = { _ in }

    /// What he touched. Seeded from `opensWith` so an offscreen render can be handed a
    /// selection — a `Canvas` with a card over it is one of the two pictures on this screen
    /// worth looking at, and neither `ImageRenderer` nor a preview can tap anything.
    @State private var selection: ConstellationHit?

    /// Where he is standing, between gestures.
    @State private var transform: ConstellationTransform

    /// How tall the card turned out to be, measured. The sky pans the selection above
    /// exactly this and no further.
    @State private var cardHeight: CGFloat = 0

    /// The live deltas of a gesture in flight. `@GestureState` rather than `@State` so an
    /// interrupted gesture — a call, a notification, a third finger — cannot strand the sky
    /// half way through a pinch: SwiftUI resets these to their initial values on its own.
    @GestureState private var livePan: CGSize = .zero
    @GestureState private var liveZoom = LiveZoom.none

    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(
        sky: PreparedSky,
        hasRead: Bool = true,
        unreachable: Bool = false,
        time: ConstellationTime = .live,
        opensWith: ConstellationHit? = nil,
        opensAt: ConstellationTransform = .identity,
        onGlass: @escaping (ConstellationGlass) -> Void = { _ in }
    ) {
        self.sky = sky
        self.hasRead = hasRead
        self.unreachable = unreachable
        self.time = time
        self.onGlass = onGlass
        _selection = State(initialValue: opensWith)
        _transform = State(initialValue: opensAt)
    }

    // MARK: - Where he is standing

    /// The transform as it is *right now*, including whatever gesture is in flight.
    ///
    /// Zoom first about the pinch's own focus, then the drag, then the bound — so two
    /// fingers that pinch and slide at once do both, and the clamp has the last word either
    /// way. Recomputed rather than stored, because a stored copy of a gesture in flight is
    /// a copy that can be left behind when the gesture is cancelled.
    private var live: ConstellationTransform {
        transform
            .zoomed(by: liveZoom.magnification, about: liveZoom.focus)
            .panned(by: livePan)
            .clamped(within: sky.contentBounds, viewSize: sky.size)
    }

    /// What the touch lit. See ``ConstellationEmphasis``.
    private var emphasis: ConstellationEmphasis {
        ConstellationEmphasis(selecting: selection, in: sky)
    }

    private var subject: ConstellationSubject? {
        selection.flatMap { sky.subject(for: $0) }
    }

    var body: some View {
        // **The one measurement, and it is taken here on purpose.**
        //
        // A `GeometryReader` reports the size it was *proposed*; nothing laid out inside it
        // can change that. So a reader at the root of the screen is a measurement of the
        // glass, full stop — and the sky's layout, which is a function of that number, is a
        // function of the screen and of nothing that is drawn on it.
        //
        // It used to be measured by a reader **inside** the `ZStack`, which is a measurement
        // of the stack rather than of the screen. The card was a member of that stack and
        // reserved its band out of the sky's own height, so the stack grew, the reader
        // reported the larger number, the sky was laid out for it, and the band grew again:
        // fifty-two points a pass, without limit, reproduced in `ConstellationRunawayTests`
        // at 852 → 904 → 956 → … → 1164. `ConstellationLayout`'s field is half the height, so
        // the whole star field spread as it went. **That was the endless zoom**, and nothing
        // in ``ConstellationTransform`` was ever involved — `maximumScale` is four, and what
        // he photographed was spread ten times.
        GeometryReader { proxy in
            let chrome = ConstellationChrome(
                top: proxy.safeAreaInsets.top, bottom: proxy.safeAreaInsets.bottom)
            let glass = ConstellationGlass(
                size: CGSize(
                    width: proxy.size.width
                        + proxy.safeAreaInsets.leading + proxy.safeAreaInsets.trailing,
                    height: proxy.size.height + chrome.top + chrome.bottom),
                chrome: chrome)

            sky(on: glass)
                .onAppear { onGlass(glass) }
                .onChange(of: glass) { _, measured in onGlass(measured) }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                // The serif, as on chat's bar and the goals list. A stock system title here
                // is the single most visible way a new screen announces that it belongs to
                // a different app from the rest of Syl.
                Text("What I know")
                    .font(SylTheme.Typeface.title)
                    .foregroundStyle(SylTheme.Colour.ink)
                    .accessibilityAddTraits(.isHeader)
            }
        }
        .toolbarBackground(.hidden, for: .navigationBar)
    }

    /// Everything on the glass. Every drawn layer reaches the edges; only the card is held
    /// inside the safe area, because it is the one thing here made of words.
    private func sky(on glass: ConstellationGlass) -> some View {
        ZStack {
            SylTheme.Veil()
                .ignoresSafeArea()

            deepening

            // Air. Fewer and fainter than on home, because here the field is not the only
            // thing suspended in it — the stars are doing that job, and a mote field at
            // full strength would compete with the faintest of them for exactly the same
            // pixels.
            MoteField(count: 22, presence: 0.55)
                .ignoresSafeArea()
                .allowsHitTesting(false)

            Constellation(
                sky: self.sky,
                time: time,
                transform: live,
                emphasis: emphasis,
                onSelect: select
            )
            .contentShape(Rectangle())
            // **The tap is in the same space the stars were laid out in**, which is the
            // whole glass: this layer ignores the safe area, so its local origin is the
            // top-left corner of the screen, exactly where a `PreparedSky`'s origin is.
            .onTapGesture { location in touch(at: location) }
            .gesture(SimultaneousGesture(drag, pinch))
            .ignoresSafeArea()

            if hasRead && self.sky.isEmpty {
                nothingYet
            }
        }
        // **An overlay, not a member of the stack.** An overlay is proposed its host's size
        // and can never change it, which is the property that makes the ring above
        // impossible rather than merely unlikely. It is also what a card *is*: something
        // drawn over the sky, not something added to it.
        .overlay(alignment: .bottom) { card(on: glass) }
    }

    // MARK: - Wandering

    /// Drag. Four points of slop before it starts, so a tap that trembles is still a tap.
    private var drag: some Gesture {
        DragGesture(minimumDistance: 4)
            .updating($livePan) { value, state, _ in state = value.translation }
            .onEnded { value in
                transform = transform.panned(by: value.translation)
                    .clamped(within: sky.contentBounds, viewSize: sky.size)
            }
    }

    /// Pinch, about the point between his fingers rather than about the centre of the
    /// screen. See ``ConstellationTransform/zoomed(by:about:)``.
    private var pinch: some Gesture {
        MagnifyGesture(minimumScaleDelta: 0.01)
            .updating($liveZoom) { value, state, _ in
                state = LiveZoom(magnification: value.magnification, focus: value.startLocation)
            }
            .onEnded { value in
                transform = transform
                    .zoomed(by: value.magnification, about: value.startLocation)
                    .clamped(within: sky.contentBounds, viewSize: sky.size)
            }
    }

    /// A gesture in flight, as a value. `none` is the identity, so the composition in
    /// ``live`` needs no branch for "not pinching".
    private struct LiveZoom: Equatable {
        var magnification: Double
        var focus: CGPoint
        static let none = LiveZoom(magnification: 1, focus: .zero)
    }

    // MARK: - Touching

    /// What he hit, or nothing — and nothing is an answer: tapping empty sky puts the card
    /// away and lets the whole field come back up to its own brightness.
    private func touch(at location: CGPoint) {
        select(ConstellationHitTest.hit(at: location, in: sky, transform: live))
    }

    private func select(_ hit: ConstellationHit) {
        select(Optional(hit))
    }

    private func select(_ hit: ConstellationHit?) {
        withAnimation(reduceMotion ? nil : SylTheme.Motion.settle) {
            selection = hit
            makeRoom()
        }
    }

    /// Pan the selection clear of the card.
    ///
    /// **The card must not cover what he touched**, and that is the whole reason selection
    /// is a transform rather than a highlight. A card rising over the star he just asked
    /// about hides the answer behind the question.
    ///
    /// Only ever as far as it has to: ``ConstellationTransform/revealing(_:between:and:within:viewSize:)``
    /// returns the sky untouched when the selection is already in the clear, so most taps
    /// move nothing at all.
    private func makeRoom() {
        guard let subject, sky.size.height > 0 else { return }

        let point: CGPoint
        switch subject {
        case .star(let star):
            point = star.anchor

        case .filament(let filament):
            // **A thread's subject is the two things it relates**, and the card says both by
            // name — so the picture has to show both, not merely the line between them.
            // Clearing the middle of the curve leaves an endpoint under the card perfectly
            // often, which is the card hiding half the answer it just gave.
            //
            // So the lowest of the three points that matter, and `revealing` does the rest:
            // it moves the minimum, and the clamp stops it if the sky runs out first.
            let apex = ConstellationHitTest.apex(of: filament)
            point = [filament.from, filament.to, apex].max(by: { $0.y < $1.y }) ?? apex
        }

        // **`transform`, never `live`.** `live` is the stored transform with whatever gesture
        // is in flight composed on top of it, and writing that back stores the gesture — so
        // the next read of `live` composes it a *second* time, and every read after that
        // composes it again. A pinch that is still under his fingers when the card measures
        // itself would be applied twice, then four times. `ConstellationSelectionTests`
        // asserts the invariant this restores: **selecting something never changes the
        // scale.** Selection pans; only his fingers zoom.
        transform = transform.revealing(
            point,
            between: ConstellationBand.headroom(sky.chrome),
            and: ConstellationBand.skyline(
                forCardOf: cardHeight, in: sky.size, chrome: sky.chrome),
            within: sky.contentBounds,
            viewSize: sky.size)
    }

    // MARK: - The card

    @ViewBuilder
    private func card(on glass: ConstellationGlass) -> some View {
        if let subject {
            let ceiling = ConstellationBand.tallestCard(
                in: glass.size, chrome: glass.chrome)

            ConstellationCard(
                subject: subject,
                // Where it starts scrolling inside itself rather than growing — and it is
                // not a taste decision. See ``ConstellationBand/tallestCard(in:chrome:)``:
                // past this the sky physically cannot pan a selection out from under the
                // card, because the deepest any star can be brought is the middle of the
                // glass.
                ceiling: ceiling,
                onDismiss: { select(nil) },
                onHeight: { height in
                    // A tolerance, for the same reason `resize` uses one: a sub-pixel
                    // difference cannot move anything on screen, and acting on it here
                    // restarts the settle spring on a sky that had already arrived.
                    guard abs(height - cardHeight) >= 1 else { return }
                    cardHeight = height
                    withAnimation(reduceMotion ? nil : SylTheme.Motion.settle) { makeRoom() }
                }
            )
            .padding(.horizontal, SylTheme.Metric.step)
            // **The cap, enforced by giving the card nothing more to grow into.**
            //
            // A `maxHeight` here would make it *flexible* rather than bounded and hand it
            // every one of those points — the mistake that cost two renders, documented on
            // ``ConstellationCard``. A **fixed** band of exactly the ceiling, with the card
            // hugging its own words at the foot of it, is a cap: `ViewThatFits` is proposed
            // the ceiling and takes the scrolling branch exactly when it should.
            //
            // It used to be reserved with `.padding(.top, sky.size.height − ceiling)` on a
            // card inside the `ZStack`, which is where the runaway lived.
            .frame(height: ceiling, alignment: .bottom)
            .padding(.bottom, SylTheme.Metric.step)
            // **Reduce Motion keeps the pan and drops the rise.** Pan and zoom are his own
            // fingers and stay exactly as they are at every setting; a card that flies up on
            // its own is automatic motion nobody asked for, so it fades instead.
            .transition(
                reduceMotion
                    ? .opacity
                    : .move(edge: .bottom).combined(with: .opacity))
        }
    }

    // MARK: - Ground

    /// **Stars need something to be bright against, and the veil alone is not it.**
    ///
    /// This was not here for the first render and the render is why it is. The veil is
    /// three enormous soft blooms over a gradient, and behind the hero art or a column of
    /// text that reads as weather. Behind nothing at all it fills the screen edge to edge
    /// and the ground came back a uniform pale grey — a night sky with no night in it, and
    /// every faint memory in the graph invisible against it. `plusLighter` only reads as
    /// light where there is darkness to add to; that is documented for the ribbon and it is
    /// twice as true for a point source.
    ///
    /// So the veil is pushed back down. What survives is its motion and its colour, which
    /// is exactly what a nebula behind a star field is, and the vignette gives the sky a
    /// dome rather than a rectangle.
    private var deepening: some View {
        ZStack {
            SylTheme.Colour.veilDeep.opacity(scheme == .dark ? 0.78 : 0.60)

            RadialGradient(
                colors: [.clear, SylTheme.Colour.veilDeep.opacity(scheme == .dark ? 0.85 : 0.42)],
                center: .center,
                startRadius: 120,
                endRadius: 620
            )
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
    }

    /// An honest empty sky.
    ///
    /// It has to read as a **statement**, not as a failed load. This is the state a brand
    /// new pairing is in, and a blank screen that looks broken teaches him to distrust the
    /// one surface that is not lying to him.
    private var nothingYet: some View {
        VStack(spacing: SylTheme.Metric.snug) {
            Text(unreachable ? "I can't reach my memory" : "Nothing yet")
                .font(SylTheme.Typeface.title)
                .foregroundStyle(SylTheme.Colour.ink)

            Text(
                unreachable
                    // Never "nothing to show". The app does not know what there is, and
                    // saying she has learned nothing would be inventing an answer out of
                    // its own failure to ask.
                    ? "This device could not reach the graph, so I don't know what to show you yet."
                    : "I have not learned anything about you worth keeping. I will, as we talk."
            )
                .font(SylTheme.Typeface.detail)
                .foregroundStyle(SylTheme.Colour.inkSoft)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 260)
        }
        .padding(SylTheme.Metric.gutter)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - The screen

/// Owns the constellation's lifecycle; ``ConstellationView`` stays a pure function of
/// values plus his own two fingers.
struct MemoryScreen: View {
    @StateObject private var model: ConstellationViewModel

    /// Where the graph comes from. Defaults to nothing, which is the honest state until the
    /// device-scoped read lands — and is also the real state of a brand new pairing, so it
    /// is not a placeholder in either case.
    init(source: @escaping SkySource = { .empty }) {
        _model = StateObject(wrappedValue: ConstellationViewModel(source: source))
    }

    /// The glass the sky was last asked to fill.
    @State private var glass: ConstellationGlass = .none

    var body: some View {
        ConstellationView(
            sky: model.sky,
            hasRead: model.hasRead,
            unreachable: model.sky.unreachable,
            onGlass: { glass = $0 }
        )
        .task(id: glass) {
            if model.hasRead {
                await model.resize(to: glass)
            } else {
                await model.read(glass: glass)
            }
        }
    }
}

// MARK: - Previews

#Preview("A sky") {
    NavigationStack {
        ConstellationView(
            sky: SkyPreparer(now: ConstellationFixture.now)
                .prepare(.fixture, size: CGSize(width: 393, height: 852))
        )
    }
    .environment(\.colorScheme, .dark)
}

#Preview("A star, touched") {
    NavigationStack {
        ConstellationView(
            sky: SkyPreparer(now: ConstellationFixture.now)
                .prepare(.fixture, size: CGSize(width: 393, height: 852)),
            opensWith: .star("memory.dad.workshop")
        )
    }
    .environment(\.colorScheme, .dark)
}

#Preview("Nothing yet") {
    NavigationStack {
        ConstellationView(sky: .empty)
    }
    .environment(\.colorScheme, .dark)
}
