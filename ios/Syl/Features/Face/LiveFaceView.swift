import SwiftUI
import SylKit

/// Where her live face is drawn (`syl-chzl.7.2`, T022).
///
/// ## Deliberately thin
///
/// Every decision this screen makes is made in ``LiveFaceModel`` and read here. That
/// split is the same one `HomeScreen`/`HomeView` and `ContentView`/`RootView` already
/// make, and it exists because the interesting failures on this surface — a session
/// opened twice, a session left running behind a backgrounded app, a refusal that
/// renders as a spinner — are all invisible to a snapshot and all assertable against the
/// model.
///
/// ## The video track is a seam, and it is empty on purpose
///
/// Rendering a realtime avatar needs a WebRTC client, and adding one is a dependency
/// decision with a build-graph and a review attached — `SylKit` is under a standing rule
/// of **zero external dependencies**, and the app target carries only SylKit and GRDB.
/// The transport half of this epic is also still being built. So the renderer arrives as
/// a value (``FaceRenderer``), the default one says honestly that this build cannot draw
/// her, and the day the client lands the change is one line at the call site.
///
/// The alternative — a spinner where the video will go — is the exact failure the epic
/// names: a face that is not coming must not look like a face that is loading.
struct LiveFaceView: View {
    @ObservedObject var model: LiveFaceModel
    /// What actually draws the avatar's video track. See the note above.
    var renderer: FaceRenderer = .notInThisBuild
    /// Injected so a test or a preview does not depend on the wall clock.
    var clock: () -> Date = { Date() }

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            SylTheme.Colour.veilDeep.ignoresSafeArea()

            switch model.standing {
            case .dormant:
                // Reachable for one frame while the cover dismisses. Nothing, rather
                // than a flash of something.
                Color.clear
            case .waking:
                waking
            case .here(let session):
                here(session)
            case .refused(let refusal):
                refused(refusal)
            }
        }
        .preferredColorScheme(.dark)
        // **The leak this project is named for.** A face nobody is looking at still
        // bills. `onDisappear` covers leaving the screen; `scenePhase` covers the app
        // being put away without the screen ever disappearing. They race and they are
        // both idempotent, which is the point — neither may be the one that is skipped.
        .onDisappear { Task { await model.withdraw() } }
        .task(id: tickIdentity) { await beat() }
    }

    /// Restarts the beat when the session changes, and stops it when she is not here.
    private var tickIdentity: String? {
        guard case .here(let session) = model.standing else { return nil }
        return session.sessionId
    }

    /// One beat a second while she is here: the meter, and the renewal that gets ahead
    /// of the cap.
    ///
    /// A second is chosen against the cap's thirty-second lead, not against the meter —
    /// a meter that ticks a little coarsely is fine, and being late to a renewal is her
    /// stopping mid-sentence.
    private func beat() async {
        guard tickIdentity != nil else { return }
        while !Task.isCancelled {
            await model.tick(at: clock())
            try? await Task.sleep(for: .seconds(1))
        }
    }

    // MARK: - Waking

    private var waking: some View {
        VStack(spacing: SylTheme.Metric.gutter) {
            SylHalo(
                phrase: "Coming",
                state: .thinking,
                intensity: 0.8,
                availableWidth: 320
            )
            Text("Opening a live session.")
                .font(SylTheme.Typeface.detail)
                .foregroundStyle(SylTheme.Colour.inkSoft)
        }
        .accessibilityElement(children: .combine)
    }

    // MARK: - Here

    @ViewBuilder @MainActor
    private func here(_ session: FaceSession) -> some View {
        VStack(spacing: 0) {
            // **The renderer decides, not the session.** `canJoin` asks whether the broker
            // minted NATIVE join credentials, which is the right question for a client that
            // joins a room itself and the wrong one for the client this app actually has: a
            // web view over the page Syl serves needs the session key and nothing else.
            // Asking the session would leave `FaceRenderer.web` permanently refusing to draw
            // a session it can draw perfectly well.
            if renderer.canDraw(session) {
                renderer.view(session)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                // A session that exists and cannot be drawn. Not a spinner: the broker
                // minted browser credentials, this is a phone, and saying so is the only
                // honest thing on offer — with the session closed by the ordinary path
                // the moment he leaves, so the mistake costs one press and not an hour.
                cannotDraw
            }

            meterBar
        }
        .safeAreaInset(edge: .top) { leaveBar }
    }

    private var cannotDraw: some View {
        VStack(spacing: SylTheme.Metric.step) {
            Image(systemName: "video.slash")
                .font(.system(size: 34, weight: .ultraLight))
                .foregroundStyle(SylTheme.Colour.inkFaint)
            Text("I am here, but this build cannot draw me")
                .font(SylTheme.Typeface.title)
                .foregroundStyle(SylTheme.Colour.ink)
                .multilineTextAlignment(.center)
            Text("The session opened and the phone has no way to show it yet. Closing it now.")
                .font(SylTheme.Typeface.detail)
                .foregroundStyle(SylTheme.Colour.inkSoft)
                .multilineTextAlignment(.center)
        }
        .padding(SylTheme.Metric.gutter)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
    }

    /// What this is costing.
    ///
    /// On his screen rather than only in the operator's view, because it is his money.
    /// A number that is not known renders as *unknown*; it never renders as zero, which
    /// would be a confident false claim about a meter that is running.
    private var meterBar: some View {
        HStack {
            Image(systemName: "dot.radiowaves.left.and.right")
                .foregroundStyle(SylTheme.Colour.accent)
                .accessibilityHidden(true)
            Text(LiveFaceView.meterLine(model.report))
                .font(SylTheme.Typeface.numeral)
                .foregroundStyle(SylTheme.Colour.inkSoft)
                .contentTransition(.numericText())
            Spacer()
        }
        .padding(.horizontal, SylTheme.Metric.gutter)
        .padding(.vertical, SylTheme.Metric.snug)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(LiveFaceView.meterLine(model.report))
    }

    /// The meter as one line. Pure and static so it can be asserted without a screen.
    ///
    /// **Nothing here may render an unknown number as zero.** Before the first report
    /// lands the honest line says the cost is not known yet; a "$0.00" would be a
    /// confident false claim about a meter that has been running since the session
    /// opened.
    static func meterLine(_ report: FaceSessionReport?) -> String {
        guard let report else { return "Live · cost not known yet" }
        let seconds = Int(report.meter.elapsedSeconds.rounded())
        let elapsed = String(format: "%d:%02d", seconds / 60, seconds % 60)
        let spent = String(format: "$%.2f", report.meter.dollars)
        guard report.budget.creditCeiling > 0 else {
            return "Live · \(elapsed) · \(spent)"
        }
        let today = String(format: "$%.2f", report.budget.dollarsSpentToday)
        return "Live · \(elapsed) · \(spent) · today \(today)"
    }

    private var leaveBar: some View {
        HStack {
            Spacer()
            Button {
                Task { await model.withdraw() }
            } label: {
                Label("Let her go", systemImage: "xmark.circle.fill")
                    .labelStyle(.titleAndIcon)
                    .font(SylTheme.Typeface.detail)
            }
            .buttonStyle(.plain)
            .foregroundStyle(SylTheme.Colour.ink)
            .padding(SylTheme.Metric.step)
        }
        .background(.ultraThinMaterial)
    }

    // MARK: - Refused

    /// **The requirement with no exceptions.** A long press that cannot open a session
    /// says so, here, in her words, with the difference between *try again* and *not
    /// today* expressed as whether there is a button.
    private func refused(_ refusal: FaceRefusal) -> some View {
        VStack(spacing: SylTheme.Metric.gutter) {
            Image(systemName: iconName(for: refusal))
                .font(.system(size: 34, weight: .ultraLight))
                .foregroundStyle(SylTheme.Colour.inkFaint)
                .accessibilityHidden(true)

            Text(refusal.sentence)
                .font(SylTheme.Typeface.title)
                .foregroundStyle(SylTheme.Colour.ink)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: SylTheme.Metric.gutter) {
                Button("Not now") { model.acknowledgeRefusal() }
                    .foregroundStyle(SylTheme.Colour.inkSoft)

                if model.offersAnotherTry {
                    Button("Try again") { Task { await model.awaken() } }
                        .foregroundStyle(SylTheme.Colour.accent)
                }
            }
            .font(SylTheme.Typeface.detail)
            .buttonStyle(.plain)
        }
        .padding(SylTheme.Metric.chapter)
        .transition(.opacity)
        .animation(reduceMotion ? nil : SylTheme.Motion.settle, value: refusal)
        .accessibilityElement(children: .contain)
    }

    private func iconName(for refusal: FaceRefusal) -> String {
        switch refusal {
        case .ceilingReached: return "creditcard.trianglebadge.exclamationmark"
        case .notReady: return "hourglass"
        case .unavailable: return "bolt.horizontal.circle"
        case .notPermitted: return "lock"
        case .unreachable: return "wifi.slash"
        case .unexplained: return "questionmark.circle"
        }
    }
}

/// What draws the avatar's video track.
///
/// A value rather than a protocol for the reason ``FaceGateway`` is one: the thing being
/// injected is a single function, and a struct of closures keeps the whole surface
/// `View`-shaped without a generic parameter running through every call site.
struct FaceRenderer {
    /// Whether this renderer can draw *this* session.
    ///
    /// Its own function rather than a property of ``FaceSession`` because it is a
    /// property of the RENDERER: what a session needs to be drawable depends entirely on
    /// what is doing the drawing. A native room client needs `roomName`/`serverURL`/
    /// `token`; the web view needs the session key, because the page turns that into a
    /// room itself. One type cannot answer for both, and the surface must never show a
    /// spinner over a session that is already costing money — see ``LiveFaceView``.
    var canDraw: (FaceSession) -> Bool = { _ in true }
    /// `@MainActor` because a renderer may build a `UIViewRepresentable`, whose
    /// initialiser is main-actor isolated — the web view is exactly that. Forming the
    /// closure stays free anywhere; only calling it needs the main actor, which every
    /// call site is: a SwiftUI `body`.
    var view: @MainActor (FaceSession) -> AnyView

    /// The honest default: this build has no realtime client, so it does not pretend to
    /// be loading one.
    ///
    /// ``canDraw`` is false, so ``LiveFaceView`` shows the sentence rather than this —
    /// the view below is the last resort for a call site that renders anyway.
    ///
    /// Computed rather than a `static let`: a stored one would be shared mutable state
    /// holding a non-`Sendable` closure, which Swift 6 refuses — correctly, since the
    /// closure builds views and views belong to the main actor.
    static var notInThisBuild: FaceRenderer {
        FaceRenderer(canDraw: { _ in false }) { _ in
            AnyView(
                VStack(spacing: SylTheme.Metric.step) {
                    Image(systemName: "person.crop.circle.badge.questionmark")
                        .font(.system(size: 40, weight: .ultraLight))
                        .foregroundStyle(SylTheme.Colour.inkFaint)
                    Text("Her video is not wired into this build yet")
                        .font(SylTheme.Typeface.detail)
                        .foregroundStyle(SylTheme.Colour.inkSoft)
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityElement(children: .combine)
            )
        }
    }
}
