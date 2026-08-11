import Foundation
import SylKit

/// Where From Syl's rows come from: disk first, network second.
///
/// ## Why this is a direct fetch and not the sync feed
///
/// `sending` *is* on `GET /sync` — the contract puts it there and `SyncEngine` applies
/// one when it arrives — and this still asks directly, for the reason
/// ``ConstellationSource`` states at length: that engine writes its cursor after every
/// page whether or not anything in it was stored (`syl-011.9`, open, P0), so a surface
/// that learned about her sendings only from the feed would inherit silent data loss.
/// The Commander hit exactly that on goals within an hour — three on the server, one on
/// the phone, no error anywhere — and it took a one-time backfill to recover.
///
/// A keepsake surface is the worst possible place for that failure, because the thing
/// missing would be a thing she gave him and nothing would ever say so.
///
/// ## The video lands minutes after the words
///
/// `POST /sendings` answers as soon as the words are his; the render is followed,
/// compressed and poster-framed afterwards. So a row can be `pending` when it is stored
/// and `ready` a few minutes later, and **no frame arrives to say so**. The phone finds
/// out by asking — the page on every refresh, and by name for anything the page left
/// pending.
///
/// ## Local-first, which is not suspended for a pretty screen
///
/// ``cached()`` is a synchronous disk read with no network in it. A failed refresh
/// leaves the stored rows exactly as they were: the surface shows the last true thing it
/// knew rather than emptying itself, which on this screen would read as *she has taken
/// them back*.
struct SendingGateway: Sendable {
    /// The newest page. Newest first — the service's order, which the store asserts
    /// again rather than trusting.
    var page: @Sendable (_ cursor: String?, _ limit: Int?) async throws -> SendingPage
    /// One sending by name, for a row whose video had not landed yet.
    var one: @Sendable (_ id: SylID) async throws -> Sending

    static func live(backend: SylBackend) -> SendingGateway {
        SendingGateway(
            page: { cursor, limit in
                try await backend.client().send(SylAPI.sendings(cursor: cursor, limit: limit))
            },
            one: { id in
                try await backend.client().send(SylAPI.sending(id))
            }
        )
    }
}

struct SendingSource: Sendable {
    let store: LocalStore
    let gateway: SendingGateway

    /// How many still-pending rows one refresh will chase individually.
    ///
    /// A bound rather than "all of them": a service that failed to finish a run of
    /// renders would otherwise turn every foreground into a burst of requests over a
    /// tailnet. Anything past this is picked up by the next pass, and the row is honest
    /// about being pending in the meantime.
    static let pendingChaseLimit = 10

    init(store: LocalStore, gateway: SendingGateway) {
        self.store = store
        self.gateway = gateway
    }

    /// What she has sent him, straight off disk, newest first.
    ///
    /// **Empty means empty here — it does not mean "never asked".** Those are different
    /// statements and the surface has to keep them apart: an empty list drawn on a first
    /// launch that has not reached the network yet is a confident false claim that she
    /// has never sent him anything. The caller draws that distinction by whether a
    /// refresh has ever answered; see ``FromSylViewModel``.
    func cached() throws -> [Sending] {
        try store.sendings()
    }

    /// Fetch the newest page, store it, and chase anything still pending.
    ///
    /// Throws on a failed page fetch **without touching what is stored**, so a caller
    /// that ignores the error still has the previous rows to draw.
    ///
    /// A failed follow-up is deliberately *not* an error: the page has already landed by
    /// then, and losing it because one row could not be re-read would be the surface
    /// emptying itself over a detail. The row stays pending, and pending is the truth.
    @discardableResult
    func refresh(limit: Int? = nil) async throws -> [Sending] {
        let fetched = try await gateway.page(nil, limit)
        try store.replaceSendings(fetched)
        await chasePending()
        return try store.sendings()
    }

    /// Ask again, by name, about every row whose video had not landed.
    private func chasePending() async {
        let pending = ((try? store.pendingSendingIDs()) ?? []).prefix(Self.pendingChaseLimit)
        for id in pending {
            guard let resolved = try? await gateway.one(id) else { continue }
            try? store.replaceSendings(
                SendingPage(items: [resolved], nextCursor: nil, hasMore: false))
        }
    }
}
