import SwiftUI

/// What killed the app, offered back to the Commander so he can hand it over.
///
/// This exists because Syl froze in chat and was terminated, twice, and the only
/// evidence anyone had was a photograph of the screen. Two real defects were found and
/// fixed by reasoning about the symptom, and the second report proved the reasoning had
/// not found the cause. **A crash nobody can read gets guessed at, and a guess ships a
/// fix for the wrong thing.**
///
/// The reports are collected on the device by ``CrashDiagnostics`` and stay there. They
/// are call stacks from his phone, so nothing uploads them on its own — the share sheet
/// is the whole transport, and he chooses. Same instinct as `GET /logs` needing a scope
/// of its own: the record of what a program did on his machine is not ordinary app data.
struct DiagnosticsSection: View {
    @ObservedObject var diagnostics: CrashDiagnostics

    var body: some View {
        Section("Diagnostics") {
            if diagnostics.reports.isEmpty {
                // Not an error state, and worth saying so plainly — an empty list here
                // reads as "the feature is broken" unless it tells you otherwise.
                Text("No crashes or hangs recorded. iOS delivers these on the launch after they happen.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(diagnostics.reports) { report in
                    ShareLink(item: report.fileURL) {
                        VStack(alignment: .leading, spacing: 2) {
                            LabeledContent(report.kind.capitalized) {
                                Text(report.receivedAt.formatted(date: .abbreviated, time: .shortened))
                            }
                            Text(report.summary)
                                .font(.footnote.monospaced())
                                .foregroundStyle(.secondary)
                                .lineLimit(3)
                        }
                    }
                }
            }
        }
    }
}
