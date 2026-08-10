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

    var body: some View {
        HomeView(
            snapshot: model.snapshot,
            presence: model.presence,
            presenceIntensity: model.intensity,
            now: model.now
        )
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
