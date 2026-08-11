import Foundation
import SylKit

/// Where the sky comes from: disk first, network second.
///
/// ## Why this is a direct fetch and not a sync resource type
///
/// Two independent reasons, and either alone would settle it.
///
/// **1. There is nothing for a cursor to mean.** Every type on the sync feed is a
/// row with a lifecycle — a to-do is created, changed, completed — and `GET /sync`
/// reports those events. The constellation is a bounded REGION computed at read
/// time: the anchors, what orbits them, and the most connected of what is left.
/// Membership changes when salience shifts, silently and without an event, so
/// "changes since X" has no answer. A cursor over it would be a number that means
/// nothing, kept carefully up to date.
///
/// **2. `SyncEngine` advances its cursor past changes it did not apply**
/// (`syl-011.9`, open, P0). It writes the cursor after every page whether or not
/// anything in that page was stored, so any type added to that feed inherits the
/// defect exactly: the device records that it is up to date and is missing rows
/// nobody will ever send again. The Commander hit it on goals within an hour —
/// three on the server, one on the phone, no error anywhere — and it needed a
/// one-time backfill to recover. Adding a new consumer to a feed with an open
/// silent-data-loss bug is not a trade worth making for a screen that can simply
/// ask.
///
/// ## Local-first, which is not suspended for a pretty screen
///
/// ``cached()`` is a synchronous disk read with no network in it at all. The sky
/// opens instantly and offline from the last answer the server gave, and a refresh
/// happens behind it. A failed refresh leaves the stored sky exactly as it was —
/// the app shows the last true thing it knew rather than replacing it with an
/// empty field, which would read as *she has forgotten everything*.
struct ConstellationGateway: Sendable {
    var fetch: @Sendable (_ stars: Int?) async throws -> MemoryConstellation

    static func live(backend: SylBackend) -> ConstellationGateway {
        ConstellationGateway { stars in
            try await backend.client().send(SylAPI.constellation(stars: stars))
        }
    }
}

struct ConstellationSource: Sendable {
    let store: LocalStore
    let gateway: ConstellationGateway

    init(store: LocalStore, gateway: ConstellationGateway) {
        self.store = store
        self.gateway = gateway
    }

    /// The last sky the server drew, straight off disk.
    ///
    /// **Nil means "never fetched", not "she remembers nothing".** The caller must
    /// keep those apart: an empty field rendered on a first launch that has not
    /// reached the network yet is a confident false statement, and the same
    /// distinction `GoalsViewModel` draws with a nil snapshot.
    func cached() throws -> MemoryConstellation? {
        try store.constellation()
    }

    /// Fetch a fresh sky and replace the stored one.
    ///
    /// Throws on a failed fetch **without touching what is stored**, so a caller
    /// that ignores the error still has the previous sky to draw. The store is
    /// only written after the network has answered completely — there is no
    /// partial application, and a half-written sky is the one failure a
    /// constellation cannot survive, because a filament whose star came from a
    /// different fetch is a line into nothing.
    @discardableResult
    func refresh(stars: Int? = nil) async throws -> MemoryConstellation {
        let fetched = try await gateway.fetch(stars)
        try store.replaceConstellation(fetched)
        return fetched
    }
}
