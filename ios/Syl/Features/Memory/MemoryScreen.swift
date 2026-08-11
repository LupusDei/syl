import SwiftUI

/// The sky, on the veil, behind the Memory orb.
///
/// A pure function of a finished ``PreparedSky``, so it can be rendered offscreen and
/// looked at — which for this feature is not a supplement to the tests, it is the check
/// the feature is accepted on.
///
/// ## What is deliberately not here
///
/// No filter bar. No search field. No legend. No count of what she knows. Each of those
/// would make this screen more *useful*, and the Commander decided explicitly that
/// usefulness is not the bar here — the admin instrument gets the filters and the feedback
/// and the decay curves, and the app gets beauty. A reviewer who adds any of them to make
/// it useful has broken the thing he asked for.
struct ConstellationView: View {
    /// The finished sky.
    var sky: PreparedSky

    /// Whether the source has answered. Until it has, this is bare veil — which is neither
    /// a spinner nor a false "she knows nothing about you".
    var hasRead: Bool = true

    /// What clock the sky is on. See ``ConstellationTime``.
    var time: ConstellationTime = .live

    /// Reports the size the sky must be laid out for.
    var onSize: (CGSize) -> Void = { _ in }

    @Environment(\.colorScheme) private var scheme

    var body: some View {
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

            GeometryReader { geometry in
                Constellation(sky: sky, time: time)
                    .onAppear { onSize(geometry.size) }
                    .onChange(of: geometry.size) { _, size in onSize(size) }
            }
            .ignoresSafeArea()

            if hasRead && sky.isEmpty {
                nothingYet
            }
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
            Text("Nothing yet")
                .font(SylTheme.Typeface.title)
                .foregroundStyle(SylTheme.Colour.ink)

            Text("I have not learned anything about you worth keeping. I will, as we talk.")
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
/// values.
struct MemoryScreen: View {
    @StateObject private var model: ConstellationViewModel

    /// Where the graph comes from. Defaults to nothing, which is the honest state until the
    /// device-scoped read lands — and is also the real state of a brand new pairing, so it
    /// is not a placeholder in either case.
    init(source: @escaping ConstellationSource = { .empty }) {
        _model = StateObject(wrappedValue: ConstellationViewModel(source: source))
    }

    /// The size the sky was last asked to fill.
    @State private var size: CGSize = .zero

    var body: some View {
        ConstellationView(
            sky: model.sky,
            hasRead: model.hasRead,
            onSize: { size = $0 }
        )
        .task(id: size) {
            if model.hasRead {
                await model.resize(to: size)
            } else {
                await model.read(size: size)
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

#Preview("Nothing yet") {
    NavigationStack {
        ConstellationView(sky: .empty)
    }
    .environment(\.colorScheme, .dark)
}
