import SwiftUI

/// Owns From Syl's lifecycle; ``FromSylListView`` stays a pure function of values.
///
/// The same split `HomeScreen` and `GoalsScreen` make, for the same reason: a view with
/// no observable objects of its own can be constructed and rendered in a test without
/// booting the app's object graph.
///
/// **The title he reads is "From Syl". The internal noun stays `sending`**, and those are
/// allowed to differ: one is what the code calls the thing she makes, the other is what a
/// person reads at the top of a screen. It names the sender rather than the file format,
/// because what arrives here is not a video — it is her.
struct FromSylScreen: View {
    @StateObject private var model: FromSylViewModel

    init(source: SendingSource) {
        _model = StateObject(wrappedValue: FromSylViewModel(source: source))
    }

    var body: some View {
        FromSylListView(snapshot: model.snapshot)
            // Refreshed on open rather than once at launch. The video lands minutes
            // after the words and nothing tells the phone — see `SendingSource`, which
            // asks again by name about anything still pending.
            .task { await model.refresh() }
    }
}
