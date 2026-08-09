import Foundation
import SylKit

/// Builds an API client from whatever the base URL is **right now**.
///
/// The client is constructed per call rather than cached, and that is the point.
/// A cached client holds a base URL captured at some earlier moment, and the moment
/// that matters — push registration, a notification action on a cold start — is
/// exactly the one that runs before any of the app's own setup. Adjutant cached it,
/// captured a default, and registered its device token against localhost; every push
/// then failed with no symptom other than silence.
///
/// Constructing one is cheap: an actor holding a URL, a session and a policy. There
/// is nothing to pool.
/// `@unchecked Sendable` for one reason: `UserDefaults` is thread-safe and documented
/// as such, but is not annotated `Sendable`. Holding the store rather than a snapshot
/// of its value is the whole design, so the alternative — caching the URL to satisfy
/// the checker — would reintroduce exactly the bug this type exists to prevent.
struct SylBackend: @unchecked Sendable {
    private let defaults: UserDefaults
    private let tokens: any TokenStore
    private let session: URLSession
    private let fallbackBaseURL: URL

    init(
        defaults: UserDefaults = .standard,
        tokens: any TokenStore,
        session: URLSession = .shared,
        fallbackBaseURL: URL = ServerProfile.mock.baseURL
    ) {
        self.defaults = defaults
        self.tokens = tokens
        self.session = session
        self.fallbackBaseURL = fallbackBaseURL
    }

    /// The base URL, read from `UserDefaults` on every access.
    var baseURL: URL {
        ServerProfileStore.storedBaseURL(defaults: defaults) ?? fallbackBaseURL
    }

    func client() -> APIClient {
        APIClient(
            configuration: ServerConfiguration(baseURL: baseURL),
            session: session,
            tokenProvider: TokenStoreProvider(store: tokens)
        )
    }
}
