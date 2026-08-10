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

    @Environment(\.scenePhase) private var scenePhase

    /// The stack the orbs open into.
    ///
    /// Home had no navigation stack at all, which is why `HomeView.onOpen` existed and
    /// went nowhere. The whole wiring for `syl-011.5.3` lives here rather than in
    /// `HomeView` deliberately: `HomeView` is a pure function of values that three other
    /// squads are editing this week, and the call site it already carries —
    /// `SylOrb("Goals") { onOpen(.goals) }` — needed a handler, not a change.
    ///
    /// The bar is hidden on home itself: the hero is sized to one visible screen, and a
    /// navigation bar appearing above it would take a strip out of exactly the measurement
    /// `OneScreenTall` exists to get right.
    @State private var path: [HomeView.Destination] = []

    var body: some View {
        NavigationStack(path: $path) {
            HomeView(
                snapshot: model.snapshot,
                presence: model.presence,
                presenceIntensity: model.intensity,
                now: model.now,
                onOpen: { destination in
                    // Only Goals leads anywhere today. Today is already this screen, and
                    // Memory belongs to `syl-010` — pushing a blank for either would be a
                    // door that opens onto a wall.
                    guard destination == .goals else { return }
                    path.append(destination)
                }
            )
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: HomeView.Destination.self) { destination in
                switch destination {
                case .goals: GoalsScreen(store: model.store)
                case .memory, .today: EmptyView()
                }
            }
        }
        .task {
            model.start()
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
            case .background:
                model.stop()
            default:
                break
            }
        }
    }
}
