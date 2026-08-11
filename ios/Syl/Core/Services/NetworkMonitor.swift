import Foundation
import Network

/// Whether the device thinks it has a network at all.
///
/// Worth having separately from "can I reach Syl", because the two failures deserve
/// different words. "No network" is the Commander's problem to notice; "network fine,
/// Mac unreachable" is the app's problem to keep retrying quietly. Reporting the
/// second as the first is how an app teaches someone to distrust it.
///
/// Note what this does **not** do: it does not gate requests. Under Tailscale the
/// extension is torn down when idle, so a path that looks satisfied can still fail the
/// first request while the tunnel establishes — and a path that looks unsatisfied can
/// come back a moment later. Retry with backoff is the mechanism; this is only the
/// label on the screen.
@MainActor
final class NetworkMonitor: ObservableObject {
    enum Reachability: Equatable, Sendable {
        case unknown
        case online(isExpensive: Bool)
        case offline

        var isOnline: Bool {
            if case .online = self { return true }
            return false
        }
    }

    @Published private(set) var reachability: Reachability = .unknown

    private let monitor: NWPathMonitor
    private let queue = DispatchQueue(label: "com.jmm.syl.network-monitor")
    private var started = false

    init(monitor: NWPathMonitor = NWPathMonitor()) {
        self.monitor = monitor
    }

    func start() {
        guard !started else { return }
        started = true
        monitor.pathUpdateHandler = { [weak self] path in
            let reachability: Reachability =
                path.status == .satisfied
                ? .online(isExpensive: path.isExpensive)
                : .offline
            Task { @MainActor in
                self?.reachability = reachability
            }
        }
        monitor.start(queue: queue)
    }

    func stop() {
        guard started else { return }
        monitor.cancel()
        started = false
    }
}
