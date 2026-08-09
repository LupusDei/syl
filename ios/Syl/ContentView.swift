import SwiftUI
import SylKit

/// Placeholder shell. The real app shell is `syl-003.3.1`; this exists so the target
/// has something to run and so the SylKit link is exercised by an actual build rather
/// than only by the test target.
struct ContentView: View {
    var body: some View {
        VStack(spacing: 8) {
            Text("Syl")
                .font(.largeTitle.weight(.semibold))
            Text("SylKit \(SylKit.version)")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .padding()
    }
}

#Preview {
    ContentView()
}
