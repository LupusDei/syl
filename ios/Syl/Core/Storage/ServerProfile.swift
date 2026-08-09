import Foundation
import SylKit

/// Where the app looks for Syl.
///
/// Two of these exist because the Mac is reachable two ways: over the tailnet from
/// anywhere, and directly on the LAN at home. Keeping them as named profiles rather
/// than one editable field means switching is a choice rather than a re-typing, and
/// it makes "which one was I on when this broke" answerable.
struct ServerProfile: Equatable, Codable, Sendable, Identifiable {
    let id: String
    let name: String
    let baseURL: URL

    init(id: String, name: String, baseURL: URL) {
        self.id = id
        self.name = name
        self.baseURL = baseURL
    }

    /// The Mac at home, over Tailscale. The `tailscale cert` certificate is real and
    /// publicly trusted, so no App Transport Security exception is needed — but it is
    /// a 90-day Let's Encrypt certificate that does not auto-renew, and an expired one
    /// is a silent outage on a timer.
    static func tailnet(host: String) -> ServerProfile {
        ServerProfile(
            id: "tailnet",
            name: "Tailnet",
            baseURL: URL(string: "https://\(host)/api/v1")!
        )
    }

    /// The mock server, `npm run mock`. Present so a simulator build is useful before
    /// the Mac is reachable.
    static let mock = ServerProfile(
        id: "mock",
        name: "Mock server",
        baseURL: URL(string: "http://127.0.0.1:4210/api/v1")!
    )
}

/// The store of record for the base URL.
///
/// **This is deliberately `UserDefaults` and not app state, and the distinction is a
/// scar.** Push registration happens from the app delegate, off whatever launch path
/// iOS chose — a cold start from a notification, a background wake, a normal launch —
/// and at that moment there may be no view model, no environment object and no
/// configured client. Adjutant read the base URL from app state there, found it
/// unset, fell back to a default, and registered its device token against
/// `localhost`. Every push then failed with no symptom other than silence.
///
/// Reading from `UserDefaults` means the answer is the same on every path, including
/// the ones that have not run any of the app's own setup.
@MainActor
final class ServerProfileStore: ObservableObject {
    /// The key the push registration path reads. Named as a constant so nothing has
    /// to spell it twice, and `nonisolated` because the registration path reads it
    /// from wherever iOS happened to launch the app.
    nonisolated static let selectedBaseURLKey = "syl.server.baseURL"
    nonisolated private static let profilesKey = "syl.server.profiles"

    private let defaults: UserDefaults

    @Published private(set) var profiles: [ServerProfile]
    @Published private(set) var selected: ServerProfile

    init(defaults: UserDefaults = .standard, fallback: ServerProfile = .mock) {
        self.defaults = defaults

        let stored: [ServerProfile] =
            (defaults.data(forKey: Self.profilesKey)
                .flatMap { try? JSONDecoder().decode([ServerProfile].self, from: $0) }) ?? []
        self.profiles = stored.isEmpty ? [fallback] : stored

        let storedURL = defaults.string(forKey: Self.selectedBaseURLKey).flatMap(URL.init(string:))
        self.selected =
            (storedURL.flatMap { url in (stored.isEmpty ? [fallback] : stored).first { $0.baseURL == url } })
            ?? (stored.first ?? fallback)

        // Write the fallback through on first launch so the registration path, which
        // reads UserDefaults directly and knows nothing about this type, always finds
        // a value.
        if storedURL == nil {
            defaults.set(selected.baseURL.absoluteString, forKey: Self.selectedBaseURLKey)
        }
        if stored.isEmpty {
            persistProfiles()
        }
    }

    var configuration: ServerConfiguration {
        ServerConfiguration(baseURL: selected.baseURL)
    }

    func select(_ profile: ServerProfile) {
        guard profiles.contains(where: { $0.id == profile.id }) else { return }
        selected = profile
        defaults.set(profile.baseURL.absoluteString, forKey: Self.selectedBaseURLKey)
    }

    func add(_ profile: ServerProfile) {
        profiles.removeAll { $0.id == profile.id }
        profiles.append(profile)
        persistProfiles()
    }

    /// The base URL as the push registration path reads it: straight out of
    /// `UserDefaults`, with no object graph in between.
    ///
    /// `nonisolated` and `static` on purpose. If reading this required a main-actor
    /// hop or a live instance, the delegate would be tempted to keep a copy — and a
    /// copy is exactly what goes stale and registers against localhost.
    nonisolated static func storedBaseURL(defaults: UserDefaults = .standard) -> URL? {
        defaults.string(forKey: selectedBaseURLKey).flatMap(URL.init(string:))
    }

    private func persistProfiles() {
        guard let data = try? JSONEncoder().encode(profiles) else { return }
        defaults.set(data, forKey: Self.profilesKey)
    }
}
