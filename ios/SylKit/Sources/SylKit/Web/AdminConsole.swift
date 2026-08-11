import Foundation

/// The pure half of showing Syl's web admin inside the app.
///
/// Three things live here and nothing else does: where the admin is, what the WebView
/// is allowed to reach once it is there, and how the app's credential is written into
/// the page. All three are functions of values, with no `WebKit` and no `UIKit`, so
/// they run under `swift test` on the host in milliseconds.
///
/// **That placement is the point rather than a convenience.** The navigation predicate
/// is the only thing standing between a live bearer token and an arbitrary web page.
/// Security logic that costs a simulator boot to exercise is security logic nobody
/// re-runs; this is the same argument the backend makes for keeping its protocol codec
/// pure and I/O-free.
public enum AdminConsole {
    /// The path the service serves the built admin bundle from. Part of the layout,
    /// not a setting — see `syl-6vt`.
    public static let path = "/admin"

    /// Where the admin keeps its API key.
    ///
    /// **The other half of this constant is TypeScript**, in
    /// `frontend/src/auth/api-key-store.ts` (`API_KEY_STORAGE_KEY`). The handoff works
    /// only because both sides spell it the same, and if either renames it the symptom
    /// is not an error — it is the admin quietly showing its login gate. `AdminConsoleTests`
    /// pins the literal so a rename here has to be deliberate.
    public static let credentialStorageKey = "syl.admin.api-key"

    /// The admin URL for a paired server, derived from the API base URL the app
    /// already stores.
    ///
    /// **Derived, never stored separately.** `ServerProfile.baseURL` is
    /// `https://<host>/api/v1` and the admin is the same origin with `/admin`. A second
    /// stored URL is a second thing to fix after re-pairing, and the two would disagree
    /// exactly once, at the worst moment.
    ///
    /// Everything past the origin is discarded: the admin is at the origin root
    /// whatever path the base URL happens to carry.
    ///
    /// - Returns: `nil` when the base URL is not an `https` origin. **Cleartext is
    ///   refused deliberately.** This WebView is handed a live bearer credential, and
    ///   an `http` origin publishes it to every hop on the path — and would need an App
    ///   Transport Security exception the project has decided not to have. The mock
    ///   server (`http://127.0.0.1:4210`) therefore has no admin, which is correct: it
    ///   does not serve one.
    public static func url(forAPIBaseURL baseURL: URL) -> URL? {
        guard let origin = WebOrigin(url: baseURL), origin.scheme == "https" else { return nil }

        var components = URLComponents()
        components.scheme = origin.scheme
        components.host = origin.host
        // Only when it was written out. `https://host:443/admin` and `https://host/admin`
        // are the same origin, and the shorter one is what a person expects to see.
        components.port = origin.isDefaultPort ? nil : origin.port
        components.path = path
        return components.url
    }

    /// The script that hands the app's credential to the admin.
    ///
    /// Injected `.atDocumentStart` and into the main frame only, so it runs before the
    /// admin's own bundle reads storage and never runs in a subframe.
    ///
    /// It is deliberately one line and deliberately paranoid about the token. This is
    /// source code with a secret pasted into it: a token carrying a quote, a backslash
    /// or a newline would end the string literal and turn the remainder of the
    /// credential into JavaScript executing on the admin's own origin. Every character
    /// outside a small alphanumeric set is escaped as `\uXXXX`, which is safe inside a
    /// JavaScript string and cannot close an HTML element either.
    ///
    /// - Returns: `nil` for a blank token. Writing `""` would leave the admin building
    ///   `Bearer ` and reporting a confusing 401 instead of showing its own gate.
    public static func credentialScript(token: String) -> String? {
        let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        let key = javaScriptStringLiteral(credentialStorageKey)
        let value = javaScriptStringLiteral(trimmed)
        // The `try` matters: Safari throws from `localStorage` when storage is
        // disabled, and an exception at document start would stop the admin's own
        // bundle from running at all.
        return "(function(){try{window.localStorage.setItem(\(key),\(value));}catch(e){}})();"
    }

    /// Characters that need no escaping and appear in every realistic token. Anything
    /// else — including `<`, `>`, `/`, `"`, `\` and every control character — goes out
    /// as `\uXXXX`.
    private static let literalSafe = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.".unicodeScalars)

    /// A double-quoted JavaScript string literal that cannot escape itself.
    private static func javaScriptStringLiteral(_ value: String) -> String {
        var out = "\""
        for unit in value.utf16 {
            if let scalar = Unicode.Scalar(unit), literalSafe.contains(scalar) {
                out.unicodeScalars.append(scalar)
            } else {
                // UTF-16 code units, so an astral character comes out as its surrogate
                // pair — which is exactly what a JavaScript string holds.
                out += String(format: "\\u%04X", unit)
            }
        }
        out += "\""
        return out
    }
}

/// A web origin: the `(scheme, host, port)` triple, normalised.
///
/// Not a hostname. Two URLs on the same host but a different scheme or port are
/// different origins and the browser treats them as different security principals; so
/// does this.
public struct WebOrigin: Equatable, Sendable {
    /// Lowercased, and only ever `http` or `https`.
    public let scheme: String
    /// Lowercased. Compared whole — never by prefix, suffix or containment.
    public let host: String
    /// The *effective* port, so an omitted one and a written-out default compare equal.
    public let port: Int

    /// - Returns: `nil` for anything that is not a web origin — `javascript:`, `data:`,
    ///   `file:`, `about:`, a custom scheme, or an `https` URL with no host.
    public init?(url: URL) {
        guard let rawScheme = url.scheme?.lowercased(),
              rawScheme == "https" || rawScheme == "http"
        else { return nil }

        // `url.host()` is the parsed authority host, which is what makes
        // `https://paired.host@evil.com/` resolve to `evil.com` here rather than
        // reading as the paired host the way the raw string does.
        guard let rawHost = url.host(percentEncoded: false)?.lowercased(), !rawHost.isEmpty else {
            return nil
        }

        self.scheme = rawScheme
        self.host = rawHost
        self.port = url.port ?? (rawScheme == "https" ? 443 : 80)
    }

    /// Whether the port is the scheme's default, and therefore need not be written out.
    public var isDefaultPort: Bool {
        port == (scheme == "https" ? 443 : 80)
    }
}

/// What the admin WebView is allowed to navigate to.
///
/// **This exists because the WebView carries a credential.** A bearer token in a web
/// context that can reach arbitrary pages is an exfiltration path: one redirect, one
/// `target="_blank"`, one `javascript:` URL, and the Commander's token is somewhere
/// else. The rule is therefore the narrowest one that still works — the paired origin,
/// nothing beside it — and it is enforced by whole-origin equality rather than by any
/// kind of string match.
///
/// A prefix match on the host would accept `reason-2.tail714e0e.ts.net.evil.com`. A
/// suffix match would accept `admin.reason-2.tail714e0e.ts.net`. A match on the URL
/// string would accept `https://reason-2.tail714e0e.ts.net@evil.com/`. All three are
/// somebody else's server and all three are refused; there is a test for each.
public struct AdminNavigationPolicy: Equatable, Sendable {
    /// Why a navigation was refused. Carried so the refusal can be logged and, where
    /// it matters, shown — a screen that simply does nothing is indistinguishable from
    /// a broken one.
    public enum Refusal: String, Equatable, Sendable {
        /// WebKit offered a navigation with no URL.
        case noURL
        /// Not a web origin at all: `javascript:`, `data:`, `file:`, a custom scheme.
        case unsupportedScheme
        /// A real web origin, and not the paired one.
        case differentOrigin
        /// `target="_blank"` or `window.open`. This WebView does not spawn windows.
        case newWindow
    }

    public enum Decision: Equatable, Sendable {
        case allow
        case refuse(Refusal)
    }

    public let origin: WebOrigin

    public init(origin: WebOrigin) {
        self.origin = origin
    }

    /// Build a policy from the URL the WebView was pointed at.
    ///
    /// - Returns: `nil` when that URL is not a web origin. There is deliberately no
    ///   fallback: a policy that could not determine an origin would otherwise have to
    ///   allow everything, and "allow everything" is the failure this type exists to
    ///   make unrepresentable.
    public init?(adminURL: URL) {
        guard let origin = WebOrigin(url: adminURL) else { return nil }
        self.origin = origin
    }

    /// The whole rule.
    ///
    /// Order is chosen so each refusal names the most specific thing wrong: a
    /// `javascript:` URL reads as `unsupportedScheme` whether or not it wanted a new
    /// window, and an off-origin new window reads as `differentOrigin`.
    public func decide(url: URL?, opensNewWindow: Bool = false) -> Decision {
        guard let url else { return .refuse(.noURL) }
        guard let candidate = WebOrigin(url: url) else { return .refuse(.unsupportedScheme) }
        guard candidate == origin else { return .refuse(.differentOrigin) }
        guard !opensNewWindow else { return .refuse(.newWindow) }
        return .allow
    }
}
