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

    @Environment(\.scenePhase) private var scenePhase

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
        NavigationStack(path: $path) {
            HomeView(
                snapshot: model.snapshot,
                loadFailure: model.loadFailure,
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
                onOpenList: { showingList = true }
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
        .task {
            model.start()
            // The list is read on launch, not on open. Its own `.task` above would be
            // enough to fill it, but the door at the foot of the day carries a count from
            // this same snapshot — a door that said nothing until it had been opened once
            // would hide the very to-dos it exists to surface.
            await list.refresh()
        }
        .onChange(of: scenePhase) { _, phase in
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
