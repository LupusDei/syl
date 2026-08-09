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
    /// Nil when the host is not usable in a URL. Returning an optional rather than
    /// force-unwrapping: the host is typed in, and a stray space would otherwise trap
    /// the app on a settings screen.
    static func tailnet(host: String) -> ServerProfile? {
        guard let url = URL(string: "https://\(host)/api/v1") else { return nil }
        return ServerProfile(id: "tailnet", name: "Tailnet", baseURL: url)
    }

    /// The contract's base path. Part of the contract, not a setting.
    static let apiBasePath = "/api/v1"

    /// A profile from whatever the Commander actually typed.
    ///
    /// `npm run pair` prints `https://bastion.tail0000.ts.net/api/v1`, which is the
    /// thing most likely to be pasted; a person typing from memory writes
    /// `bastion.tail0000.ts.net`. Both have to work, and so does either with a
    /// trailing slash, a stray space from a keyboard, or the base path already on the
    /// end. Every one of those is a *correct* answer typed slightly differently, and
    /// refusing them is how a setup screen becomes the reason somebody gives up.
    ///
    /// What it will not do is guess a scheme other than `https`. The tailnet
    /// certificate is real and publicly trusted, so plain HTTP is either the mock (a
    /// deliberate choice, made by pasting the whole URL) or a mistake; silently
    /// downgrading a typo'd host to cleartext is not a favour.
    ///
    /// @returns `nil` when nothing usable can be made of the entry.
    static func from(entry: String) -> ServerProfile? {
        let trimmed = entry.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        // An explicit scheme means the whole URL was supplied — including, quite
        // possibly, a mock on http. Take it as given rather than rebuilding it.
        if trimmed.lowercased().hasPrefix("http://") || trimmed.lowercased().hasPrefix("https://") {
            guard let url = URL(string: normalise(trimmed)), url.host != nil else { return nil }
            return ServerProfile(
                id: url.scheme == "http" ? "custom" : "tailnet",
                name: url.host ?? "Server",
                baseURL: url
            )
        }

        // A bare host, possibly with the base path already stuck on the end.
        guard let url = URL(string: normalise("https://\(trimmed)")), let host = url.host else {
            return nil
        }
        // A host with a space, a slash in the middle, or other punctuation parses into
        // something that is not a hostname, and the resulting request fails much later
        // with a message about the network.
        guard host.contains("."), !host.contains(" ") else { return nil }
        return ServerProfile(id: "tailnet", name: host, baseURL: url)
    }

    /// Trailing slashes off, exactly one copy of the base path on.
    private static func normalise(_ value: String) -> String {
        var text = value
        while text.hasSuffix("/") { text.removeLast() }
        if text.hasSuffix(apiBasePath) { return text }
        return text + apiBasePath
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

        // Write through whenever the stored key disagrees with what this store will
        // actually use — not only when it is absent.
        //
        // The absent-only version had a hole: a stored URL matching no known profile
        // left the old value in `UserDefaults` while the UI showed a different server,
        // and the push registration path reads that key directly. The device would
        // have registered against a host the app was not talking to.
        if storedURL != selected.baseURL {
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
