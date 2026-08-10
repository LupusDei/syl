import Foundation
import MetricKit

/// What killed the app last time, in the app's own words.
///
/// ## Why this exists
///
/// Syl froze in chat and was killed, twice, and the only evidence available was a
/// screenshot. Two real defects were found and fixed by reasoning about the symptom —
/// and the second report proved the reasoning had not found the cause. **A crash nobody
/// can read is a crash that gets guessed at, and a guess ships a fix for the wrong
/// thing.** That is the actual defect this file closes.
///
/// iOS already knows. `MetricKit` hands an app its own diagnostics on the next launch —
/// crashes, and, crucially here, **hangs**, which is what a freeze-then-termination
/// actually is. It costs one subscription and nothing at runtime; the payloads arrive
/// on a background queue at most once a day, or immediately in debug via
/// `MXMetricManager.simulateDiagnosticReport`.
///
/// ## What it deliberately does not do
///
/// It does not phone home. These payloads describe the Commander's own device — call
/// stacks from his phone — and this project does not move his data off it without a
/// reason. They are written beside the app's other local state, and surfaced so he can
/// share one deliberately. Same instinct as `GET /logs` needing its own scope: the
/// record of what a program did on his machine is not ordinary app data.
///
/// ## What a report tells you
///
/// The three termination reasons look nothing alike and point at different fixes:
///
/// - **A hang** (`MXHangDiagnostic`) is the main thread not answering. That is the
///   quadratic-work family — layout, comparison, parsing on the wrong actor.
/// - **A crash with `0xdead10cc`** is holding a file lock in the background; with
///   `0x8badf00d`, a watchdog timeout at launch or resume.
/// - **A jetsam / memory report** is footprint, which points at media and caches rather
///   than at any logic at all.
///
/// Guessing between those three is exactly what this removes.
@MainActor
final class CrashDiagnostics: NSObject, ObservableObject {

    /// Summaries of what has been collected, newest first. Small enough to show.
    @Published private(set) var reports: [Report] = []

    /// One collected diagnostic, reduced to what is worth reading at a glance.
    struct Report: Identifiable, Equatable, Sendable {
        let id: String
        /// `hang`, `crash`, `disk write`, `cpu` — what the payload was.
        let kind: String
        /// When it was collected, not when it happened: MetricKit delivers in batches.
        let receivedAt: Date
        /// The one line worth reading — a termination reason, a hang duration.
        let summary: String
        /// Where the full payload was written.
        let fileURL: URL
    }

    private let directory: URL
    private let clock: () -> Date

    init(
        directory: URL? = nil,
        clock: @escaping () -> Date = { Date() }
    ) {
        self.directory =
            directory
            ?? FileManager.default
                .urls(for: .documentDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("diagnostics", isDirectory: true)
        self.clock = clock
        super.init()
    }

    /// Begin receiving. Safe to call more than once.
    ///
    /// Payloads for a run that crashed arrive on the *next* launch, so this has to be
    /// wired at startup rather than when someone opens a screen — by the time anyone
    /// thinks to look, the delivery has already been missed.
    func start() {
        try? FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        MXMetricManager.shared.add(self)
        loadExisting()
    }

    func stop() {
        MXMetricManager.shared.remove(self)
    }

    /// Everything already on disk, so a report survives the launch that collected it.
    private func loadExisting() {
        let files =
            (try? FileManager.default.contentsOfDirectory(
                at: directory,
                includingPropertiesForKeys: [.contentModificationDateKey]
            )) ?? []

        reports =
            files
            .filter { $0.pathExtension == "json" }
            .compactMap { url -> Report? in
                let modified =
                    (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?
                    .contentModificationDate
                return Report(
                    id: url.lastPathComponent,
                    kind: Self.kind(fromFileName: url.lastPathComponent),
                    receivedAt: modified ?? .distantPast,
                    summary: Self.firstInterestingLine(of: url),
                    fileURL: url
                )
            }
            .sorted { $0.receivedAt > $1.receivedAt }
    }

    /// Write one payload and remember it.
    private func record(kind: String, summary: String, json: Data) {
        let stamp = ISO8601DateFormatter().string(from: clock())
            .replacingOccurrences(of: ":", with: "-")
        let url = directory.appendingPathComponent("\(kind)-\(stamp).json")
        try? json.write(to: url)

        reports.insert(
            Report(
                id: url.lastPathComponent,
                kind: kind,
                receivedAt: clock(),
                summary: summary,
                fileURL: url
            ),
            at: 0
        )
    }

    private static func kind(fromFileName name: String) -> String {
        name.split(separator: "-").first.map(String.init) ?? "diagnostic"
    }

    /// A one-line gist, pulled without parsing the whole payload structure.
    private static func firstInterestingLine(of url: URL) -> String {
        guard let text = try? String(contentsOf: url, encoding: .utf8) else {
            return "Unreadable report"
        }
        for key in ["terminationReason", "hangDuration", "exceptionType", "signal"] {
            if let range = text.range(of: "\"\(key)\"") {
                let tail = text[range.lowerBound...].prefix(120)
                return String(tail).replacingOccurrences(of: "\n", with: " ")
            }
        }
        return "Collected \(url.lastPathComponent)"
    }
}

// MARK: - MetricKit

extension CrashDiagnostics: MXMetricManagerSubscriber {
    /// Ordinary metrics. Not what this is for, and deliberately ignored: the question
    /// is why the app died, not how long it took to launch on average.
    nonisolated func didReceive(_ payloads: [MXMetricPayload]) {}

    nonisolated func didReceive(_ payloads: [MXDiagnosticPayload]) {
        // MetricKit calls this off the main actor. The payloads are value types, so the
        // JSON is taken here and only the finished data crosses.
        let collected: [(kind: String, summary: String, json: Data)] = payloads.flatMap {
            payload -> [(String, String, Data)] in
            var out: [(String, String, Data)] = []

            for hang in payload.hangDiagnostics ?? [] {
                out.append(
                    (
                        "hang",
                        "Main thread unresponsive for \(hang.hangDuration.description)",
                        hang.jsonRepresentation()
                    )
                )
            }
            for crash in payload.crashDiagnostics ?? [] {
                // `terminationReason` is the field that separates a watchdog kill from
                // a memory kill from a real exception, which is the whole question.
                let reason = crash.terminationReason ?? "unknown termination"
                out.append(("crash", reason, crash.jsonRepresentation()))
            }
            for cpu in payload.cpuExceptionDiagnostics ?? [] {
                out.append(
                    ("cpu", "Sustained CPU exception", cpu.jsonRepresentation())
                )
            }
            for disk in payload.diskWriteExceptionDiagnostics ?? [] {
                out.append(
                    ("disk", "Excessive disk writes", disk.jsonRepresentation())
                )
            }
            return out
        }

        guard !collected.isEmpty else { return }
        Task { @MainActor [weak self] in
            for item in collected {
                self?.record(kind: item.kind, summary: item.summary, json: item.json)
            }
        }
    }
}
