import Foundation
import SwiftUI
import SylKit

// MARK: - Where bytes may come from

/// The paired server, and nothing beside it.
///
/// ## Why this type exists at all (D5, T031)
///
/// `Attachment` carries **no URL**, on purpose — the client composes the path from the
/// id against the server it is paired with. That makes an off-origin fetch impossible
/// *by construction* today, and this type is what keeps it impossible tomorrow. It is
/// the same argument, and the same rule, as ``AdminNavigationPolicy``: a remote image
/// in a transcript leaks a read receipt and the Commander's IP to whoever hosts it, and
/// a client that will fetch whatever URL it is handed is an SSRF surface pointed at the
/// tailnet — one that carries a live bearer token, because these fetches are
/// authenticated.
///
/// So composition and refusal are the same function. ``url(for:variant:)`` builds the
/// URL and then puts it back through ``verify(_:)`` before returning it, which means
/// the guard sits on the *only* path the loader has to a URL rather than beside it. A
/// future change that lets a URL in from outside meets the same check without anyone
/// having to remember to add one.
///
/// ## What a naive implementation gets wrong
///
/// Every one of these is somebody else's server, every one is refused, and there is a
/// test for each:
///
/// - `https://reason-2.tail714e0e.ts.net.evil.com/…` — a **prefix** match passes this,
///   and a prefix match is what somebody writes first.
/// - `https://admin.reason-2.tail714e0e.ts.net/…` — a **suffix** match passes this.
/// - `https://reason-2.tail714e0e.ts.net@evil.com/…` — a match on the URL **string**
///   passes this; the authority host is `evil.com`.
/// - `http://reason-2.tail714e0e.ts.net/…` — the right host, in cleartext, publishing
///   the bearer token to every hop.
/// - `https://reason-2.tail714e0e.ts.net:8443/…` — the right host and scheme, a
///   different port, and therefore a different security principal.
///
/// The rule is whole-origin equality via ``WebOrigin``, which parses the authority
/// rather than reading the string, and compares `(scheme, host, effective port)`.
struct AttachmentSource: Equatable, Sendable {
    /// Why a fetch was refused. Carried rather than collapsed to nil so the refusal can
    /// be shown and logged — a view that simply does nothing is indistinguishable from
    /// a broken one, which is the whole complaint T035 makes about a spinner.
    enum Refusal: String, Error, Equatable, Sendable {
        /// Not a web origin at all: `javascript:`, `data:`, `file:`, a custom scheme, or
        /// no host.
        case notAWebOrigin
        /// A real web origin, and not the paired one.
        case differentOrigin
        /// The attachment id is not of the form the service mints. Rejected before it
        /// can reach a path, so `../../logs` never becomes a path segment.
        case malformedIdentifier
        /// The components would not compose into a URL.
        case unbuildable
    }

    /// The paired origin. Whole-origin equality is the entire rule.
    let origin: WebOrigin
    /// The API path prefix carried by the paired base URL — `/api/v1`. Kept because the
    /// attachment path in the contract is relative to it.
    let basePath: String

    /// - Returns: `nil` when the base URL is not a web origin. There is deliberately no
    ///   fallback. A source that could not determine an origin would have to allow
    ///   everything, and "allow everything" is the state this type exists to make
    ///   unrepresentable.
    init?(baseURL: URL) {
        guard let origin = WebOrigin(url: baseURL) else { return nil }
        self.origin = origin
        // Trailing slashes off, so `…/api/v1/` and `…/api/v1` compose identically.
        var path = baseURL.path
        while path.hasSuffix("/") { path.removeLast() }
        self.basePath = path
    }

    /// The URL for one attachment's bytes.
    ///
    /// Ask for `.thumb` only when ``Attachment/hasThumbnail`` is true — a thumbnail that
    /// does not exist is a `404`, never a silent fallback to the full file.
    func url(for id: SylID, variant: AttachmentVariant = .original) -> Result<URL, Refusal> {
        // Checked before it can become a path segment. The id is server-supplied, and
        // `..` or a slash inside one would walk out of `/attachments/` — cheap to
        // refuse, and the refusal costs nothing on the happy path.
        guard SylIDs.isWellFormed(id) else { return .failure(.malformedIdentifier) }

        let endpoint = SylAPI.attachmentPath(id, variant: variant)

        var components = URLComponents()
        components.scheme = origin.scheme
        components.host = origin.host
        components.port = origin.isDefaultPort ? nil : origin.port
        components.path = basePath + endpoint.path
        if !endpoint.query.isEmpty {
            components.queryItems = endpoint.query.map { URLQueryItem(name: $0.name, value: $0.value) }
        }

        guard let url = components.url else { return .failure(.unbuildable) }
        // Composed here, and immediately re-checked. Belt and braces on purpose: the
        // check is what is load-bearing, so it must be on the path rather than beside
        // it.
        return verify(url)
    }

    /// The whole rule, applied to a URL from anywhere.
    func verify(_ url: URL) -> Result<URL, Refusal> {
        guard let candidate = WebOrigin(url: url) else { return .failure(.notAWebOrigin) }
        guard candidate == origin else { return .failure(.differentOrigin) }
        return .success(url)
    }
}

// MARK: - The four states

/// What the loader knows about one attachment's bytes.
///
/// Four states, and the fourth is the one that matters. A loader with only
/// `idle · loading · loaded` has nowhere to put "the tailnet is down and I do not have
/// these bytes", so it stays in `loading` forever and the view spins forever. **Stale
/// is a state, not a lie** — and neither is "unreachable". See ``AttachmentUnavailable``.
enum AttachmentLoadState: Equatable, Sendable {
    case idle
    case loading
    case loaded(Data)
    case unavailable(AttachmentUnavailable)

    var data: Data? {
        if case .loaded(let data) = self { return data }
        return nil
    }
}

/// Why there are no bytes, said in terms someone can act on.
enum AttachmentUnavailable: Equatable, Sendable {
    /// There is no route to the Mac. The commonest case by far and the one that must
    /// never render as a spinner: the picture exists, it is simply not here.
    case offline
    /// The URL was not the paired server's. Should be unreachable — the client composes
    /// the path itself — and is surfaced rather than swallowed precisely because if it
    /// ever happens, something is very wrong.
    case refused(AttachmentSource.Refusal)
    /// The server answered, and not with the bytes.
    case failed(String)

    /// One short line, for a placeholder that has to fit inside a bubble.
    var summary: String {
        switch self {
        case .offline: return "Not downloaded"
        case .refused: return "Blocked"
        case .failed: return "Unavailable"
        }
    }

    /// The longer form, for VoiceOver and for the full-screen viewer, where there is
    /// room to say what is actually true.
    var detail: String {
        switch self {
        case .offline: return "Not downloaded. It will appear when Syl is reachable."
        case .refused: return "Blocked: this attachment did not come from your paired server."
        case .failed(let reason): return "Could not load this attachment. \(reason)"
        }
    }
}

// MARK: - Fetching

/// The authenticated byte fetch, behind a seam.
///
/// A protocol so the loader's state machine can be exercised without a server, and so
/// the origin guard can be shown to actually stop a request rather than merely to
/// return a `Result` nobody consults.
protocol AttachmentFetching: Sendable {
    /// - Returns: the raw bytes.
    /// - Throws: ``AttachmentFetchError``.
    func data(from url: URL) async throws -> Data
}

enum AttachmentFetchError: Error, Equatable {
    /// No route. Distinguished from every other failure because it is the one the UI
    /// must describe rather than apologise for.
    case offline
    case http(status: Int, message: String)
    case transport(String)
}

/// The real one.
///
/// `AsyncImage(url:)` cannot attach a `Bearer` header, so an authenticated image 401s —
/// which is the whole reason this file exists rather than a one-line `AsyncImage`.
///
/// It also does not go through `APIClient`. That client decodes the `{ success, data }`
/// envelope, and `GET /attachments/{id}` is the one operation in the contract whose
/// success body is not one: it answers the file. The **failure** bodies still are, and
/// the discriminator is the content type — so a JSON body on a non-2xx is read as Syl
/// refusing, and anything else on a non-2xx is a transport failure wearing an HTTP
/// status, exactly as the envelope rule intends.
struct AuthenticatedAttachmentFetcher: AttachmentFetching {
    let session: URLSession
    let tokens: any TokenStore

    init(session: URLSession = .shared, tokens: any TokenStore) {
        self.session = session
        self.tokens = tokens
    }

    func data(from url: URL) async throws -> Data {
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        if let token = tokens.read() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        let bytes: Data
        let response: URLResponse
        do {
            (bytes, response) = try await session.data(for: request)
        } catch let error as URLError {
            switch error.code {
            case .notConnectedToInternet, .networkConnectionLost, .cannotFindHost,
                 .cannotConnectToHost, .dnsLookupFailed, .timedOut,
                 .internationalRoamingOff, .dataNotAllowed, .secureConnectionFailed:
                throw AttachmentFetchError.offline
            default:
                throw AttachmentFetchError.transport(error.localizedDescription)
            }
        } catch {
            throw AttachmentFetchError.transport(error.localizedDescription)
        }

        guard let http = response as? HTTPURLResponse else {
            throw AttachmentFetchError.transport("no HTTP response")
        }
        guard (200..<300).contains(http.statusCode) else {
            throw AttachmentFetchError.http(
                status: http.statusCode,
                message: Self.refusal(in: bytes) ?? "HTTP \(http.statusCode)"
            )
        }
        return bytes
    }

    /// The message out of an error envelope, when the body is one.
    private static func refusal(in data: Data) -> String? {
        guard let envelope = try? SylJSON.decoder().decode(ErrorEnvelope.self, from: data) else {
            return nil
        }
        return envelope.error.message
    }
}

// MARK: - The loader

/// Loads one attachment's bytes: authenticated, cached, and honest when it cannot.
///
/// Mined from Adjutant's `AttachmentImageLoader`, with three changes that are the whole
/// difference between it and this:
///
/// 1. **A fourth state.** Adjutant has `failed(String)`, which renders as an error even
///    when the truthful answer is "you are on the tube". ``AttachmentUnavailable``
///    separates the offline case, because it is the common one and it is not a fault.
/// 2. **The origin guard**, which Adjutant has no equivalent of.
/// 3. **Variants.** Adjutant downloads the full image and renders it at 160×160, so a
///    4 MB screenshot costs 4 MB to show a thumbnail. Here the inline cell asks for
///    `.thumb` when one exists.
@MainActor
final class AttachmentLoader: ObservableObject {
    @Published private(set) var state: AttachmentLoadState = .idle

    private var source: AttachmentSource?
    private var fetcher: any AttachmentFetching

    init(source: AttachmentSource?, fetcher: any AttachmentFetching) {
        self.source = source
        self.fetcher = fetcher
    }

    /// Take the paired server and the credentialed fetcher from the environment.
    ///
    /// A loader lives in a `@StateObject`, which is constructed before the environment
    /// is readable — so it starts with no server and adopts one on appear. That is why
    /// the initial state is `idle` and the no-source state is `refused` rather than
    /// `loading`: a view that never adopts a context says so instead of spinning.
    func adopt(_ context: AttachmentContext) {
        source = context.source
        fetcher = context.fetcher
    }

    /// Fetch the bytes, serving from the cache when they are held.
    ///
    /// The cache is consulted **before** anything asks whether the network is up, which
    /// is the whole of T035: an attachment already seen renders with the tailnet down.
    func load(_ attachment: Attachment, variant: AttachmentVariant = .original) async {
        let variant = Self.resolve(variant, for: attachment)
        let key = Self.key(attachment.id, variant)

        if let cached = Self.cached(key) {
            state = .loaded(cached)
            return
        }
        guard let source else {
            state = .unavailable(.refused(.notAWebOrigin))
            return
        }

        let url: URL
        switch source.url(for: attachment.id, variant: variant) {
        case .success(let resolved): url = resolved
        case .failure(let refusal):
            state = .unavailable(.refused(refusal))
            return
        }

        state = .loading
        do {
            let bytes = try await fetcher.data(from: url)
            Self.store(bytes, for: key)
            state = .loaded(bytes)
        } catch let error as AttachmentFetchError {
            switch error {
            case .offline:
                state = .unavailable(.offline)
            case .http(_, let message):
                state = .unavailable(.failed(message))
            case .transport(let description):
                state = .unavailable(.failed(description))
            }
        } catch {
            state = .unavailable(.failed(error.localizedDescription))
        }
    }

    /// Never ask for a thumbnail that does not exist.
    ///
    /// `hasThumbnail` is false for every video and for an image the service could not
    /// downscale, and asking anyway is a `404` — which would render as a broken
    /// attachment rather than as the full-size image it should have fallen back to
    /// *here*, on the client, where the fallback is a decision rather than an invisible
    /// 4 MB download.
    private static func resolve(_ variant: AttachmentVariant, for attachment: Attachment) -> AttachmentVariant {
        (variant == .thumb && !attachment.hasThumbnail) ? .original : variant
    }

    // MARK: - Cache

    /// Seed the cache with bytes that are already on this device.
    ///
    /// This is what makes an optimistic send render with no round trip: the picture the
    /// Commander just chose is already in memory, and the bubble should not blink
    /// through a spinner to fetch a copy of it from the machine he sent it to.
    nonisolated static func prime(attachmentId: SylID, data: Data, variant: AttachmentVariant = .original) {
        store(data, for: key(attachmentId, variant))
    }

    nonisolated static func cached(attachmentId: SylID, variant: AttachmentVariant = .original) -> Data? {
        cached(key(attachmentId, variant))
    }

    /// Whatever bytes are already held for this attachment, in the order a cell would
    /// rather have them.
    ///
    /// A thumbnail first, because that is what an inline cell asks for; the original
    /// otherwise, because a just-sent picture is primed at full size and a viewer that
    /// has been opened leaves one behind. This is a **synchronous** read, which is what
    /// lets a cell paint the right thing on its first frame instead of flashing an empty
    /// plate on its way to the same answer.
    nonisolated static func cachedBytes(for attachment: Attachment) -> Data? {
        cached(attachmentId: attachment.id, variant: .thumb)
            ?? cached(attachmentId: attachment.id, variant: .original)
    }

    /// The process-wide byte cache.
    ///
    /// ## The cost limit, and why this number
    ///
    /// 32 MB. Adjutant's equivalent is 48, sized for a world with **no thumbnails at
    /// all**, where every inline render pulled the full file — a transcript of four
    /// screenshots was 16 MB before anything was opened. Here the inline cell asks for
    /// `?variant=thumb`, which the service reports as roughly two orders of magnitude
    /// smaller, so 32 MB holds several hundred thumbnails *and* a handful of full-size
    /// originals from the viewer, which is far more than one conversation's working set.
    ///
    /// The limit is a ceiling on steady state rather than a guarantee about memory:
    /// `NSCache` also evicts under pressure on its own, which is exactly the property
    /// wanted here. Being wrong in the low direction costs a re-download over a tailnet;
    /// being wrong in the high direction costs a jetsam kill while the Commander is
    /// reading. The asymmetry picks the number.
    nonisolated static let costLimit = 32 * 1024 * 1024

    // `nonisolated(unsafe)` and safe: `NSCache` is documented thread-safe, and every
    // accessor below is `nonisolated` for the same reason. Pinning the cache to the main
    // actor would make priming it from a background upload a hop, on the one path whose
    // whole purpose is to be instant.
    private nonisolated(unsafe) static let cache: NSCache<NSString, NSData> = {
        let cache = NSCache<NSString, NSData>()
        cache.totalCostLimit = costLimit
        return cache
    }()

    /// Keyed by id **and** variant, because they are different bytes for the same row —
    /// keying on the id alone would serve a 160-pixel thumbnail to the full-screen
    /// viewer, or a 4 MB original to an inline cell.
    ///
    /// Not keyed by `sha256`, though the contract nominates it as "the client's cache
    /// key". That is the right key for a *disk* cache that must answer "is this the same
    /// picture I already have" across launches; within one process an attachment id is
    /// server-minted and immutable, which is the only property this cache needs.
    private nonisolated static func key(_ id: SylID, _ variant: AttachmentVariant) -> NSString {
        "\(SylIDs.canonical(id))#\(variant.rawValue)" as NSString
    }

    private nonisolated static func cached(_ key: NSString) -> Data? {
        cache.object(forKey: key) as Data?
    }

    private nonisolated static func store(_ data: Data, for key: NSString) {
        cache.setObject(data as NSData, forKey: key, cost: data.count)
    }

    #if DEBUG
    /// Test hook — the cache is process-wide, so cases would otherwise leak into each
    /// other and a test would pass because a previous one had already fetched.
    nonisolated static func clearCacheForTesting() {
        cache.removeAllObjects()
    }
    #endif
}
