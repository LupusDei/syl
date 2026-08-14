import Foundation
import SylKit

/// Batches what ``HealthReader`` read and sends it to `POST /health/samples`, advancing
/// each type's watermark **only on a confirmed server write**.
///
/// `syl-t9tj.2.6`.
///
/// ## The rule this type exists to hold
///
/// Advancing a watermark on *send* loses a batch on any failure, silently, and the loss
/// is invisible by construction — the next upload starts after the gap, so nothing ever
/// looks for the missing samples again and no layer records an error. That is constraint
/// 4 wearing different clothes: a late upload is a nuisance, a vanished one is a hole in
/// the record she will later reason from.
///
/// So the order is fixed: read, send, **wait for the answer**, then advance. A throw
/// anywhere before the answer leaves every watermark exactly where it was, and the next
/// foreground reads the same window again. The server deduplicates by sample identity, so
/// re-reading is free.
///
/// ## Foreground only
///
/// HealthKit background delivery is deliberately not implemented — the same rule that
/// keeps `UIBackgroundModes` out of `Syl.entitlements`. A capability we do not rely on is
/// one we should not ask for, and health data that arrives when he next opens the app is
/// health data that arrives in time for everything this feature does with it.
///
/// ## Cold start
///
/// Sixty days of history is the ordinary path taken more times: a missing watermark makes
/// ``HealthReader`` reach back sixty days, and the run keeps going while any type reports
/// more behind it. There is no cold-start branch, because a special path is where the
/// untested branch lives, and the one it would replace runs on every launch.
final class HealthUploader: Sendable {
    /// Samples per type per batch. Sixty days of raw heart rate is on the order of 80,000
    /// samples, so the run pages; this is the page size and not a cap on the run.
    static let defaultBatchSize = 1_000

    /// A ceiling on batches per run, so a server that keeps answering "more behind you"
    /// cannot spin forever. Generous enough that a genuine cold start finishes inside it.
    static let defaultBatchLimit = 500

    private let reader: any HealthReading
    private let transport: any HealthUploadTransport
    private let watermarks: any HealthWatermarkStore
    private let batchSize: Int
    private let batchLimit: Int

    init(
        reader: any HealthReading,
        transport: any HealthUploadTransport,
        watermarks: any HealthWatermarkStore,
        batchSize: Int = HealthUploader.defaultBatchSize,
        batchLimit: Int = HealthUploader.defaultBatchLimit
    ) {
        self.reader = reader
        self.transport = transport
        self.watermarks = watermarks
        self.batchSize = batchSize
        self.batchLimit = batchLimit
    }

    /// Ask for every type, once. Safe to call on every foreground: iOS presents
    /// nothing if it has already asked.
    func requestAuthorisation() async throws {
        try await reader.requestAuthorisation()
    }

    /// One foreground pass. Never throws — a failed upload is a fact to report, not a
    /// reason to take down the launch path that called it.
    @discardableResult
    func upload() async -> HealthUploadRun {
        var run = HealthUploadRun()

        for _ in 0..<batchLimit {
            let before = watermarks.watermarks()

            let page: HealthReadPage
            do {
                page = try await reader.read(since: before, limitPerType: batchSize)
            } catch {
                run.failure = .read(String(describing: error))
                return run
            }

            // A batch with no samples is still uploaded, and that is not a wasted call:
            // it is the only way an authorisation report for a type he has denied ever
            // reaches the server. Silence with no report attached is the thing this
            // feature exists to abolish.
            let upload = HealthUpload(authorisation: page.wireAuthorisation, samples: page.samples)
            // Unreachable today, and kept: `wireAuthorisation` fills every key, and this
            // is the assertion that it still does. If it ever stops, the bug is named here
            // rather than arriving as a 400 nobody reads — and the batch is refused rather
            // than sent with a type defaulted, because the default would be a guess about
            // permission and a guess is what the report exists to abolish.
            guard upload.isComplete else {
                run.failure = .incompleteReport(upload.unreportedTypes)
                return run
            }

            let result: HealthUploadResult
            do {
                result = try await transport.upload(upload)
            } catch {
                // The watermarks are untouched. Everything in this batch will be read
                // again on the next foreground.
                run.failure = .upload(String(describing: error))
                return run
            }

            run.batches += 1
            run.sent += page.samples.count
            run.written += result.written
            run.duplicates += result.duplicates

            // Confirmed. Only now.
            let advanced = HealthUploader.advanced(
                from: before,
                sent: page.samples,
                confirmed: result.watermarks
            )
            watermarks.advance(to: advanced)

            guard !page.hasMore.isEmpty else { return run }

            // More behind us, but the window did not move. Reading again would hand back
            // the same page until `batchLimit`, so stop: the next foreground tries again
            // and nothing has been lost. The alternative is a loop that looks like
            // progress and is not.
            guard advanced != before else { return run }
        }

        run.failure = .batchLimitReached
        return run
    }

    /// Where each type resumes, after a confirmed write.
    ///
    /// Three rules, and each one is a way this has gone wrong somewhere:
    ///
    /// 1. **Never regress.** A watermark that moves backwards re-reads forever; one that
    ///    moves backwards *past* a gap re-reads forever and still has the gap.
    /// 2. **Never move past what we can prove we read.** The new mark is the greatest
    ///    `startedAt` we actually sent — not `endedAt`. A sleep sample runs from 23:00 to
    ///    07:00, and a mark at 07:00 against a query that filters on start date skips the
    ///    next night that began before it.
    /// 3. **Believe the server when it is behind us, not when it is ahead.** The contract
    ///    says the phone resumes from the server's watermark, and it is the authority on
    ///    what it holds — but a mark ahead of what we sent would skip samples nobody has,
    ///    so the two are reconciled by taking the lesser.
    static func advanced(
        from current: [HealthType: Date],
        sent: [HealthSampleInput],
        confirmed: [HealthType: Date]
    ) -> [HealthType: Date] {
        var sentMax: [HealthType: Date] = [:]
        for sample in sent {
            sentMax[sample.type] = max(sentMax[sample.type] ?? sample.startedAt, sample.startedAt)
        }

        var next = current
        for type in HealthType.allCases {
            guard let proven = sentMax[type] else { continue }
            let candidate = min(proven, confirmed[type] ?? proven)
            next[type] = max(next[type] ?? candidate, candidate)
        }
        return next
    }
}

// MARK: - What a run did

/// The outcome of one foreground pass. Deliberately a value rather than a log line: the
/// diagnostics section can show it, and a test can assert on it.
struct HealthUploadRun: Equatable, Sendable {
    enum Failure: Equatable, Sendable {
        case read(String)
        case upload(String)
        /// The report was missing a type. The server would refuse it; refusing it here
        /// means the bug is named on the phone rather than as a 400 nobody reads.
        case incompleteReport([HealthType])
        case batchLimitReached
    }

    var batches = 0
    var sent = 0
    var written = 0
    var duplicates = 0
    var failure: Failure?

    var succeeded: Bool { failure == nil }
}

// MARK: - Seams

/// The network half, so the uploader is testable without a server — and so it can be
/// tested at all before `POST /health/samples` exists.
protocol HealthUploadTransport: Sendable {
    func upload(_ upload: HealthUpload) async throws -> HealthUploadResult
}

/// Where each type resumes from.
protocol HealthWatermarkStore: Sendable {
    func watermarks() -> [HealthType: Date]
    /// Replaces the whole map. Callers pass the result of
    /// ``HealthUploader/advanced(from:sent:confirmed:)``, which is monotonic, so this
    /// cannot move a mark backwards by accident.
    func advance(to watermarks: [HealthType: Date])
}

// MARK: - The shipping implementations

/// `UserDefaults`, for the same reason as ``UserDefaultsHealthProofLedger``: this is
/// bookkeeping about the installation rather than about his data, and it has to be
/// readable before the database is open.
struct UserDefaultsHealthWatermarkStore: HealthWatermarkStore, @unchecked Sendable {
    private static let prefix = "syl.health.watermark."

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func watermarks() -> [HealthType: Date] {
        var marks: [HealthType: Date] = [:]
        for type in HealthType.allCases {
            if let date = defaults.object(forKey: Self.prefix + type.rawValue) as? Date {
                marks[type] = date
            }
        }
        return marks
    }

    func advance(to watermarks: [HealthType: Date]) {
        for (type, date) in watermarks {
            defaults.set(date, forKey: Self.prefix + type.rawValue)
        }
    }
}

/// The real upload.
///
/// The idempotency key is minted per attempt, which inverts the outbox's rule and is safe
/// here for one reason: **this write deduplicates by sample identity, not by request**.
/// See `SylAPI.uploadHealthSamples`.
struct SylHealthUploadTransport: HealthUploadTransport {
    private let backend: SylBackend

    init(backend: SylBackend) {
        self.backend = backend
    }

    func upload(_ upload: HealthUpload) async throws -> HealthUploadResult {
        let endpoint = try SylAPI.uploadHealthSamples(
            upload,
            idempotencyKey: IdempotencyKey.generate()
        )
        return try await backend.client().send(endpoint)
    }
}
