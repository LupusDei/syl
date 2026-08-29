import SwiftUI
import SylKit

/// Owns the home screen's lifecycle; `HomeView` stays a pure function of values.
///
/// The split is the same one `ContentView` already makes and for the same reason: a
/// view with no observable objects of its own can be constructed and rendered in a test
/// without booting the app's object graph. Everything that observes lives here, and
/// everything that draws lives one level down.
struct HomeScreen: View {
    @ObservedObject var model: HomeViewModel
    /// Everything he owes, and the capture that writes into it.
    ///
    /// A second model rather than more surface on `HomeViewModel`, because the two answer
    /// different questions on different clocks: the day is rebuilt every minute so an
    /// item can turn from upcoming to due, and the list only changes when something is
    /// written or synced. Folding them together would re-read five hundred rows once a
    /// minute for a screen that shows a number.
    @ObservedObject var list: TodoListViewModel

    /// Where the Memory door leads.
    ///
    /// Handed in rather than built here so this screen stays renderable offscreen without
    /// booting the object graph — and defaulted to an empty sky so a preview, a test or a
    /// render is a sky with no stars rather than a crash.
    var sky: SkySource = { .empty }

    /// Where the From Syl door leads.
    ///
    /// Handed in for the same reason `sky` is, and defaulted to nil so a preview, a test
    /// or an offscreen render opens the screen against the disk alone rather than
    /// crashing or reaching for a network. `HomeScreen` has no backend of its own to
    /// build a live gateway from, and giving it one would hand this view the object
    /// graph the split exists to keep out of it.
    var sendings: SendingSource?

    /// How a long press on her face reaches the broker (`syl-chzl.7`).
    ///
    /// Defaulted to ``FaceGateway/offline`` for the reason `sendings` is defaulted: this
    /// screen has no backend of its own to build one from, and a preview, a test or an
    /// offscreen render must open without an object graph. Offline *refuses*, which is
    /// the correct behaviour rather than a stub — a long press with nothing behind it
    /// says "I cannot reach you", which is exactly what it means.
    var face: FaceGateway = .offline

    /// What actually draws her once the session is open (`syl-chzl.7.5`).
    ///
    /// Defaulted to ``FaceRenderer/notInThisBuild`` for the reason `face` is defaulted to
    /// offline: a preview or an offscreen render has no origin to point a web view at,
    /// and the honest default says so rather than showing a spinner over a session that
    /// is already billing.
    var renderer: FaceRenderer = .notInThisBuild

    @Environment(\.scenePhase) private var scenePhase

    /// Her live face. `@StateObject` because it owns a billable session and must survive
    /// this view being re-evaluated — a model rebuilt mid-session would leave the old one
    /// open with nobody holding it.
    @StateObject private var liveFace: LiveFaceModel

    init(
        model: HomeViewModel,
        list: TodoListViewModel,
        sky: @escaping SkySource = { .empty },
        sendings: SendingSource? = nil,
        face: FaceGateway = .offline,
        renderer: FaceRenderer = .notInThisBuild
    ) {
        self.model = model
        self.list = list
        self.sky = sky
        self.sendings = sendings
        self.face = face
        self.renderer = renderer
        _liveFace = StateObject(wrappedValue: LiveFaceModel(gateway: face))
    }

    /// Whether the list is up.
    ///
    /// A sheet rather than a second navigation push, and it is a considered choice. The
    /// hero is sized with `containerRelativeFrame(.vertical)` — one *visible* screen of
    /// its scroll container — and this layout has already been fixed once for exactly
    /// that reason, when the day's first two lines ended up behind the tab bar. A sheet
    /// leaves the day's geometry untouched.
    @State private var showingList = false

    /// The stack the orbs open into.
    ///
    /// Home had no navigation stack at all, which is why `HomeView.onOpen` existed and
    /// went nowhere. The wiring lives here rather than in `HomeView` deliberately:
    /// `HomeView` is a pure function of values that several squads are editing, and the
    /// call site it already carries — `SylOrb("Goals") { onOpen(.goals) }` — needed a
    /// handler, not a change.
    ///
    /// **The bar is hidden on home itself, and that is what makes the stack safe here.**
    /// A navigation bar appearing above the hero would take a strip out of precisely the
    /// measurement `OneScreenTall` exists to get right — the same defect the sheet above
    /// is avoiding. Two squads reached that conclusion independently, from opposite
    /// directions; the stack is kept for the goals drill-down and the list stays a sheet.
    /// **`NavigationPath`, not `[HomeView.Destination]`, and the difference is a bug the
    /// Commander hit.** A homogeneous typed path can only ever hold the one type it is
    /// declared with, so every `NavigationLink(value: GoalRoute(…))` inside the goals
    /// screens was inert — SwiftUI had nowhere to put the value, and tapping a goal did
    /// nothing at all. The list rendered perfectly, which is what made it look finished.
    ///
    /// A type-erased path carries both the orb's destination and the routes the screens
    /// beyond it push. Nothing else about the composition was wrong.
    @State private var path = NavigationPath()

    var body: some View {
        ZStack {
            // **Her surface is FIRST in this stack and its position never moves.**
            //
            // It goes in the instant a session opens — while she is still warming, behind
            // an opaque home screen — and comes out when the session is over. Presenting
            // her is a change of `zIndex` and nothing structural, because the page inside
            // it has spent the whole warm-up importing an SDK and joining a room and must
            // survive being shown. Building it at presentation time would throw that away
            // and start a second page over the same billing session.
            //
            // She arrives without a cross-fade. That was chosen out of a fear that has
            // since been measured and found groundless — a zero-opacity layer is not
            // throttled by WebKit, see `OccludedWebViewTests` — so it is now kept for the
            // reason that survives: her video starting is a real event and it is allowed
            // to look like one. A fade would be safe if anyone wants one.
            faceLayer

            homeStack
        }
        // **The tab bar is the last thing between an in-tree layer and a full screen.**
        // It is drawn by the `TabView` above this view, so a child cannot paint over it;
        // it has to be asked to leave. It comes straight back when she does.
        .toolbar(liveFace.isPresented ? .hidden : .visible, for: .tabBar)
        .task {
            model.start()
            // The list is read on launch, not on open. Its own `.task` below would be
            // enough to fill it, but the door at the foot of the day carries a count from
            // this same snapshot — a door that said nothing until it had been opened once
            // would hide the very to-dos it exists to surface.
            await list.refresh()
        }
        .onChange(of: scenePhase) { _, phase in
            // **Before the day, because this one costs money.** A live face in a
            // backgrounded app is a silent leak — this project's signature defect — and
            // the reaper that would eventually find it is a backstop, not the mechanism.
            // It now covers a session that is merely WARMING too, which is the likelier
            // one to be abandoned: nothing is covering his home screen, so putting the
            // phone away mid-wait is the natural thing to do. Foregrounding deliberately
            // does not reopen anything; see rule 3 on `LiveFaceModel`.
            Task { await liveFace.scenePhaseChanged(to: phase) }

            // Returning to the app is the moment the day is most likely to be stale —
            // reminders may have fired while it was backgrounded. The minute loop would
            // catch up eventually; waiting up to a minute to find out you are late is
            // not good enough.
            switch phase {
            case .active:
                model.start()
                Task { await model.refresh() }
                Task { await list.refresh() }
            case .background:
                model.stop()
            default:
                break
            }
        }
    }

    /// Her face, built before it is shown.
    ///
    /// ## What actually keeps the page alive — and it is not `zIndex`
    ///
    /// This used to say that `zIndex` was chosen over `opacity(0)` and `.hidden()`
    /// because WebKit throttles timers and suspends media for a view it considers not
    /// visible. **Measured on 2026-08-23 and that is false** (`syl-chzl.9`,
    /// `ios/SylTests/OccludedWebViewTests.swift`): occluded, hidden, fully transparent and
    /// even in a hidden window, the page runs at full speed and still reports
    /// `document.visibilityState === "visible"`. iOS derives page visibility from **window
    /// membership** and application state, not from whether any pixel can be seen.
    ///
    /// So the real rule is the one below, and it is stricter than a choice of modifier:
    /// **the layer must stay in the window.** A view with no window is the one placement
    /// WebKit does stop — `requestAnimationFrame` halts at its first frame and `play()`
    /// rejects with `AbortError` — and SwiftUI dropping this branch is exactly that. If
    /// ``LiveFaceModel/needsSurface`` ever went false mid-warm-up it would not hide her; it
    /// would kill the page over a session that is still billing.
    ///
    /// `zIndex` is kept because it says what is meant. It is no longer load-bearing.
    @ViewBuilder
    private var faceLayer: some View {
        if liveFace.needsSurface {
            // **No `ignoresSafeArea` here**, deliberately. Her background and the web view
            // bleed to the edges from inside; the layer itself keeps its insets, because
            // the "Let her go" bar is a `safeAreaInset` and a layer with no safe area
            // puts the only way out from under the notch.
            LiveFaceView(model: liveFace, renderer: renderer)
                .zIndex(liveFace.isPresented ? 1 : -1)
                .allowsHitTesting(liveFace.isPresented)
                // Not merely invisible: unreachable. VoiceOver must not find a live web
                // view sitting behind the home screen and read it out.
                .accessibilityHidden(!liveFace.isPresented)
        }
    }

    /// Everything that was here before her face was.
    private var homeStack: some View {
        NavigationStack(path: $path) {
            HomeView(
                snapshot: model.snapshot,
                loadFailure: model.loadFailure,
                // `nil` unless something of his is genuinely stuck, which is the
                // ordinary case and draws nothing at all.
                stall: StallNotice(model.stall),
                presence: model.presence,
                presenceIntensity: model.intensity,
                now: model.now,
                // The view stays a pure function of values; the tasks are owned here,
                // which is the same split `ContentView` makes and why the day can be
                // rendered offscreen without booting the object graph.
                onComplete: { moment in Task { await model.complete(moment) } },
                onPostpone: { moment in Task { await model.postpone(moment) } },
                onDismissRefusal: { moment in model.dismissRefusal(moment.id) },
                onOpen: { destination in
                    // Today is already this screen — the orb scrolls to it rather than
                    // pushing a second copy of it onto a stack, so it never gets here.
                    // Goals and Memory both lead somewhere now.
                    guard destination != .today else { return }
                    path.append(destination)
                },
                onCapture: capture,
                onOpenList: { showingList = true },
                // The whole opening mechanism. It reaches the hero and nothing else —
                // every closure above still does exactly what it did.
                onAwaken: { Task { await liveFace.awaken() } },
                // What he is told while she is on her way, and what he is told when she
                // never arrives. Nil in the ordinary case, so the home screen is exactly
                // the screen it was before this existed.
                awakening: liveFace.homeNotice,
                onCancelAwakening: { Task { await liveFace.dismissNotice() } }
            )
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: HomeView.Destination.self) { destination in
                switch destination {
                case .goals: GoalsScreen(store: model.store)
                // The default source reads nothing, which is the honest state of a brand
                // new pairing and stays honest until the device-scoped graph read lands —
                // at which point this line takes an adapter and nothing that draws moves.
                case .memory:
                    // The seam the two squads left. Without a source the door opens onto a
                    // permanently empty field that looks exactly like the truth.
                    MemoryScreen(source: sky)
                case .fromSyl:
                    // Without a live source this still opens — on the disk, which is
                    // where From Syl reads from first anyway. What it loses is the
                    // refresh, not the keepsakes.
                    FromSylScreen(
                        source: sendings ?? SendingSource(store: model.store, gateway: .offline))
                case .today: EmptyView()
                }
            }
        }
        // **Her face is no longer a `fullScreenCover`, and the reason is the whole bead.**
        //
        // A cover is a presentation, and a presentation can only carry a view built at
        // the moment it appears. That forced the old order — present, *then* start
        // loading — which is precisely the thirty seconds of "Waking her" the Commander
        // asked us to delete. Warming behind the home screen and presenting a page that
        // is already live means the surface must exist before it is shown, and a cover
        // cannot hold something that already exists.
        //
        // The argument the cover was chosen for survives intact. It was picked over a
        // sheet because a sheet can be dragged half-down and left there, billing at
        // twenty cents a minute behind a screen he thinks he dismissed. A layer in the
        // tree is stricter still: there is nothing to drag, and the one way out is the
        // button that settles the session.
        //
        // The ground is explicit and edge-to-edge because this view is now the thing
        // *hiding* a live web view during the warm-up. `HomeView` paints its own
        // full-bleed veil and always has; saying it again here means the property does
        // not silently rest on a detail two files away that nobody knows is load-bearing.
        .background(SylTheme.Colour.veilDeep.ignoresSafeArea())
        .sheet(isPresented: $showingList) {
            TodoListView(
                snapshot: list.snapshot,
                onCapture: capture,
                onClose: { showingList = false }
            )
            // The sheet's own ground. Without it the list floats on the system's default
            // sheet fill, which is a stock colour behind a screen whose acceptance
            // criterion is that it has none — and the veil would stop at its edges.
            .presentationBackground(SylTheme.Colour.veilDeep)
            .task { await list.refresh() }
        }
    }

    /// One capture, from either place it can be typed.
    ///
    /// The day's field and the list's field are the same write, deliberately: two capture
    /// paths would be two chances to disagree about what a capture is, which is the shape
    /// of mistake `plan.md` R1 warns about at the transport layer.
    ///
    /// The day is refreshed as well as the list because a captured to-do is `pinned:
    /// false` and `dueAt: nil` and therefore lands *behind the door* rather than on the
    /// spine — so the only thing that visibly changes on the home screen is the count on
    /// that door. If it did not move, capture from the day would look like it had done
    /// nothing at all.
    private func capture(_ text: String) {
        Task {
            await list.capture(text)
            await model.refresh()
        }
    }
}
