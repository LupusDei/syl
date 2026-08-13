import SylKit
import XCTest

@testable import Syl

/// `syl-t9tj.2.6`. The rule under test is one sentence: **the watermark advances only on
/// a confirmed server write.**
///
/// Advancing on send loses a batch on any failure, silently, and the loss is invisible by
/// construction — the next upload starts after the gap, so nothing ever looks for the
/// missing samples again and no layer records an error.
final class HealthUploaderTests: XCTestCase {
    private let epoch = Date(timeIntervalSince1970: 1_786_000_000)

    // MARK: - The rule

    func testShouldNotAdvanceTheWatermarkWhenTheUploadFails() async {
        let marks = FakeWatermarkStore()
        let reader = FakeHealthReader(pages: [page(samples: [sample(.steps, at: 100)])])
        let transport = FakeTransport(outcomes: [.failure(TransportFailure.offline)])

        let run = await uploader(reader, transport, marks).upload()

        XCTAssertEqual(run.failure, .upload(String(describing: TransportFailure.offline)))
        XCTAssertEqual(marks.stored, [:], "not one type moved")
        XCTAssertEqual(run.written, 0)
    }

    func testShouldLeaveAnExistingWatermarkExactlyWhereItWasWhenTheUploadFails() async {
        let existing = epoch.addingTimeInterval(50)
        let marks = FakeWatermarkStore(stored: [.steps: existing])
        let reader = FakeHealthReader(pages: [page(samples: [sample(.steps, at: 100)])])
        let transport = FakeTransport(outcomes: [.failure(TransportFailure.offline)])

        _ = await uploader(reader, transport, marks).upload()

        XCTAssertEqual(marks.stored, [.steps: existing])
    }

    func testShouldNotAdvanceTheWatermarkWhenTheReadItselfFails() async {
        let marks = FakeWatermarkStore()
        let reader = FakeHealthReader(pages: [], failure: ReadFailure.healthKitAngry)
        let transport = FakeTransport(outcomes: [])

        let run = await uploader(reader, transport, marks).upload()

        XCTAssertEqual(run.failure, .read(String(describing: ReadFailure.healthKitAngry)))
        XCTAssertEqual(marks.stored, [:])
        XCTAssertEqual(transport.uploads.count, 0, "and nothing was sent")
    }

    func testShouldAdvanceTheWatermarkOnceTheServerHasConfirmedTheWrite() async {
        let marks = FakeWatermarkStore()
        let reader = FakeHealthReader(
            pages: [page(samples: [sample(.steps, at: 100), sample(.steps, at: 300)])]
        )
        let transport = FakeTransport(outcomes: [.success(result(written: 2))])

        let run = await uploader(reader, transport, marks).upload()

        XCTAssertTrue(run.succeeded)
        XCTAssertEqual(run.written, 2)
        XCTAssertEqual(marks.stored[.steps], epoch.addingTimeInterval(300))
    }

    func testShouldRetryTheSameWindowAfterAFailureRatherThanSkipIt() async {
        // The point of not advancing: the next foreground reads the same samples again.
        // Duplicates are free — the server deduplicates by sample identity.
        let marks = FakeWatermarkStore()
        let samples = [sample(.steps, at: 100)]
        let reader = FakeHealthReader(pages: [page(samples: samples), page(samples: samples)])
        let transport = FakeTransport(
            outcomes: [.failure(TransportFailure.offline), .success(result(duplicates: 1))]
        )
        let subject = uploader(reader, transport, marks)

        _ = await subject.upload()
        let second = await subject.upload()

        XCTAssertEqual(reader.readWatermarks, [[:], [:]], "the second read starts where the first did")
        XCTAssertEqual(second.duplicates, 1)
        XCTAssertEqual(marks.stored[.steps], epoch.addingTimeInterval(100))
    }

    // MARK: - What the watermark is allowed to become

    func testShouldNotMovePastWhatItCanProveItRead() async {
        // A server watermark ahead of the newest sample we sent would skip measurements
        // nobody holds. The lesser of the two is the only safe answer.
        let marks = FakeWatermarkStore()
        let reader = FakeHealthReader(pages: [page(samples: [sample(.steps, at: 100)])])
        let transport = FakeTransport(
            outcomes: [
                .success(result(written: 1, watermarks: [.steps: epoch.addingTimeInterval(9_000)]))
            ]
        )

        _ = await uploader(reader, transport, marks).upload()

        XCTAssertEqual(marks.stored[.steps], epoch.addingTimeInterval(100))
    }

    func testShouldBelieveTheServerWhenItIsBehindUs() async {
        // The server is the authority on what it holds. If it says it only got as far as
        // 60, the phone resumes from 60 and re-sends the rest.
        let marks = FakeWatermarkStore()
        let reader = FakeHealthReader(pages: [page(samples: [sample(.steps, at: 100)])])
        let transport = FakeTransport(
            outcomes: [
                .success(result(written: 1, watermarks: [.steps: epoch.addingTimeInterval(60)]))
            ]
        )

        _ = await uploader(reader, transport, marks).upload()

        XCTAssertEqual(marks.stored[.steps], epoch.addingTimeInterval(60))
    }

    func testShouldNeverMoveAWatermarkBackwards() {
        let current: [HealthType: Date] = [.steps: epoch.addingTimeInterval(500)]

        let next = HealthUploader.advanced(
            from: current,
            sent: [sample(.steps, at: 100)],
            confirmed: [.steps: epoch.addingTimeInterval(100)]
        )

        XCTAssertEqual(next[.steps], epoch.addingTimeInterval(500))
    }

    func testShouldMarkFromTheStartOfASampleAndNotItsEnd() {
        // A sleep sample runs 23:00 to 07:00. A mark at 07:00, against a query that filters
        // on start date, skips the next night that began before it — eight hours of his
        // night, gone, with nothing to say so.
        let night = HealthSampleInput(
            type: .sleep,
            startedAt: epoch,
            endedAt: epoch.addingTimeInterval(8 * 3_600),
            value: 480,
            source: "Justin's Apple Watch"
        )

        let next = HealthUploader.advanced(from: [:], sent: [night], confirmed: [:])

        XCTAssertEqual(next[.sleep], epoch)
    }

    func testShouldLeaveATypeAloneWhenNothingWasSentForIt() {
        // Reading nothing is not proof of having reached `now`; a late-arriving sample may
        // still land behind us.
        let next = HealthUploader.advanced(
            from: [.steps: epoch],
            sent: [sample(.sleep, at: 900)],
            confirmed: [:]
        )

        XCTAssertEqual(next[.steps], epoch)
        XCTAssertEqual(next[.sleep], epoch.addingTimeInterval(900))
    }

    // MARK: - The report has to arrive even when nothing else does

    func testShouldUploadAnEmptyBatchSoADeniedTypeStillReachesTheServer() async {
        // The only way the server learns steps is denied. A client that skipped the call
        // would leave silence unattributable, which is the whole defect this closes.
        let marks = FakeWatermarkStore()
        let reader = FakeHealthReader(
            pages: [page(samples: [], authorisation: [.steps: .undisclosed])]
        )
        let transport = FakeTransport(outcomes: [.success(result())])

        let run = await uploader(reader, transport, marks).upload()

        XCTAssertTrue(run.succeeded)
        XCTAssertEqual(transport.uploads.count, 1)
        XCTAssertEqual(transport.uploads.first?.samples.count, 0)
        XCTAssertEqual(transport.uploads.first?.authorisation[.steps], .denied)
    }

    func testShouldSendACompleteReportOnEveryBatchOfAColdStart() async {
        let marks = FakeWatermarkStore()
        let reader = FakeHealthReader(
            pages: [
                page(samples: [sample(.steps, at: 100)], hasMore: [.steps]),
                page(samples: [sample(.steps, at: 200)]),
            ]
        )
        let transport = FakeTransport(
            outcomes: [.success(result(written: 1)), .success(result(written: 1))]
        )

        _ = await uploader(reader, transport, marks, batchSize: 1).upload()

        XCTAssertEqual(transport.uploads.count, 2)
        for upload in transport.uploads {
            XCTAssertTrue(upload.isComplete, "every batch, not just the first")
        }
    }

    func testShouldStillSendACompleteReportWhenTheReadLostATypeEntirely() async {
        // The one place a guess about permission could creep back in. A read that says
        // nothing about `bodyMass` must not produce an upload that says nothing about it —
        // the server would refuse that, and the default it would otherwise need is exactly
        // the guess this feature abolishes. It reports the conservative state instead.
        var partial: [HealthType: HealthReadAuthorisation] = [:]
        for type in HealthType.allCases where type != .bodyMass {
            partial[type] = .readable
        }
        let marks = FakeWatermarkStore()
        let reader = FakeHealthReader(
            pages: [HealthReadPage(authorisation: partial, samples: [])]
        )
        let transport = FakeTransport(outcomes: [.success(result())])

        let run = await uploader(reader, transport, marks).upload()

        XCTAssertTrue(run.succeeded)
        let sent = try? XCTUnwrap(transport.uploads.first)
        XCTAssertEqual(sent?.authorisation.count, HealthType.allCases.count)
        XCTAssertEqual(sent?.authorisation[.bodyMass], .denied)
        XCTAssertFalse(HealthUpload.silenceIsEvidence(.denied))
    }

    // MARK: - Sixty days from cold, with no special path

    func testShouldPageThroughAColdStartUntilNothingIsLeftBehind() async {
        let marks = FakeWatermarkStore()
        let pages = (0..<5).map { index in
            page(
                samples: [sample(.heartRate, at: Double(index) * 60)],
                hasMore: index < 4 ? [.heartRate] : []
            )
        }
        let reader = FakeHealthReader(pages: pages)
        let transport = FakeTransport(
            outcomes: Array(repeating: .success(result(written: 1)), count: 5)
        )

        let run = await uploader(reader, transport, marks, batchSize: 1).upload()

        XCTAssertTrue(run.succeeded)
        XCTAssertEqual(run.batches, 5)
        XCTAssertEqual(run.sent, 5)
        XCTAssertEqual(marks.stored[.heartRate], epoch.addingTimeInterval(240))
        XCTAssertEqual(
            reader.readWatermarks.last?[.heartRate],
            epoch.addingTimeInterval(180),
            "each page resumes from the last confirmed one"
        )
    }

    func testShouldStopWhenAPageClaimsMoreBehindItButNothingMoved() async {
        // Otherwise a server that never lets a watermark move spins the run to its batch
        // limit, which looks like progress and is not. Stopping loses nothing: the next
        // foreground tries again.
        let marks = FakeWatermarkStore()
        let stuck = page(samples: [], hasMore: [.steps])
        let reader = FakeHealthReader(pages: Array(repeating: stuck, count: 10))
        let transport = FakeTransport(
            outcomes: Array(repeating: .success(result()), count: 10)
        )

        let run = await uploader(reader, transport, marks).upload()

        XCTAssertTrue(run.succeeded)
        XCTAssertEqual(run.batches, 1)
    }

    // MARK: - Fixtures

    private func uploader(
        _ reader: FakeHealthReader,
        _ transport: FakeTransport,
        _ marks: FakeWatermarkStore,
        batchSize: Int = 500
    ) -> HealthUploader {
        HealthUploader(
            reader: reader,
            transport: transport,
            watermarks: marks,
            batchSize: batchSize,
            batchLimit: 8
        )
    }

    private func sample(_ type: HealthType, at offset: Double) -> HealthSampleInput {
        HealthSampleInput(
            type: type,
            startedAt: epoch.addingTimeInterval(offset),
            endedAt: epoch.addingTimeInterval(offset),
            value: 1,
            source: "Justin's iPhone"
        )
    }

    private func page(
        samples: [HealthSampleInput],
        authorisation overrides: [HealthType: HealthReadAuthorisation] = [:],
        hasMore: Set<HealthType> = []
    ) -> HealthReadPage {
        var report: [HealthType: HealthReadAuthorisation] = [:]
        for type in HealthType.allCases {
            report[type] = overrides[type] ?? .readable
        }
        return HealthReadPage(authorisation: report, samples: samples, hasMore: hasMore)
    }

    private func result(
        written: Int = 0,
        duplicates: Int = 0,
        watermarks: [HealthType: Date] = [:]
    ) -> HealthUploadResult {
        HealthUploadResult(written: written, duplicates: duplicates, watermarks: watermarks)
    }
}

// MARK: - Doubles

private enum TransportFailure: Error, Equatable { case offline }
private enum ReadFailure: Error, Equatable { case healthKitAngry }

private final class FakeHealthReader: HealthReading, @unchecked Sendable {
    private var pages: [HealthReadPage]
    private let failure: (any Error)?
    private(set) var readWatermarks: [[HealthType: Date]] = []
    private(set) var requestedAuthorisation = false

    init(pages: [HealthReadPage], failure: (any Error)? = nil) {
        self.pages = pages
        self.failure = failure
    }

    func requestAuthorisation() async throws {
        requestedAuthorisation = true
    }

    func read(since watermarks: [HealthType: Date], limitPerType: Int) async throws -> HealthReadPage {
        readWatermarks.append(watermarks)
        if let failure { throw failure }
        guard !pages.isEmpty else {
            return HealthReadPage(
                authorisation: Dictionary(
                    uniqueKeysWithValues: HealthType.allCases.map { ($0, .readable) }
                ),
                samples: []
            )
        }
        return pages.removeFirst()
    }
}

private final class FakeTransport: HealthUploadTransport, @unchecked Sendable {
    private var outcomes: [Result<HealthUploadResult, any Error>]
    private(set) var uploads: [HealthUpload] = []

    init(outcomes: [Result<HealthUploadResult, any Error>]) {
        self.outcomes = outcomes
    }

    func upload(_ upload: HealthUpload) async throws -> HealthUploadResult {
        uploads.append(upload)
        guard !outcomes.isEmpty else {
            return HealthUploadResult(written: 0, duplicates: 0, watermarks: [:])
        }
        return try outcomes.removeFirst().get()
    }
}

private final class FakeWatermarkStore: HealthWatermarkStore, @unchecked Sendable {
    private(set) var stored: [HealthType: Date]

    init(stored: [HealthType: Date] = [:]) {
        self.stored = stored
    }

    func watermarks() -> [HealthType: Date] { stored }

    func advance(to watermarks: [HealthType: Date]) {
        stored = watermarks
    }
}
