import Foundation
import SylKit

/// The seam between the sky she remembers and the sky he sees.
///
/// Two squads built the halves in parallel — one the device-scoped read, one the drawing —
/// and neither crossed the middle, so `main` briefly had a Memory door that opened onto an
/// honest but permanently empty field. This is the crossing, and it is deliberately its own
/// file: an adapter written blind, inside either half, is how the three traps below get
/// stepped on.
enum SkyFromMemory {

    /// A `SkySource` reading disk first and the network second.
    ///
    /// Disk first is not an optimisation. The constellation is a screen he opens to look at
    /// something, and a screen that opens on a spinner is not that — local-first is not
    /// suspended for a pretty view.
    ///
    /// A failed fetch is **not** an error state here. The stored sky is still true; it is
    /// merely older than it could be. Reporting "could not load" over a perfectly good sky
    /// would be the app apologising for having done its job.
    /// Optional, because the store may not have opened — a full disk, a corrupt file.
    /// That is a real state, and the honest answer to it is an empty sky rather than a
    /// crash on a screen whose whole purpose is to be looked at.
    static func source(_ constellation: ConstellationSource?) -> SkySource {
        guard let constellation else { return { .empty } }
        return { @Sendable in
            // Disk first, and only reached for if it is there. `cached()` returning nil
            // means NEVER FETCHED, which is not the same as "she remembers nothing" — see
            // `snapshot(from:)`.
            let stored = try? constellation.cached()
            if let stored {
                Task.detached { try? await constellation.refresh() }
                return snapshot(from: stored)
            }

            guard let fetched = try? await constellation.refresh() else {
                // Nothing on disk AND no answer from the server. This is the state I
                // originally returned `.empty` for, and it rendered as "I have not learned
                // anything about you worth keeping" over thirty real memories, because the
                // route was younger than the running service.
                //
                // Empty is a statement. This is not one.
                return ConstellationSnapshot(unreachable: true)
            }
            return snapshot(from: fetched)
        }
    }

    /// Translate the wire's sky into the one the layout draws.
    ///
    /// Three things here are corrections rather than choices, each flagged by the squad
    /// that built the read:
    ///
    /// 1. **Depth comes from `createdAt`, never from `provenance.learnedAt`.** The latter is
    ///    optional and nil for every unattested star, and depth is age — so mapping off it
    ///    would render the oldest unconnected memories as brand new. `createdAt` is
    ///    non-optional, so the missing case does not exist rather than being handled.
    /// 2. **`anchorId == nil` covers two different stars** — a real anchor, and an orphan
    ///    connected to none. `anchor` is the field that tells them apart, and without it an
    ///    unattested decision would be drawn with a person's visual weight.
    /// 3. **An unattested star's confidence is the weight law's floor** — around `1e-9`,
    ///    not zero, because decay approaches zero and never arrives. Drawn linearly that is
    ///    not faint, it is invisible: the star exists, occupies a slot, and renders as
    ///    nothing. So brightness is floored at something a human eye can find. A memory she
    ///    holds weakly should look weak, not absent — absent is what `forget` is for.
    static func snapshot(from wire: MemoryConstellation) -> ConstellationSnapshot {
        ConstellationSnapshot(
            nodes: wire.stars.map { star in
                ConstellationNode(
                    id: star.id,
                    kind: kind(of: star),
                    tier: tier(of: star.tier),
                    confidence: max(star.confidence, faintestVisible),
                    label: star.label,
                    // Nil on an anchor is correct — it orbits nothing. Nil on an orphan is
                    // also correct, and the layout places it rather than dropping it.
                    anchorId: star.anchorId,
                    learnedAt: star.createdAt,
                    body: star.body,
                    // **Carried whole, and this is the only thing the card is made of.**
                    // Provenance is the answer to the only question that matters about a
                    // memory; a client that dropped it on the floor here would leave the
                    // card with nothing to say but the label it already drew.
                    provenance: ConstellationProvenance(
                        species: species(of: star.provenance.species),
                        assertedBy: star.provenance.assertedBy,
                        reasoning: star.provenance.reasoning,
                        learnedAt: star.provenance.learnedAt
                    )
                )
            },
            edges: wire.filaments.map { filament in
                ConstellationEdge(
                    id: filament.id,
                    from: filament.from,
                    to: filament.to,
                    species: species(of: filament.species),
                    confidence: max(filament.confidence, faintestVisible),
                    relation: filament.relation,
                    // Verbatim. Her reasoning is the one place the inference engine ever
                    // explains itself to him, and it is shown as she wrote it — not
                    // truncated here, not summarised, not turned into a field.
                    reasoning: filament.reasoning,
                    touchedAt: filament.lastTouchedAt
                )
            },
            // The server's own stamp, not the moment the phone read it. A sky drawn from
            // disk on a plane is honest about being from Tuesday; overwriting it with
            // `Date()` on read would make every stale sky claim to be current.
            capturedAt: wire.generatedAt
        )
    }

    /// The dimmest a star may be drawn.
    ///
    /// Confidence decays asymptotically toward zero and never reaches it, so the data's
    /// floor is far below what a screen can show. This is the point where "she barely holds
    /// this" stops being visible at all, and a star that renders as nothing is
    /// indistinguishable from one she has forgotten — which is a claim this app is not
    /// allowed to make by accident.
    private static let faintestVisible = 0.06

    private static func kind(of star: MemoryStar) -> ConstellationKind {
        // `anchor` decides the visual weight, not the kind, because the server already
        // worked out which nodes the sky is built around and the client second-guessing it
        // would give two answers to one question.
        switch star.kind {
        case .person: return .person
        case .goal: return .goal
        case .decision: return .decision
        case .event: return .event
        case .source: return .source
        case .memory: return .memory
        case .fact: return .fact
        }
    }

    private static func tier(of tier: MemoryTier) -> ConstellationTier {
        switch tier {
        case .hot: return .hot
        case .cold: return .cold
        case .suppressed: return .suppressed
        }
    }

    private static func species(of species: MemoryEdgeSpecies) -> ConstellationSpecies {
        switch species {
        case .observed: return .observed
        case .inferred: return .inferred
        }
    }

    /// A star's species keeps its third case.
    ///
    /// `unattested` is not a species of edge — it is a star nothing connects to — and
    /// flattening it into `observed` would have the card claim he said something nobody
    /// said. See `MemoryStarProvenance`, which makes the same point from the wire's side.
    private static func species(of species: MemoryStarSpecies) -> ConstellationStarSpecies {
        switch species {
        case .observed: return .observed
        case .inferred: return .inferred
        case .unattested: return .unattested
        }
    }
}
