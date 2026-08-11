import Foundation

/// Decides which links in a message may be tapped. **The one new security control in
/// `syl-008`.**
///
/// The backend's SSRF guard (`safeFetch`, `classifyAddress`) is thorough, and it guards
/// *outbound fetches*. It does nothing about what the phone renders. `Message.text` is an
/// unfiltered `String`; nothing between the model and the bubble strips a hostile scheme
/// out of it, and `[click](javascript:…)` becomes live the instant links are tappable —
/// which `MarkdownInline` makes them.
///
/// The rule is an **allowlist**: `https` and `mailto` are admitted, everything else is
/// inert text. A blocklist would have to be complete to be correct; this does not.
/// Every ambiguous answer — a URL that will not parse, a scheme that is absent, a host
/// that is empty — is a refusal.
///
/// Both entry points funnel through the same string path, so there is no second set of
/// rules to keep in step.
enum LinkPolicy {

    /// The whole policy. Adding to this set means adding a case to `approved(_:)` as
    /// well; anything else fails closed.
    static let allowedSchemes: Set<String> = ["https", "mailto"]

    /// Whitespace and control characters, which includes the format category — so a
    /// zero-width space or a directional mark counts.
    private static let forbidden = CharacterSet.whitespacesAndNewlines
        .union(.controlCharacters)

    /// The URL a tap may open, or `nil` if this link must render as inert text.
    static func sanitized(rawURL: String) -> URL? {
        let trimmed = rawURL.trimmingCharacters(in: forbidden)
        guard !trimmed.isEmpty else { return nil }

        // Browsers strip interior tabs and newlines before resolving, which is what makes
        // `java<TAB>script:` run. We refuse rather than normalise: a URL with whitespace
        // or a control character inside it is a shape only an attacker produces, and
        // "refuse" is a much shorter argument than "normalise correctly".
        guard !trimmed.unicodeScalars.contains(where: forbidden.contains) else { return nil }

        guard let url = URL(string: trimmed) else { return nil }
        return approved(url)
    }

    /// As above, for a URL that has already been parsed — the shape `AttributedString`
    /// hands back.
    static func sanitized(_ url: URL) -> URL? {
        sanitized(rawURL: url.absoluteString)
    }

    /// Removes `.link` and `.imageURL` from every run whose target the policy refuses,
    /// leaving the text exactly as it was.
    ///
    /// `![alt](url)` lands in a different attribute from `[text](url)`; a control that
    /// guards only `.link` leaves the second channel open.
    static func sanitize(_ input: AttributedString) -> AttributedString {
        var output = input

        let links = output.runs.compactMap { run in run.link.map { (run.range, $0) } }
        for (range, url) in links {
            output[range].link = sanitized(url)
        }

        let images = output.runs.compactMap { run in run.imageURL.map { (run.range, $0) } }
        for (range, url) in images {
            output[range].imageURL = sanitized(url)
        }

        return output
    }

    // MARK: - The decision

    private static func approved(_ url: URL) -> URL? {
        guard let scheme = url.scheme?.lowercased(), allowedSchemes.contains(scheme) else {
            return nil
        }
        switch scheme {
        case "https":
            // A scheme is necessary, not sufficient. `https://` opens nothing.
            guard let host = url.host(), !host.isEmpty else { return nil }
            return url
        case "mailto":
            guard isPlausibleMailto(url) else { return nil }
            return url
        default:
            // Unreachable while `allowedSchemes` and this switch agree. If a scheme is
            // ever added to the set alone, it lands here and is refused.
            return nil
        }
    }

    /// A mailto whose recipients look like addresses. This is what stops
    /// `mailto:javascript:alert(1)` — a nested scheme smuggled past the first check by
    /// wearing an allowed one in front.
    private static func isPlausibleMailto(_ url: URL) -> Bool {
        let absolute = url.absoluteString
        guard let colon = absolute.firstIndex(of: ":") else { return false }
        var recipients = absolute[absolute.index(after: colon)...]
        if let query = recipients.firstIndex(of: "?") {
            recipients = recipients[..<query]
        }
        guard !recipients.isEmpty else { return false }
        let addresses = recipients.split(separator: ",", omittingEmptySubsequences: false)
        return addresses.allSatisfy { $0.contains("@") && !$0.contains(":") }
    }
}
