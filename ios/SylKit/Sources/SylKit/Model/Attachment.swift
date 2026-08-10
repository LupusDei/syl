import Foundation

/// Two kinds, and deliberately no third.
///
/// `file` is not here. An arbitrary document is a thing the service would have to
/// store, serve and never be able to render, and adding the case later costs nothing
/// while adding it now costs a surface nobody has a use for.
public enum AttachmentKind: String, Codable, Equatable, Sendable, CaseIterable {
    case image
    case video
}

/// Which set of bytes to ask for.
///
/// Not part of the wire *body* — it is the `variant` query parameter on
/// `GET /attachments/{id}` — but it belongs beside the model, because the rule that
/// governs it is a property of the attachment: ask for `thumb` only when
/// ``Attachment/hasThumbnail`` is true. Asking for one that does not exist is a `404`
/// and never a silent fallback to the full file, which is the whole point: a fallback
/// would turn a 60 KB request into a 4 MB one on the connection least able to afford
/// it, invisibly.
public enum AttachmentVariant: String, Equatable, Sendable, CaseIterable {
    case original
    case thumb
}

/// A stored image or video.
///
/// The row is metadata only — the bytes live on the service's own disk and are fetched
/// from `GET /attachments/{attachmentId}`.
///
/// **There is no URL on this object, on purpose.** A remote image in a transcript leaks
/// a read receipt and the Commander's IP to whoever hosts it, and a client that will
/// render whatever URL it is handed is an SSRF surface pointed at the tailnet. The
/// client composes the path from the id against the server it is paired with, so an
/// attachment can only ever come from Syl's own origin. See `AttachmentSource` in the
/// app target, which is where that composition — and the refusal — actually lives.
///
/// Every field is required. `durationMs` is nullable-and-present rather than optional,
/// which is the same distinction the whole contract draws everywhere else: "there is no
/// duration" and "this server does not send durations" look identical when a field is
/// merely absent, and they mean opposite things the day one goes missing.
public struct Attachment: Codable, Equatable, Sendable, Identifiable {
    public let id: SylID
    public let kind: AttachmentKind
    /// What the file's **magic bytes** say it is, not what the uploader declared. The
    /// two are cross-checked at upload and a disagreement is refused, so by the time a
    /// row exists there is only one answer.
    public let mimeType: String
    /// Size of the stored original, in bytes.
    public let bytes: Int
    /// Pixels. Read from the file header for an image; taken from the uploader for a
    /// video.
    ///
    /// Present so a bubble can reserve the right box **before** the bytes arrive. This
    /// field is the entire reason the inline thumbnail does not jump when it loads.
    public let width: Int
    /// Pixels. See ``width``.
    public let height: Int
    /// Video only. Always null for an image.
    public let durationMs: Int?
    /// Lower-case hex of the stored original. The client's cache key, and what makes
    /// "is this the same picture I already have" answerable without a download.
    public let sha256: String
    public let createdAt: Date
    /// Whether `?variant=thumb` will answer with bytes. False for every video, and
    /// false for an image the service could not downscale. **Read this rather than
    /// probe** — a client that asks for a thumbnail that does not exist gets a `404`.
    public let hasThumbnail: Bool

    public init(
        id: SylID,
        kind: AttachmentKind,
        mimeType: String,
        bytes: Int,
        width: Int,
        height: Int,
        durationMs: Int?,
        sha256: String,
        createdAt: Date,
        hasThumbnail: Bool
    ) {
        self.id = id
        self.kind = kind
        self.mimeType = mimeType
        self.bytes = bytes
        self.width = width
        self.height = height
        self.durationMs = durationMs
        self.sha256 = sha256
        self.createdAt = createdAt
        self.hasThumbnail = hasThumbnail
    }

    /// Width over height, clamped to something a layout can actually use.
    ///
    /// The contract says both are at least 1, but a client that trusts a server it has
    /// not met is a client that divides by zero eventually, and the symptom of a `NaN`
    /// aspect ratio in SwiftUI is a view that silently fails to lay out rather than a
    /// crash anyone can find. The clamp keeps an absurd panorama or a one-pixel column
    /// inside the range a bubble can reserve space for.
    public var aspectRatio: Double {
        guard width > 0, height > 0 else { return 1 }
        return min(max(Double(width) / Double(height), 0.2), 5)
    }

    private enum CodingKeys: String, CodingKey {
        case id, kind, mimeType, bytes, width, height, durationMs, sha256, createdAt, hasThumbnail
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(SylID.self, forKey: .id)
        kind = try container.decode(AttachmentKind.self, forKey: .kind)
        mimeType = try container.decode(String.self, forKey: .mimeType)
        bytes = try container.decode(Int.self, forKey: .bytes)
        width = try container.decode(Int.self, forKey: .width)
        height = try container.decode(Int.self, forKey: .height)
        durationMs = try container.decodeRequiredNullable(Int.self, forKey: .durationMs)
        sha256 = try container.decode(String.self, forKey: .sha256)
        createdAt = try container.decode(Date.self, forKey: .createdAt)
        hasThumbnail = try container.decode(Bool.self, forKey: .hasThumbnail)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(kind, forKey: .kind)
        try container.encode(mimeType, forKey: .mimeType)
        try container.encode(bytes, forKey: .bytes)
        try container.encode(width, forKey: .width)
        try container.encode(height, forKey: .height)
        try container.encodeRequiredNullable(durationMs, forKey: .durationMs)
        try container.encode(sha256, forKey: .sha256)
        try container.encode(createdAt, forKey: .createdAt)
        try container.encode(hasThumbnail, forKey: .hasThumbnail)
    }
}

/// The upload body: the bytes, base64, in a JSON envelope like every other write.
///
/// Not multipart and not a raw octet stream. Every write in this contract carries an
/// `Idempotency-Key`, and the retry semantics that header buys are computed from the
/// body — an upload arriving through a different mechanism would be the one write in
/// the service with a different failure model, on the client that retries most. Base64
/// costs 33% on the way up, which is the price of that uniformity.
///
/// `width`, `height` and `durationMs` are **required for a video and ignored for an
/// image**: the server reads an image's dimensions out of its own header, which is the
/// only source that cannot disagree with the file, and cannot do the same for a video
/// without a demuxer. They are a layout hint and never a security property.
public struct CreateAttachmentRequest: Codable, Equatable, Sendable {
    public let kind: AttachmentKind
    /// The type you *believe* you are uploading. Cross-checked against the magic bytes;
    /// a disagreement is `VALIDATION_FAILED`, never a quiet correction.
    public let mimeType: String
    /// The file, base64. Standard alphabet, no data URI prefix.
    public let data: String
    public let width: Int?
    public let height: Int?
    public let durationMs: Int?

    public init(
        kind: AttachmentKind,
        mimeType: String,
        data: String,
        width: Int? = nil,
        height: Int? = nil,
        durationMs: Int? = nil
    ) {
        self.kind = kind
        self.mimeType = mimeType
        self.data = data
        self.width = width
        self.height = height
        self.durationMs = durationMs
    }

    private enum CodingKeys: String, CodingKey {
        case kind, mimeType, data, width, height, durationMs
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        kind = try container.decode(AttachmentKind.self, forKey: .kind)
        mimeType = try container.decode(String.self, forKey: .mimeType)
        data = try container.decode(String.self, forKey: .data)
        width = try container.decodeIfPresent(Int.self, forKey: .width)
        height = try container.decodeIfPresent(Int.self, forKey: .height)
        durationMs = try container.decodeIfPresent(Int.self, forKey: .durationMs)
    }

    /// Absent rather than null for the three optional hints.
    ///
    /// The spec does not admit `null` for any of them — `width: null` on an image is a
    /// different thing from omitting it, and the one the service will refuse. This is
    /// the mirror of the rule ``Attachment`` follows in the other direction.
    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(kind, forKey: .kind)
        try container.encode(mimeType, forKey: .mimeType)
        try container.encode(data, forKey: .data)
        try container.encodeIfPresent(width, forKey: .width)
        try container.encodeIfPresent(height, forKey: .height)
        try container.encodeIfPresent(durationMs, forKey: .durationMs)
    }
}
