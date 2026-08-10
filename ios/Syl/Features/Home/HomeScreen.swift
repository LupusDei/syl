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

    @Environment(\.scenePhase) private var scenePhase

    /// Whether the list is up.
    ///
    /// A sheet rather than a navigation push, and it is a considered choice. The hero is
    /// sized with `containerRelativeFrame(.vertical)` — one *visible* screen of its scroll
    /// container — and wrapping this screen in a `NavigationStack` changes what that
    /// measures. The layout already had to be fixed once for exactly this reason, when
    /// the day's first two lines ended up behind the tab bar. A sheet leaves the day's
    /// geometry untouched.
    @State private var showingList = false

    var body: some View {
        HomeView(
            snapshot: model.snapshot,
            presence: model.presence,
            presenceIntensity: model.intensity,
            now: model.now,
            onCapture: capture,
            onOpenList: { showingList = true }
        )
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
