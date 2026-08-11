import Foundation

/// Where the **video** got to. It says nothing about the words, which were delivered
/// before this field had any value at all.
///
/// `pending` — a render is being followed, compressed, or poster-framed.
/// `ready`   — ``Sending/video`` is attached and playable.
/// `failed`  — there will be no video, and ``Sending/reason`` says why in a sentence.
///
/// **A client renders all three.** A row carrying her words and the date is a complete
/// row; `failed` is not an error state to hide, it is the honest one, and the three must
/// not look alike on screen — *"nothing to show yet"* and *"failed to show"* mean
/// different things and neither may read as a bug.
public enum SendingState: String, Codable, Equatable, Sendable, CaseIterable {
    case pending
    case ready
    case failed
}

/// Something she wanted to say, in her own face.
///
/// ## The words are never contingent on the video
///
/// `words` and `messageId` are written before a render is asked about and are never
/// touched again. Whatever happens to the video, he has already received what she wanted
/// to say, and the push carried **her sentence** — never *"Syl sent you a video"*, which
/// would be a notification about the app rather than from her.
///
/// ## The poster is on the video, and it is the one exception in the contract
///
/// ``Attachment/hasThumbnail`` is false for every uploaded video and **true for this
/// one**: the service pulls a poster frame out of the clip, taken from part-way in rather
/// than frame zero, because her loops open on empty starfield and frame zero is nothing
/// at all. So the surface asks for `?variant=thumb` and gets a small JPEG of her face
/// instead of the whole clip — the difference measured at 8.4 MB versus roughly 60 KB.
///
/// ## Nothing can delete a sending
///
/// Not a cache eviction, not a cleanup job, not her. The service's table carries
/// `BEFORE DELETE` and `BEFORE UPDATE` triggers that abort unconditionally, and the only
/// writes permitted are filling in what was not known yet: `video`, `state`, `reason`,
/// `updatedAt`. The device's copy is a cache of that and is replaced whole, never merged.
public struct Sending: Codable, Equatable, Sendable, Identifiable {
    public let id: SylID
    /// What she wanted to say. Already in the conversation as an assistant message, and
    /// already the body of the push.
    public let words: String
    /// Why she made it. Required, as on everything else she makes — the reason travels
    /// with the thing, and it is what makes *"show me the one about Ela"* answerable.
    public let because: String
    /// The assistant message carrying ``words``. Always present: a sending whose words
    /// never reached chat is not a sending.
    public let messageId: SylID
    public let state: SendingState
    /// The full-quality render this was made from — the record, never modified. Nullable
    /// only because the column is; every sending the service writes names one.
    public let renderName: String?
    /// The compressed, playable copy. Null until ``state`` is `ready`.
    public let video: Attachment?
    /// Why there is no video, when there is none. A sentence, never a code. Null unless
    /// ``state`` is `failed`.
    public let reason: String?
    public let createdAt: Date
    public let updatedAt: Date

    public init(
        id: SylID,
        words: String,
        because: String,
        messageId: SylID,
        state: SendingState,
        renderName: String?,
        video: Attachment?,
        reason: String?,
        createdAt: Date,
        updatedAt: Date
    ) {
        self.id = id
        self.words = words
        self.because = because
        self.messageId = messageId
        self.state = state
        self.renderName = renderName
        self.video = video
        self.reason = reason
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    private enum CodingKeys: String, CodingKey {
        case id, words, because, messageId, state, renderName, video, reason
        case createdAt, updatedAt
    }

    /// Nullable-and-present throughout, which is the distinction the whole contract
    /// draws: "there is no video" and "this server does not send videos" look identical
    /// when a field is merely absent, and they mean opposite things the day one goes
    /// missing.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(SylID.self, forKey: .id)
        words = try container.decode(String.self, forKey: .words)
        because = try container.decode(String.self, forKey: .because)
        messageId = try container.decode(SylID.self, forKey: .messageId)
        state = try container.decode(SendingState.self, forKey: .state)
        renderName = try container.decodeRequiredNullable(String.self, forKey: .renderName)
        video = try container.decodeRequiredNullable(Attachment.self, forKey: .video)
        reason = try container.decodeRequiredNullable(String.self, forKey: .reason)
        createdAt = try container.decode(Date.self, forKey: .createdAt)
        updatedAt = try container.decode(Date.self, forKey: .updatedAt)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(words, forKey: .words)
        try container.encode(because, forKey: .because)
        try container.encode(messageId, forKey: .messageId)
        try container.encode(state, forKey: .state)
        try container.encodeRequiredNullable(renderName, forKey: .renderName)
        try container.encodeRequiredNullable(video, forKey: .video)
        try container.encodeRequiredNullable(reason, forKey: .reason)
        try container.encode(createdAt, forKey: .createdAt)
        try container.encode(updatedAt, forKey: .updatedAt)
    }
}

/// A page of sendings, **newest first**.
///
/// The order is the service's — `ORDER BY created_at DESC, id DESC` — and it is a
/// requirement of the surface rather than an incidental property of a query. Anything
/// that projects this page asserts the order itself rather than inheriting it, because a
/// list that happens to arrive sorted and a list that is sorted look identical until the
/// day one is not.
public typealias SendingPage = Page<Sending>
