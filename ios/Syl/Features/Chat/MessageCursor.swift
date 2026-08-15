import Foundation
import SylKit

/// A page cursor for `GET /conversations/{id}/messages`.
///
/// ## This constructs a value the contract calls opaque, and that is a real decision
///
/// Cursors are the server's to mint: it hands one back as `nextCursor` and a client is
/// meant to carry it, not build it. Every other paging client in this app does exactly
/// that. **This one cannot**, and the reason is structural rather than lazy.
///
/// The chat screen's question is *"what comes before the oldest message on this device"*,
/// and the device's oldest message did not arrive through paging — it came down the socket
/// or through `/sync`, neither of which issues a cursor. So at the moment the transcript
/// runs off the end of local history there is no server-minted cursor to carry, and the
/// only alternatives are worse:
///
/// - **Walk from the newest page**, following `nextCursor` until reaching the local floor.
///   Contract-clean, and it costs one request per fifty messages already on the device —
///   forty wasted round trips against a two-thousand-message store, every time he reaches
///   the beginning of what he has.
/// - **Ask the server for a `beforeSeq` parameter.** The right long-term answer, and it is
///   a contract change with a backend, a mock and a generated type behind it.
///
/// So this encodes the one shape `decodeCursor` accepts, in one place, with a test that
/// pins the exact bytes. If the server ever changes its encoding, that test fails here
/// rather than the feature failing silently in his hand — which is the whole reason it is
/// a named type and not a `String(format:)` at the call site.
///
/// Filed for the follow-up: this belongs in `SylKit` beside `SylAPI.messages`, not in a
/// feature folder. It is here because `SylKit` is outside the file lane this task was
/// given.
enum MessageCursor {
    /// A cursor selecting the page immediately before `seq`.
    ///
    /// Mirrors `encodeCursor` in `backend/src/services/message-store.ts`:
    /// `base64(JSON.stringify({ seq }))`. The service refuses a cursor whose seq is not a
    /// positive integer, so a non-positive one is refused here rather than sent — an
    /// optimistic row carries `seq == 0` and must never be mistaken for a paging position.
    static func before(seq: Int) -> String? {
        guard seq > 0 else { return nil }
        // Built by hand rather than with `JSONEncoder` so the bytes are exactly the ones
        // written above and cannot drift with encoder settings or key ordering.
        return Data(#"{"seq":\#(seq)}"#.utf8).base64EncodedString()
    }
}
