import Foundation

/// How much transcript is read at once, written down **once**.
///
/// ## Why this is a file and not a default argument
///
/// It was two default arguments — `ChatViewModel.init(limit: Int = 200)` and
/// `ChatSnapshotLoader.limit = 200` — and they were independently written. Two
/// independently-written copies of a load-bearing number is how the client came to be
/// asking for **200** while `GET /conversations/{id}/messages` had defaulted to **50**
/// the entire time, and nothing anywhere could notice the disagreement because neither
/// side had a name to compare.
///
/// This repository has already paid for that shape once, in a different subsystem: there
/// were three quiet-hours windows in the tree, two under the same exported name with
/// different values, plus a constant restating the end with a comment asserting they
/// agreed. The rule that came out of it is the rule here — *a module may **use** the
/// number; a module that writes one down is declaring a second one.*
///
/// ## Why fifty
///
/// It is what the Commander asked for, and it is what the server already gives you when
/// you ask for nothing (`message-store.ts`). Those being the same number is not a
/// coincidence worth preserving by accident.
///
/// Note what the page size is **not**: it is not what bounds the transcript. A page size
/// with a self-retriggering load above it is a step size, not a cap — the window walks to
/// the whole conversation either way, just in smaller steps. See `ChatViewModel`'s
/// `loadEarlier()` for the part that actually holds.
enum ChatPaging {
    /// One page of transcript. The unit of every read the chat screen makes.
    static let pageSize = 50
}
