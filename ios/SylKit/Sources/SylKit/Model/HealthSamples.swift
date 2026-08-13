import Foundation

/// The health upload wire types — the Swift half of `backend/src/health/contract.ts`.
///
/// That file is PINNED and this one mirrors it. Every name, every raw value and every
/// field name here is copied from it rather than invented; a shape designed twice is a
/// shape that disagrees, and the disagreement surfaces as a 400 on a phone nobody is
/// looking at.
///
/// Nothing in this file knows what HealthKit is. The conversion from `HKSample` to
/// `HealthSampleInput` — including the unit each type is fixed to — happens in the app
/// target, at `Core/Health/HealthReader.swift`, because `SylKit` builds on the host and
/// HealthKit does not exist there.

// MARK: - The seven types

/// The contract's `HealthType`.
///
/// `restingHeartRate` is deliberately distinct from `heartRate`: it is the baseline
/// nearly every conclusion leans on, while raw heart rate is the highest-volume type
/// HealthKit offers. `bodyMass` is here because `Get back to 185 pounds` is already a
/// goal in his memory graph.
public enum HealthType: String, Codable, Equatable, Hashable, Sendable, CaseIterable {
    case heartRate
    case restingHeartRate
    case heartRateVariability
    case sleep
    case steps
    case workout
    case bodyMass
}

/// **Required so a `[HealthType: _]` dictionary encodes as a JSON OBJECT.**
///
/// Without it `JSONEncoder` writes a dictionary keyed by a non-`String` type as a flat
/// ARRAY — `["steps", "denied", "sleep", "authorised"]` — which decodes back into Swift
/// perfectly and is unreadable to the server. It compiles, it round-trips through this
/// client, and it is wrong on the only hop that matters. Same family as the four traps
/// in `FourTrapsTests`.
extension HealthType: CodingKeyRepresentable {}

extension HealthType {
    /// The contract's `UNITS`. The unit each type's `value` is in, fixed per type so no
    /// sample carries its own — a client that could relabel a unit could change what a
    /// number means without changing the number.
    ///
    /// `HealthReader` turns each of these into an `HKUnit` and asserts the two agree, so
    /// this table cannot drift away from the conversion that feeds it.
    public var unit: String {
        switch self {
        case .heartRate, .restingHeartRate: return "count/min"
        case .heartRateVariability: return "ms"
        case .sleep, .workout: return "min"
        case .steps: return "count"
        case .bodyMass: return "lb"
        }
    }
}

// MARK: - What the phone was allowed to read

/// The contract's `AuthorisationState`. **Five states, and the order and spelling here
/// are copied from `AUTHORISATION_STATES`, including `authorised`.**
///
/// It began as three — `authorised | denied | notDetermined` — which is the model Apple's
/// documentation reads like and is not the one the API can answer. `denied`,
/// authorised-but-quiet, and authorised-then-revoked are ONE indistinguishable state on
/// this platform, so the phone had to narrow all three to `denied`, which put the
/// empty-versus-denied conflation back one level up, inside the very field built to
/// abolish it. Build 0.9.12 shipped that narrowing against real data and reported
/// `denied` for the three types that merely had no samples in them.
///
/// The contract then gained the two states the platform actually needs:
///
/// - `undisclosed` — asked, and iOS will not say. **Not "he denied it".**
/// - `unavailable` — the device cannot produce it at all.
///
/// so the lossy mapping is gone. See `HealthReadAuthorisation` in the app target for what
/// the phone can *prove*, and `HealthReadAuthorisation.wireState` for the translation,
/// which is now total rather than narrowing.
///
/// **Only `authorised` makes silence evidence** (``HealthUpload/silenceIsEvidence(_:)``),
/// so widening this enum is safe in the direction that matters: a state nobody proved
/// never licenses a conclusion drawn from its quiet.
public enum HealthAuthorisationState: String, Codable, Equatable, Hashable, Sendable, CaseIterable {
    case authorised
    case denied
    case notDetermined
    /// Asked, and the platform will not say.
    case undisclosed
    /// This device cannot measure it.
    case unavailable
}

// MARK: - The upload

/// One measurement, as the phone read it. The contract's `HealthSampleInput`.
///
/// Identity is `(type, startedAt, endedAt, source)` — see the contract's `sampleKey`.
/// That is what makes a retry, a racing second device, or an app that lost its watermark
/// harmless, and it is deliberately NOT the request's idempotency key: that guards one
/// HTTP call, and the failure to guard against is the same measurement arriving in two
/// different calls.
public struct HealthSampleInput: Codable, Equatable, Hashable, Sendable {
    public let type: HealthType
    public let startedAt: Date
    /// Equal to `startedAt` for an instantaneous reading.
    public let endedAt: Date
    /// The number itself, in ``HealthType/unit``.
    public let value: Double
    /// Which device or app recorded it — "Justin's Apple Watch", "iPhone", "Health Mate".
    ///
    /// Part of a sample's identity, because the same minute genuinely measured by a
    /// watch and a phone is two measurements rather than a duplicate, and averaging them
    /// silently would be inventing a third.
    public let source: String

    public init(type: HealthType, startedAt: Date, endedAt: Date, value: Double, source: String) {
        self.type = type
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.value = value
        self.source = source
    }
}

/// One upload from the phone. The contract's `HealthUpload`.
public struct HealthUpload: Codable, Equatable, Sendable {
    /// What the phone was ALLOWED to read, per type, at the moment it read.
    ///
    /// **Required, and required to be complete** — every case of ``HealthType`` must
    /// appear. The server refuses an upload that omits one rather than defaulting it,
    /// because the default would have to be a guess about permission and a guess is
    /// exactly what this field exists to abolish. ``isComplete`` is the client-side half
    /// of that, so the refusal is not the first time anyone notices.
    public let authorisation: [HealthType: HealthAuthorisationState]
    public let samples: [HealthSampleInput]

    public init(
        authorisation: [HealthType: HealthAuthorisationState],
        samples: [HealthSampleInput]
    ) {
        self.authorisation = authorisation
        self.samples = samples
    }

    /// The types missing from the report. Empty is the only shape the server accepts.
    ///
    /// Mirrors the contract's `unreportedTypes`.
    public var unreportedTypes: [HealthType] {
        HealthType.allCases.filter { authorisation[$0] == nil }
    }

    public var isComplete: Bool { unreportedTypes.isEmpty }
}

/// What the server answers, so the phone knows where to resume.
/// The contract's `HealthUploadResult`.
public struct HealthUploadResult: Codable, Equatable, Sendable {
    /// How many rows this upload actually created. Zero is a valid, quiet answer.
    public let written: Int
    /// How many were already held, by identity. Reported rather than hidden: a re-upload
    /// that silently answered `written: 0` is indistinguishable from an upload the server
    /// dropped, and the phone advances its watermark on this answer.
    public let duplicates: Int
    /// The new watermark per type. **Partial** — a type the server has nothing new for is
    /// absent rather than null, so the phone keeps what it had.
    public let watermarks: [HealthType: Date]

    public init(written: Int, duplicates: Int, watermarks: [HealthType: Date]) {
        self.written = written
        self.duplicates = duplicates
        self.watermarks = watermarks
    }
}

extension HealthUpload {
    /// Whether the server may treat an absence of samples for this type as evidence.
    ///
    /// Mirrors the contract's `silenceIsEvidence`, and is the one function that encodes
    /// the whole point of the report: only an `authorised` type with nothing in it means
    /// nothing happened. Every other state means we did not look, or cannot say we
    /// looked, and a conclusion drawn from one would be about his phone rather than about
    /// him.
    ///
    /// Deliberately an equality and not a set of exclusions, exactly as the contract
    /// writes it. Spelled `state != .denied`, every state added later would silently
    /// become evidence — which is how `undisclosed` would have started licensing
    /// conclusions about a body nobody looked at.
    public static func silenceIsEvidence(_ state: HealthAuthorisationState) -> Bool {
        state == .authorised
    }
}
