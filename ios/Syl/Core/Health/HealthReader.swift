import Foundation
import HealthKit
import SylKit

/// Reads the seven curated HealthKit types, and — the point of the whole file —
/// **reports what it was allowed to read alongside what it read.**
///
/// `syl-t9tj.1.2`.
///
/// ## Why the report exists
///
/// HealthKit's authorisation is asymmetric in a way that makes a missing permission
/// SILENT. A type the Commander has not granted does not error and does not report
/// denial — **it reads as empty**. So "he walked nowhere on Tuesday" and "we were never
/// allowed to look at steps" are the same zero samples from the server's point of view,
/// forever, with every layer reporting success.
///
/// Only the phone knows the difference, so the phone says so, per type, on every upload.
/// That is `syl-kqc` one subsystem over: a capability the payload claimed and the binary
/// had never been signed for, accepted by iOS, downgraded silently, suppressed by Focus.
/// Server said delivered, Apple said accepted, the phone showed nothing, and no layer
/// recorded an error.
///
/// ## What iOS will and will not tell us — READ THIS BEFORE TRUSTING THE REPORT
///
/// There is **no API that reports read authorisation**, and that is deliberate on
/// Apple's part rather than an oversight we can work around:
///
/// - `HKHealthStore.authorizationStatus(for:)` answers about *sharing* (writing). Syl
///   asks for read only, so after the sheet it answers `.sharingDenied` for all seven
///   types whatever the Commander actually granted. Reading it as a read status is the
///   single most attractive wrong answer here, which is why it is named and rejected.
/// - `statusForAuthorizationRequest(toShare:read:)` answers **"would iOS still present a
///   prompt for this?"** — nothing about the answer he gave. Asked one type at a time it
///   is a reliable, per-type detector of `notDetermined`, and it is the only authorisation
///   fact this file can prove.
/// - A returned sample is a proof of the other direction: you cannot read a sample you
///   are not allowed to read. It is the only positive proof the platform offers, and it
///   only exists when there is data.
///
/// So the honest states are four, not three — see ``HealthReadAuthorisation`` — and the
/// narrowing to the contract's three happens in exactly one place,
/// ``HealthReadAuthorisation/wireState``, where it can be read and argued with.
///
/// **The residual hole, stated rather than hidden**: read access revoked in Settings
/// *after* this app has proven it readable is undetectable by any API. Samples simply
/// stop arriving. See ``HealthReadAuthorisation/undisclosed`` for what is done about it
/// and what is not.
protocol HealthReading: Sendable {
    /// Present the HealthKit sheet for all seven types, once. A no-op on a second call:
    /// iOS shows nothing if it has already asked.
    func requestAuthorisation() async throws

    /// Read up to `limitPerType` samples of each type, oldest first, from each type's
    /// watermark.
    ///
    /// The returned report is **complete** — every ``HealthType`` is present — because an
    /// upload that omits one is refused, and because a type we could not read is the
    /// single most important thing this call has to say.
    func read(
        since watermarks: [HealthType: Date],
        limitPerType: Int
    ) async throws -> HealthReadPage
}

// MARK: - What the phone can honestly claim

/// What the phone can **prove** about one type's read permission.
///
/// Four cases where the wire has three, because two of the wire's three are not
/// separable on this platform and pretending otherwise would produce an authorisation
/// report that is itself a guess — which is worse than none, because it will be trusted.
enum HealthReadAuthorisation: String, Equatable, Hashable, Sendable, CaseIterable {
    /// **Proven.** `statusForAuthorizationRequest` says iOS would still present a prompt
    /// for this type, so the Commander has never answered for it. A prompt he has not
    /// seen, not an answer he gave.
    case notDetermined

    /// **Proven.** HealthKit handed this app a sample of this type. You cannot read a
    /// sample you are not allowed to read.
    case readable

    /// Asked, and never proven readable. **This is not "he denied it".**
    ///
    /// It is the union of three situations iOS refuses to tell apart:
    ///
    /// 1. he denied read access for this type;
    /// 2. he granted it and there is genuinely nothing there;
    /// 3. he granted it, we proved it once, and he has since revoked it in Settings.
    ///    Undetectable by any API — see `syl-m3gi`.
    ///
    /// (3) is why ``HealthProofLedger`` records the proof but this enum does not treat it
    /// as permanent truth on its own — though nothing on the platform can actually catch
    /// a revocation, so (3) presents exactly as (2) until he says something.
    case undisclosed

    /// HealthKit does not exist on this device.
    case unavailable
}

extension HealthReadAuthorisation {
    /// The narrowing to the contract's three states. **The one place a judgement is made,
    /// so it is the one place to argue with.**
    ///
    /// `undisclosed` becomes `denied`, and that is a deliberate choice of which way to be
    /// wrong. The only consumer that matters is the contract's `silenceIsEvidence`, which
    /// is true for `authorised` alone — so:
    ///
    /// - mapping `undisclosed` to `authorised` would let the server read "we were not
    ///   allowed to look" as "nothing happened". That is the exact conclusion this whole
    ///   feature was built to make impossible, surfaced to him through Focus at the level
    ///   reserved for things that matter.
    /// - mapping it to `denied` costs a *label*: a genuinely authorised type that has
    ///   never yet produced a sample reads as denied in the admin until it does. Wrong,
    ///   visible, and it corrects itself the moment one sample arrives.
    ///
    /// A wrong label he can see beats a wrong conclusion he cannot. `unavailable` goes the
    /// same way for the same reason — a device with no HealthKit has not observed that he
    /// did nothing.
    ///
    /// **The contract cannot express `undisclosed`, and it should.** `syl-m3gi`, filed
    /// rather than faked — the contract is pinned, so this mapping is lossy on purpose and
    /// says so here rather than in a commit message.
    var wireState: HealthAuthorisationState {
        switch self {
        case .notDetermined: return .notDetermined
        case .readable: return .authorised
        case .undisclosed, .unavailable: return .denied
        }
    }
}

/// One read pass: what came back, and what we were allowed to look at while it did.
struct HealthReadPage: Equatable, Sendable {
    /// Complete — every ``HealthType`` is a key.
    let authorisation: [HealthType: HealthReadAuthorisation]
    /// Oldest first, across all types.
    let samples: [HealthSampleInput]
    /// Types whose page came back full, so there is more history behind them. What lets
    /// a cold start of 60 days page through without a special path.
    let hasMore: Set<HealthType>

    init(
        authorisation: [HealthType: HealthReadAuthorisation],
        samples: [HealthSampleInput],
        hasMore: Set<HealthType> = []
    ) {
        self.authorisation = authorisation
        self.samples = samples
        self.hasMore = hasMore
    }

    /// The report as the wire wants it. Complete by construction.
    var wireAuthorisation: [HealthType: HealthAuthorisationState] {
        var report: [HealthType: HealthAuthorisationState] = [:]
        for type in HealthType.allCases {
            report[type] = (authorisation[type] ?? .undisclosed).wireState
        }
        return report
    }
}

// MARK: - The proof ledger

/// Remembers that a type was once proven readable.
///
/// Without this, `readable` would be a property of the current batch rather than of the
/// permission — and in steady state most batches are empty for most types (he weighs
/// himself weekly; he does not work out every day). Every quiet type would report
/// `denied` on nearly every upload, the server would never treat any silence as evidence,
/// and the admin would show "not authorised" for a phone that is working perfectly. The
/// report would be complete, arrive on every upload, and mean nothing.
///
/// What it deliberately does **not** do is expire. A proof that decayed would flip a
/// working type to `denied` after a quiet fortnight, which is the same uselessness on a
/// timer.
protocol HealthProofLedger: Sendable {
    func provenReadableAt(_ type: HealthType) -> Date?
    func recordProvenReadable(_ type: HealthType, at instant: Date)
}

/// The shipping ledger. `UserDefaults` rather than the GRDB store on purpose: this is a
/// fact about the *installation's permissions*, not about his data, and it must be
/// readable before the database is open.
///
/// `@unchecked Sendable` for the same reason `SylBackend` is — `UserDefaults` is
/// documented thread-safe and simply not annotated.
struct UserDefaultsHealthProofLedger: HealthProofLedger, @unchecked Sendable {
    private static let prefix = "syl.health.provenReadableAt."

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func provenReadableAt(_ type: HealthType) -> Date? {
        defaults.object(forKey: Self.prefix + type.rawValue) as? Date
    }

    func recordProvenReadable(_ type: HealthType, at instant: Date) {
        defaults.set(instant, forKey: Self.prefix + type.rawValue)
    }
}

// MARK: - The HealthKit types, and the units they are fixed to

extension HealthType {
    /// The HealthKit object this type reads from.
    ///
    /// `nil` only if a HealthKit identifier disappears from a future SDK, which would be a
    /// contract break rather than something to survive — the caller reports it as
    /// `unavailable` rather than as an empty read, because those are the two answers this
    /// whole file exists to keep apart.
    var healthKitObjectType: HKObjectType? {
        switch self {
        case .heartRate: return HKObjectType.quantityType(forIdentifier: .heartRate)
        case .restingHeartRate: return HKObjectType.quantityType(forIdentifier: .restingHeartRate)
        case .heartRateVariability:
            return HKObjectType.quantityType(forIdentifier: .heartRateVariabilitySDNN)
        case .sleep: return HKObjectType.categoryType(forIdentifier: .sleepAnalysis)
        case .steps: return HKObjectType.quantityType(forIdentifier: .stepCount)
        case .workout: return HKObjectType.workoutType()
        case .bodyMass: return HKObjectType.quantityType(forIdentifier: .bodyMass)
        }
    }

    /// The `HKUnit` for ``SylKit/HealthType/unit``.
    ///
    /// The two are asserted equal by `HealthUnitTests`, which is what stops the wire's
    /// unit table drifting away from the conversion that feeds it. A drift here is a
    /// number that means something else with nothing to say so — a resting heart rate in
    /// beats per *second* is 0.9, which is not obviously wrong to anything downstream.
    ///
    /// `sleep` and `workout` have no `HKQuantity`; their value is a duration, converted
    /// from seconds through this same unit so the table stays the single statement of it.
    var healthKitUnit: HKUnit {
        switch self {
        case .heartRate, .restingHeartRate:
            return HKUnit.count().unitDivided(by: .minute())
        case .heartRateVariability:
            return HKUnit.secondUnit(with: .milli)
        case .sleep, .workout:
            return .minute()
        case .steps:
            return .count()
        case .bodyMass:
            return .pound()
        }
    }
}

// MARK: - The reader

/// The HealthKit-backed ``HealthReading``.
///
/// `@unchecked Sendable`: `HKHealthStore` is documented as safe to use from any thread
/// and `UserDefaults` likewise; neither carries the annotation.
final class HealthReader: HealthReading, @unchecked Sendable {
    /// How far back a cold start reaches. The retention the Commander chose, so asking
    /// for more would upload history the server throws away on arrival.
    static let coldStartWindow: TimeInterval = 60 * 24 * 60 * 60

    /// How far *behind* its watermark each read re-reads.
    ///
    /// **HealthKit data arrives out of order.** A watch that syncs at noon inserts samples
    /// stamped 03:00, behind a watermark that has already moved past them, and a strict
    /// resume would skip them permanently and silently — the failure mode this project
    /// forbids. Re-reading the overlap costs nothing, because the server deduplicates by
    /// sample identity rather than by request.
    ///
    /// Six hours bounds the common case (a watch that syncs within a day) and **does not
    /// close the hole**: a device unsynced for longer still loses its backlog.
    /// `HKAnchoredObjectQuery` orders by insertion rather than by sample date and is the
    /// real fix — `syl-7rer`.
    static let backfillOverlap: TimeInterval = 6 * 60 * 60

    private let store: HKHealthStore
    private let ledger: any HealthProofLedger
    private let now: @Sendable () -> Date

    init(
        store: HKHealthStore = HKHealthStore(),
        ledger: any HealthProofLedger = UserDefaultsHealthProofLedger(),
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.store = store
        self.ledger = ledger
        self.now = now
    }

    /// Every type, as HealthKit objects. Read only — Syl reads his body and never writes
    /// to it, which is also why `NSHealthUpdateUsageDescription` is absent from the build
    /// settings. A capability we do not rely on is one we should not ask for.
    private static var readTypes: Set<HKObjectType> {
        Set(HealthType.allCases.compactMap(\.healthKitObjectType))
    }

    func requestAuthorisation() async throws {
        guard HKHealthStore.isHealthDataAvailable() else { return }
        try await store.requestAuthorization(toShare: [], read: Self.readTypes)
    }

    func read(
        since watermarks: [HealthType: Date],
        limitPerType: Int
    ) async throws -> HealthReadPage {
        guard HKHealthStore.isHealthDataAvailable() else {
            return HealthReadPage(
                authorisation: Dictionary(
                    uniqueKeysWithValues: HealthType.allCases.map { ($0, .unavailable) }
                ),
                samples: []
            )
        }

        let readAt = now()
        var authorisation: [HealthType: HealthReadAuthorisation] = [:]
        var samples: [HealthSampleInput] = []
        var hasMore: Set<HealthType> = []

        for type in HealthType.allCases {
            guard let objectType = type.healthKitObjectType else {
                authorisation[type] = .unavailable
                continue
            }

            let start = Self.readStart(watermark: watermarks[type], readAt: readAt)
            let page = try await readSamples(of: type, since: start, limit: limitPerType)

            if !page.isEmpty {
                ledger.recordProvenReadable(type, at: readAt)
            }
            if page.count >= limitPerType {
                hasMore.insert(type)
            }
            samples.append(contentsOf: page)

            authorisation[type] = try await authorisationState(
                for: type,
                objectType: objectType,
                sawSamples: !page.isEmpty
            )
        }

        samples.sort { $0.startedAt < $1.startedAt }
        return HealthReadPage(authorisation: authorisation, samples: samples, hasMore: hasMore)
    }

    /// The lower bound of one type's query.
    ///
    /// A missing watermark is a cold start, which reaches back ``coldStartWindow`` — and
    /// is otherwise exactly the same code path as a warm one. "Uploading 60 days of
    /// history from cold does not require a special path" is an acceptance criterion, and
    /// a special path is where the untested branch lives.
    static func readStart(watermark: Date?, readAt: Date) -> Date {
        let coldStart = readAt.addingTimeInterval(-coldStartWindow)
        guard let watermark else { return coldStart }
        return max(coldStart, watermark.addingTimeInterval(-backfillOverlap))
    }

    private func authorisationState(
        for type: HealthType,
        objectType: HKObjectType,
        sawSamples: Bool
    ) async throws -> HealthReadAuthorisation {
        let provenBefore = ledger.provenReadableAt(type) != nil
        if sawSamples || provenBefore {
            // No need to ask iOS a question whose answer cannot change this.
            return .readable
        }
        let status = try await store.statusForAuthorizationRequest(toShare: [], read: [objectType])
        return Self.authorisation(
            sawSamples: sawSamples,
            provenReadableBefore: provenBefore,
            requestStatus: status
        )
    }

    /// One type's authorisation, from the two facts the platform will actually give up.
    /// **Pure, and the seam the empty-versus-denied guarantee is tested at.**
    ///
    /// Order matters: a sample in hand is proof and outranks everything else — a type can
    /// be readable *and* report `.shouldRequest` when a later build adds a type to the
    /// request set, and the sample is the fact while the status is a question about a
    /// prompt.
    ///
    /// `.unknown` is HealthKit failing to answer. That is not "he has not been asked"; it
    /// lands with everything else we cannot prove, because the cost of guessing in the
    /// other direction is a conclusion about a body nobody looked at.
    static func authorisation(
        sawSamples: Bool,
        provenReadableBefore: Bool,
        requestStatus: HKAuthorizationRequestStatus
    ) -> HealthReadAuthorisation {
        if sawSamples || provenReadableBefore { return .readable }

        switch requestStatus {
        case .shouldRequest: return .notDetermined
        case .unnecessary: return .undisclosed
        case .unknown: return .undisclosed
        @unknown default: return .undisclosed
        }
    }

    // MARK: - Reading each shape HealthKit stores

    /// The predicate every read uses.
    ///
    /// `.strictStartDate` and no upper bound. The watermark is on `startedAt` and so is
    /// the filter, deliberately: a watermark on `endedAt` would skip a sleep sample that
    /// began before the mark and ended after it — eight hours of his night, gone, with
    /// nothing to say so. The bound is inclusive, so the boundary sample is re-read; the
    /// server deduplicates it by identity, and re-reading is the direction to be wrong in.
    private func readSamples(
        of type: HealthType,
        since start: Date,
        limit: Int
    ) async throws -> [HealthSampleInput] {
        let predicate = HKQuery.predicateForSamples(
            withStart: start,
            end: nil,
            options: [.strictStartDate]
        )

        switch type {
        case .sleep:
            guard let categoryType = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) else {
                return []
            }
            let descriptor = HKSampleQueryDescriptor(
                predicates: [.categorySample(type: categoryType, predicate: predicate)],
                sortDescriptors: [SortDescriptor(\.startDate, order: .forward)],
                limit: limit
            )
            return try await descriptor.result(for: store).compactMap(Self.sleepSample)

        case .workout:
            let descriptor = HKSampleQueryDescriptor(
                predicates: [.workout(predicate)],
                sortDescriptors: [SortDescriptor(\.startDate, order: .forward)],
                limit: limit
            )
            return try await descriptor.result(for: store).map { workout in
                HealthSampleInput(
                    type: .workout,
                    startedAt: workout.startDate,
                    endedAt: workout.endDate,
                    value: Self.minutes(workout.duration),
                    source: workout.sourceRevision.source.name
                )
            }

        case .heartRate, .restingHeartRate, .heartRateVariability, .steps, .bodyMass:
            guard let quantityType = type.healthKitObjectType as? HKQuantityType else { return [] }
            let unit = type.healthKitUnit
            let descriptor = HKSampleQueryDescriptor(
                predicates: [.quantitySample(type: quantityType, predicate: predicate)],
                sortDescriptors: [SortDescriptor(\.startDate, order: .forward)],
                limit: limit
            )
            return try await descriptor.result(for: store).map { sample in
                HealthSampleInput(
                    type: type,
                    startedAt: sample.startDate,
                    endedAt: sample.endDate,
                    value: sample.quantity.doubleValue(for: unit),
                    source: sample.sourceRevision.source.name
                )
            }
        }
    }

    /// One sleep stage, or nothing.
    ///
    /// **Only the asleep stages are kept.** `inBed` and `awake` overlap them in time —
    /// eight hours in bed containing six hours asleep is not fourteen hours of anything —
    /// and keeping both would make "sleep" a number that double-counts every night. Worse,
    /// an `inBed` and an `asleepCore` row with the same start, end and source are the same
    /// sample by the contract's identity, so the server would hold one of them and never
    /// say which.
    private static func sleepSample(_ sample: HKCategorySample) -> HealthSampleInput? {
        guard let stage = HKCategoryValueSleepAnalysis(rawValue: sample.value),
              HKCategoryValueSleepAnalysis.allAsleepValues.contains(stage)
        else { return nil }

        return HealthSampleInput(
            type: .sleep,
            startedAt: sample.startDate,
            endedAt: sample.endDate,
            value: minutes(sample.endDate.timeIntervalSince(sample.startDate)),
            source: sample.sourceRevision.source.name
        )
    }

    /// Seconds to the contract's minutes, through the same unit table the quantity types
    /// use, so there is one statement of what `min` means rather than a `/ 60` here.
    private static func minutes(_ duration: TimeInterval) -> Double {
        HKQuantity(unit: .second(), doubleValue: duration).doubleValue(for: .minute())
    }
}

// MARK: - Why `source` is the source's name and not the device's

/// `HKSample.device?.name` reads better — "Apple Watch" against "Justin's Apple Watch" —
/// and is the wrong choice, because it is **optional**. Source is part of a sample's
/// identity `(type, startedAt, endedAt, source)`, so a field that is present on some
/// samples and nil on others makes the same measurement land under two identities and
/// the server hold both. `sourceRevision.source.name` is always present, is stable across
/// syncs, and already carries the device in practice — watch-collected data arrives under
/// the watch's name.
private enum SourceNaming {}
