import Foundation
import SylKit

/// A picture the Commander has chosen, before the server has ever heard of it.
///
/// It exists because of the ordering in ``ChatViewModel/send(staging:)``: the bubble is
/// written to disk **before** anything is uploaded, so for a moment there is an
/// attachment with real bytes, real dimensions and no server id. This is that moment,
/// made into a value.
///
/// ## The local id is real, not a placeholder
///
/// It is minted in the same `syl:attachment:<uuid>` shape the service uses, and it is
/// what the optimistic row and the primed byte cache are both keyed by. A sentinel — an
/// empty string, a `pending-0` — would have to be recognised and special-cased by every
/// layer between here and the cell, and the one that forgot would render a broken
/// picture. A well-formed id flows through `AttachmentSource`, `AttachmentLoader` and
/// `Message` untouched; the only thing that never happens to it is a network request,
/// because the bytes are already in the cache.
///
/// ## Note on where this stops
///
/// Choosing the picture — a photo picker, and the Reader quarantine that any incoming
/// image implies — is explicitly deferred (US5 in the plan). This type is the seam that
/// work will plug into, and it is here now so the disk-first ordering is built and
/// tested rather than retrofitted onto a picker later, which is when the temptation to
/// "just upload first, it's simpler" is strongest.
struct StagedAttachment: Equatable, Sendable, Identifiable {
    let id: SylID
    let kind: AttachmentKind
    let mimeType: String
    let data: Data
    let width: Int
    let height: Int
    let durationMs: Int?

    init(
        id: SylID = StagedAttachment.mintLocalIdentifier(),
        kind: AttachmentKind,
        mimeType: String,
        data: Data,
        width: Int,
        height: Int,
        durationMs: Int? = nil
    ) {
        self.id = id
        self.kind = kind
        self.mimeType = mimeType
        self.data = data
        self.width = width
        self.height = height
        self.durationMs = durationMs
    }

    /// An id of the shape the service mints, made here.
    ///
    /// Not a v7 UUID — the ordering a v7 buys belongs to the server's clock, and forging
    /// one here would put a fabricated timestamp into an id that later sits next to real
    /// ones. `SylIDs.isWellFormed` asks for the *shape*, which is what everything
    /// downstream actually checks.
    static func mintLocalIdentifier() -> SylID {
        "syl:attachment:\(UUID().uuidString.lowercased())"
    }

    /// The row the optimistic bubble renders from.
    ///
    /// `bytes` is the true decoded size and the dimensions are the true dimensions, so
    /// the cell reserves exactly the box the confirmed attachment will need — the swap
    /// from local id to server id is invisible, with no reflow. `sha256` is left as the
    /// zero digest: it is the server's answer about the stored original, and inventing
    /// one here would be a value that looks authoritative and is not.
    var localAttachment: Attachment {
        Attachment(
            id: id,
            kind: kind,
            mimeType: mimeType,
            bytes: data.count,
            width: width,
            height: height,
            durationMs: durationMs,
            sha256: String(repeating: "0", count: 64),
            createdAt: Date(),
            // There is no thumbnail on this device and asking for one would be a 404.
            // The bytes are already in memory, so the cell has nothing to gain from one.
            hasThumbnail: false
        )
    }

    /// The upload body. `width`/`height`/`durationMs` are sent only for a video — the
    /// server reads an image's dimensions out of its own header and refuses to be told.
    var request: CreateAttachmentRequest {
        CreateAttachmentRequest(
            kind: kind,
            mimeType: mimeType,
            data: data.base64EncodedString(),
            width: kind == .video ? width : nil,
            height: kind == .video ? height : nil,
            durationMs: kind == .video ? durationMs : nil
        )
    }
}
