import SylKit
import XCTest

@testable import Syl

/// **The security half of `syl-008.6`.**
///
/// `Attachment` carries no URL, so the client composes every attachment path itself
/// against the server it is paired with. This suite is what keeps that true. Each case
/// below is a URL that a *plausible* implementation accepts and that belongs to somebody
/// else — the point is not that the current code refuses them, it is that a future
/// simplification which stops refusing them fails the build.
final class AttachmentSourceTests: XCTestCase {
    /// The Commander's actual tailnet shape, because a lookalike is only convincing
    /// against a realistic host.
    private let pairedHost = "reason-2.tail714e0e.ts.net"
    private lazy var paired = URL(string: "https://\(pairedHost)/api/v1")!
    private lazy var source = AttachmentSource(baseURL: paired)!

    private let attachmentId: SylID = "syl:attachment:019feb2f-e654-7000-ac0e-3f825d6a318c"

    // MARK: - What it builds

    func testShouldComposeAnAttachmentPathUnderTheApiBasePathExactlyOnce() throws {
        let url = try XCTUnwrap(source.url(for: attachmentId).success)

        XCTAssertEqual(
            url.absoluteString,
            "https://\(pairedHost)/api/v1/attachments/\(attachmentId)"
        )
    }

    func testShouldAskForTheThumbnailVariantAsAQueryParameter() throws {
        let url = try XCTUnwrap(source.url(for: attachmentId, variant: .thumb).success)

        XCTAssertTrue(url.absoluteString.hasSuffix("?variant=thumb"), url.absoluteString)
    }

    func testShouldNotWriteAVariantParameterForTheOriginal() throws {
        let url = try XCTUnwrap(source.url(for: attachmentId).success)

        XCTAssertNil(url.query, "the default must not be spelled out; it is the default")
    }

    func testShouldCarryANonDefaultPortIntoTheComposedURL() throws {
        let source = try XCTUnwrap(AttachmentSource(baseURL: URL(string: "https://\(pairedHost):8443/api/v1")!))

        let url = try XCTUnwrap(source.url(for: attachmentId).success)

        XCTAssertTrue(url.absoluteString.hasPrefix("https://\(pairedHost):8443/api/v1/"), url.absoluteString)
    }

    func testShouldTolerateATrailingSlashOnThePairedBaseURL() throws {
        let source = try XCTUnwrap(AttachmentSource(baseURL: URL(string: "https://\(pairedHost)/api/v1/")!))

        let url = try XCTUnwrap(source.url(for: attachmentId).success)

        XCTAssertEqual(
            url.absoluteString,
            "https://\(pairedHost)/api/v1/attachments/\(attachmentId)",
            "one base path, not two, and no doubled slash"
        )
    }

    // MARK: - What it refuses

    /// **The one a prefix match lets through**, and a prefix match is what somebody
    /// writes first because `hasPrefix` reads like the obvious answer.
    func testShouldRefuseAHostThatMerelyBeginsWithThePairedHost() {
        XCTAssertEqual(
            source.verify(URL(string: "https://\(pairedHost).evil.com/api/v1/attachments/x")!).refusal,
            .differentOrigin
        )
    }

    /// The one a suffix match lets through.
    func testShouldRefuseASubdomainOfThePairedHost() {
        XCTAssertEqual(
            source.verify(URL(string: "https://admin.\(pairedHost)/api/v1/attachments/x")!).refusal,
            .differentOrigin
        )
    }

    /// The one a match on the URL *string* lets through: everything before the `@` is
    /// userinfo, and the authority host is `evil.com`.
    func testShouldRefuseAUserinfoTrickThatSpellsThePairedHostBeforeTheAt() {
        let url = URL(string: "https://\(pairedHost)@evil.com/api/v1/attachments/x")!

        XCTAssertEqual(url.host(), "evil.com", "which is the whole trick")
        XCTAssertEqual(source.verify(url).refusal, .differentOrigin)
    }

    /// The right host, the wrong port. A different port is a different security
    /// principal, and these fetches carry a live bearer token.
    func testShouldRefuseTheRightHostOnADifferentPort() {
        XCTAssertEqual(
            source.verify(URL(string: "https://\(pairedHost):8443/api/v1/attachments/x")!).refusal,
            .differentOrigin
        )
    }

    /// The right host, in cleartext. Downgrading publishes the token to every hop.
    func testShouldRefuseASchemeDowngradeToCleartext() {
        XCTAssertEqual(
            source.verify(URL(string: "http://\(pairedHost)/api/v1/attachments/x")!).refusal,
            .differentOrigin
        )
    }

    func testShouldRefuseAnythingThatIsNotAWebOriginAtAll() {
        for candidate in [
            "javascript:alert(1)",
            "data:image/png;base64,iVBORw0KGgo=",
            "file:///etc/passwd",
            "about:blank",
            "syl://\(pairedHost)/attachments/x",
        ] {
            let url = URL(string: candidate)!
            XCTAssertEqual(
                source.verify(url).refusal,
                .notAWebOrigin,
                "\(candidate) is not a web origin and must not be fetched"
            )
        }
    }

    /// An id is a path segment, so an id with a path in it walks out of `/attachments/`.
    /// Refused before it can become one.
    func testShouldRefuseAnAttachmentIdentifierThatIsNotOfTheShapeTheServiceMints() {
        for bad: SylID in [
            "../../logs",
            "syl:attachment:../../logs",
            "syl:attachment:",
            "attachment:019feb2f-e654-7000-ac0e-3f825d6a318c",
            "",
        ] {
            XCTAssertEqual(
                source.url(for: bad).refusal,
                .malformedIdentifier,
                "\(bad) must never reach a path"
            )
        }
    }

    func testShouldRefuseToExistAtAllWhenTheBaseURLIsNotAWebOrigin() {
        // No fallback. A source that could not determine an origin would have to allow
        // everything, and that is the state this type exists to make unrepresentable.
        XCTAssertNil(AttachmentSource(baseURL: URL(string: "file:///var/tmp")!))
        XCTAssertNil(AttachmentSource(baseURL: URL(string: "syl:attachment:x")!))
    }

    // MARK: - Equivalences that are NOT attacks

    func testShouldTreatAWrittenOutDefaultPortAsTheSameOrigin() {
        XCTAssertNotNil(source.verify(URL(string: "https://\(pairedHost):443/api/v1/attachments/x")!).success)
    }

    func testShouldTreatHostCaseAsIrrelevantBecauseDNSDoes() {
        XCTAssertNotNil(source.verify(URL(string: "https://\(pairedHost.uppercased())/api/v1/attachments/x")!).success)
    }
}

// MARK: - The loader

final class AttachmentLoaderTests: XCTestCase {
    private let pairedHost = "reason-2.tail714e0e.ts.net"
    private lazy var source = AttachmentSource(baseURL: URL(string: "https://\(pairedHost)/api/v1")!)!

    override func setUp() {
        super.setUp()
        // The cache is process-wide, so without this a case passes because an earlier
        // one already fetched.
        AttachmentLoader.clearCacheForTesting()
    }

    override func tearDown() {
        AttachmentLoader.clearCacheForTesting()
        super.tearDown()
    }

    @MainActor
    func testShouldFetchAndPublishTheBytes() async {
        let fetcher = RecordingFetcher(result: .success(Data([1, 2, 3])))
        let loader = AttachmentLoader(source: source, fetcher: fetcher)

        await loader.load(image())

        XCTAssertEqual(loader.state, .loaded(Data([1, 2, 3])))
    }

    /// **T035.** The picture is here; the tailnet is not. That must render.
    @MainActor
    func testShouldRenderACachedAttachmentWithTheTailnetDown() async {
        AttachmentLoader.prime(attachmentId: image().id, data: Data([9, 9]))
        let fetcher = RecordingFetcher(result: .failure(.offline))
        let loader = AttachmentLoader(source: source, fetcher: fetcher)

        await loader.load(image())

        let calls = await fetcher.calls
        XCTAssertEqual(loader.state, .loaded(Data([9, 9])))
        XCTAssertEqual(calls, 0, "a cached attachment must not touch the network at all")
    }

    /// **T035, the other half.** An un-cached attachment with no route says so. It must
    /// never sit in `loading`, because a spinner that never resolves is a lie told
    /// slowly.
    @MainActor
    func testShouldSayAnUncachedAttachmentIsNotDownloadedRatherThanSpinForever() async {
        let loader = AttachmentLoader(source: source, fetcher: RecordingFetcher(result: .failure(.offline)))

        await loader.load(image())

        XCTAssertEqual(loader.state, .unavailable(.offline))
        XCTAssertNotEqual(loader.state, .loading)
        XCTAssertEqual(AttachmentUnavailable.offline.summary, "Not downloaded")
    }

    /// A server that refuses is not the same as a server that cannot be reached, and
    /// collapsing the two would make a real fault look like a train tunnel.
    @MainActor
    func testShouldReportAServerRefusalSeparatelyFromBeingOffline() async {
        let loader = AttachmentLoader(
            source: source,
            fetcher: RecordingFetcher(result: .failure(.http(status: 404, message: "No such attachment.")))
        )

        await loader.load(image())

        XCTAssertEqual(loader.state, .unavailable(.failed("No such attachment.")))
    }

    /// The optimistic send's whole point: bytes already on the device render with no
    /// round trip.
    @MainActor
    func testShouldServePrimedBytesWithoutEverAskingTheServer() async {
        let attachment = image()
        AttachmentLoader.prime(attachmentId: attachment.id, data: Data([7]))
        let fetcher = RecordingFetcher(result: .success(Data([0])))
        let loader = AttachmentLoader(source: source, fetcher: fetcher)

        await loader.load(attachment)

        let calls = await fetcher.calls
        XCTAssertEqual(loader.state, .loaded(Data([7])))
        XCTAssertEqual(calls, 0)
    }

    /// **The guard has to stop a request, not merely return a `Result`.**
    @MainActor
    func testShouldNeverIssueARequestForAnAttachmentItCannotComposeAnOriginFor() async {
        let fetcher = RecordingFetcher(result: .success(Data([1])))
        let loader = AttachmentLoader(source: nil, fetcher: fetcher)

        await loader.load(image())

        let calls = await fetcher.calls
        XCTAssertEqual(loader.state, .unavailable(.refused(.notAWebOrigin)))
        XCTAssertEqual(calls, 0, "no server means no fetch, not a fetch to a guess")
    }

    @MainActor
    func testShouldNeverIssueARequestForAMalformedAttachmentIdentifier() async {
        let fetcher = RecordingFetcher(result: .success(Data([1])))
        let loader = AttachmentLoader(source: source, fetcher: fetcher)

        await loader.load(image(id: "../../logs"))

        let calls = await fetcher.calls
        XCTAssertEqual(loader.state, .unavailable(.refused(.malformedIdentifier)))
        XCTAssertEqual(calls, 0)
    }

    /// `hasThumbnail` is read rather than probed. Asking for one that does not exist is
    /// a 404, and a 404 would render as a broken picture.
    @MainActor
    func testShouldAskForTheOriginalWhenTheServiceReportsNoThumbnail() async {
        let fetcher = RecordingFetcher(result: .success(Data([1])))
        let loader = AttachmentLoader(source: source, fetcher: fetcher)

        await loader.load(image(hasThumbnail: false), variant: .thumb)

        let requested = await fetcher.lastURL
        XCTAssertNil(requested?.query, "no variant parameter: the thumbnail does not exist")
    }

    @MainActor
    func testShouldAskForTheThumbnailWhenThereIsOne() async {
        let fetcher = RecordingFetcher(result: .success(Data([1])))
        let loader = AttachmentLoader(source: source, fetcher: fetcher)

        await loader.load(image(hasThumbnail: true), variant: .thumb)

        let requested = await fetcher.lastURL
        XCTAssertEqual(requested?.query, "variant=thumb")
    }

    /// A thumbnail and an original are different bytes for the same row. Keying on the
    /// id alone would serve a 160-pixel preview to the full-screen viewer.
    @MainActor
    func testShouldNotServeAThumbnailWhereTheOriginalWasAskedFor() async {
        let attachment = image(hasThumbnail: true)
        AttachmentLoader.prime(attachmentId: attachment.id, data: Data([1]), variant: .thumb)
        let fetcher = RecordingFetcher(result: .success(Data([2, 2, 2])))
        let loader = AttachmentLoader(source: source, fetcher: fetcher)

        await loader.load(attachment, variant: .original)

        let calls = await fetcher.calls
        XCTAssertEqual(loader.state, .loaded(Data([2, 2, 2])))
        XCTAssertEqual(calls, 1)
    }

    func testShouldCapTheProcessWideCacheSoALongSessionCannotGrowUnbounded() {
        XCTAssertEqual(AttachmentLoader.costLimit, 32 * 1024 * 1024)
    }

    /// The synchronous read a cell uses to paint the right thing on its very first
    /// frame. Without it a row scrolling back on screen flashes an empty plate on its
    /// way to the picture it already had in memory.
    func testShouldOfferWhicheverBytesAreHeldWithAThumbnailPreferred() {
        let attachment = image(hasThumbnail: true)

        XCTAssertNil(AttachmentLoader.cachedBytes(for: attachment))

        AttachmentLoader.prime(attachmentId: attachment.id, data: Data([1]), variant: .original)
        XCTAssertEqual(AttachmentLoader.cachedBytes(for: attachment), Data([1]), "the original will do")

        AttachmentLoader.prime(attachmentId: attachment.id, data: Data([2]), variant: .thumb)
        XCTAssertEqual(
            AttachmentLoader.cachedBytes(for: attachment),
            Data([2]),
            "but a thumbnail is what an inline cell wants"
        )
    }

    /// The label on a video cell, which is the only thing on it that is computed —
    /// and, because no poster frame exists, one of only two things on it at all.
    func testShouldRenderAVideosDurationAsMinutesAndSeconds() {
        XCTAssertEqual(AttachmentPlaceholder.durationLabel(for: video(durationMs: 42_000)), "0:42")
        XCTAssertEqual(AttachmentPlaceholder.durationLabel(for: video(durationMs: 605_000)), "10:05")
        XCTAssertEqual(
            AttachmentPlaceholder.durationLabel(for: video(durationMs: nil)),
            "Video",
            "an unknown duration says what it is rather than claiming 0:00"
        )
    }

    private func video(durationMs: Int?) -> Attachment {
        Attachment(
            id: "syl:attachment:019feb2f-e654-7000-ac0e-3f825d6a3190",
            kind: .video,
            mimeType: "video/mp4",
            bytes: 1,
            width: 1920,
            height: 1080,
            durationMs: durationMs,
            sha256: String(repeating: "e", count: 64),
            createdAt: Date(timeIntervalSince1970: 0),
            hasThumbnail: false
        )
    }

    // MARK: Helpers

    private func image(
        id: SylID = "syl:attachment:019feb2f-e654-7000-ac0e-3f825d6a318c",
        hasThumbnail: Bool = false
    ) -> Attachment {
        Attachment(
            id: id,
            kind: .image,
            mimeType: "image/png",
            bytes: 144_559,
            width: 1600,
            height: 1200,
            durationMs: nil,
            sha256: String(repeating: "b", count: 64),
            createdAt: Date(timeIntervalSince1970: 0),
            hasThumbnail: hasThumbnail
        )
    }
}

/// Counts what it was asked for, so a test can assert that a request did *not* happen —
/// which is the only interesting assertion about a security guard.
private actor RecordingFetcher: AttachmentFetching {
    private let result: Result<Data, AttachmentFetchError>
    private(set) var calls = 0
    private(set) var lastURL: URL?

    init(result: Result<Data, AttachmentFetchError>) {
        self.result = result
    }

    func data(from url: URL) async throws -> Data {
        calls += 1
        lastURL = url
        return try result.get()
    }
}

// MARK: - Staging

final class StagedAttachmentTests: XCTestCase {
    func testShouldMintALocalIdentifierOfTheShapeEverythingDownstreamChecks() {
        // A sentinel would have to be special-cased by every layer between the picker
        // and the cell, and the layer that forgot would render a broken picture.
        XCTAssertTrue(SylIDs.isWellFormed(StagedAttachment.mintLocalIdentifier()))
    }

    func testShouldReserveTheSameBoxLocallyAsTheServerWillReport() {
        let staged = StagedAttachment(
            kind: .image,
            mimeType: "image/png",
            data: Data(repeating: 0, count: 1234),
            width: 1600,
            height: 1200
        )

        XCTAssertEqual(staged.localAttachment.width, 1600)
        XCTAssertEqual(staged.localAttachment.height, 1200)
        XCTAssertEqual(staged.localAttachment.bytes, 1234)
        XCTAssertFalse(
            staged.localAttachment.hasThumbnail,
            "there is no thumbnail on this device, and the bytes are already in memory"
        )
    }

    /// The server reads an image's dimensions out of its own header and refuses to be
    /// told; a video's it cannot read at all and requires.
    func testShouldSendDimensionsForAVideoAndNotForAnImage() {
        let picture = StagedAttachment(
            kind: .image,
            mimeType: "image/png",
            data: Data([1]),
            width: 10,
            height: 10
        )
        let clip = StagedAttachment(
            kind: .video,
            mimeType: "video/mp4",
            data: Data([1]),
            width: 1920,
            height: 1080,
            durationMs: 4200
        )

        XCTAssertNil(picture.request.width)
        XCTAssertNil(picture.request.height)
        XCTAssertNil(picture.request.durationMs)

        XCTAssertEqual(clip.request.width, 1920)
        XCTAssertEqual(clip.request.height, 1080)
        XCTAssertEqual(clip.request.durationMs, 4200)
    }
}

// MARK: - The send path (T036, D7)

/// **Disk first, for bytes too.**
///
/// The ordering is the whole subject. Uploading before writing would hand back a real
/// server id and save a second write, which is exactly why somebody will try it — and a
/// crash in that window loses the bubble, the words and the picture at once, with no
/// evidence anything was ever sent.
final class AttachmentSendTests: XCTestCase {
    private var database: SylDatabase!
    private var store: LocalStore!
    private var outbox: Outbox!

    override func setUpWithError() throws {
        try super.setUpWithError()
        database = try SylDatabase.inMemory()
        store = LocalStore(database: database)
        outbox = Outbox(database: database)
        AttachmentLoader.clearCacheForTesting()
    }

    override func tearDown() {
        AttachmentLoader.clearCacheForTesting()
        outbox = nil
        store = nil
        database = nil
        super.tearDown()
    }

    @MainActor
    func testShouldWriteTheBubbleToDiskBeforeUploadingASingleByte() async throws {
        let staged = staging()
        let store = self.store!
        let observed = Observation()

        let model = makeModel(upload: { _, _ in
            // Inside the upload, the row must already be there. This is the assertion
            // that the ordering is real rather than merely intended.
            let pending = (try? store.pendingMessages()) ?? []
            await observed.record(
                messages: pending.count,
                attachments: pending.first?.attachments.count ?? 0
            )
            throw AttachmentFetchError.offline
        })
        model.draft = "Here is the shelf, after."

        await model.send(staging: [staged])

        let messages = await observed.messages
        let attachments = await observed.attachments
        XCTAssertEqual(messages, 1, "the bubble exists before anything is uploaded")
        XCTAssertEqual(attachments, 1, "and it already carries its picture")
    }

    @MainActor
    func testShouldRenderTheJustSentPictureWithNoRoundTrip() async throws {
        let staged = staging()
        let model = makeModel(upload: { _, _ in throw AttachmentFetchError.offline })
        model.draft = "Here is the shelf, after."

        await model.send(staging: [staged])

        XCTAssertEqual(
            AttachmentLoader.cached(attachmentId: staged.id),
            staged.data,
            "the picture he just chose must not be fetched back from the machine he sent it to"
        )
    }

    /// An upload that does not land must lose nothing and send nothing.
    ///
    /// Both halves matter. Sending the message anyway would deliver the words without
    /// the picture — a silent drop in a different costume — and sending it *with* the
    /// local ids would be `VALIDATION_FAILED` forever.
    @MainActor
    func testShouldParkTheSendRatherThanDeliverAMessageWhosePictureDoesNotExistYet() async throws {
        let sent = Flag()
        let model = makeModel(
            upload: { _, _ in throw AttachmentFetchError.offline },
            sendOverSocket: { _, _, _ in await sent.raise() }
        )
        model.draft = "Here is the shelf, after."

        await model.send(staging: [staging()])

        let didSend = await sent.value
        XCTAssertFalse(didSend, "nothing goes out until the bytes are up")
        XCTAssertEqual(try store.pendingMessages().count, 1, "the bubble stays")
        XCTAssertTrue(try outbox.pending().isEmpty, "and the flush cannot pick it up")

        let parked = try outbox.blocked()
        XCTAssertEqual(parked.count, 1, "neither retried nor discarded — waiting, visibly")
        XCTAssertEqual(parked.first?.blockedReason, LocalStore.awaitingAttachmentUpload)
        XCTAssertNotNil(model.notice, "and he is told, rather than left to guess")
    }

    @MainActor
    func testShouldSwapInTheServersIdsAndReleaseTheSendOnceTheUploadLands() async throws {
        let staged = staging()
        let serverId: SylID = "syl:attachment:019feb2f-e654-7000-ac0e-3f825d6a318c"
        let model = makeModel(upload: { _, _ in Self.uploaded(id: serverId) })
        model.draft = "Here is the shelf, after."

        await model.send(staging: [staged])

        let stored = try XCTUnwrap(try store.pendingMessages().first)
        XCTAssertEqual(stored.attachments.map(\.id), [serverId], "the local id is gone")

        let queued = try XCTUnwrap(try outbox.pending().first)
        XCTAssertNil(queued.blockedReason, "the send is released")
        let body = try queued.decodePayload(as: SendMessageRequest.self)
        XCTAssertEqual(body.attachmentIds, [serverId], "and it names the ids the server actually has")

        XCTAssertEqual(
            AttachmentLoader.cached(attachmentId: serverId),
            staged.data,
            "the same bytes, now reachable under the confirmed id, so nothing is downloaded twice"
        )
    }

    @MainActor
    func testShouldLeaveATextOnlySendExactlyAsItWas() async throws {
        let model = makeModel(upload: { _, _ in XCTFail("no attachments, no upload"); throw AttachmentFetchError.offline })
        model.draft = "No picture here."

        await model.send()

        let queued = try XCTUnwrap(try outbox.pending().first)
        XCTAssertNil(queued.blockedReason, "a text-only send is never parked")
        let body = try queued.decodePayload(as: SendMessageRequest.self)
        XCTAssertNil(body.attachmentIds, "and the key does not appear at all")
    }

    // MARK: Harness

    @MainActor
    private func makeModel(
        upload: @escaping @Sendable (CreateAttachmentRequest, String) async throws -> Attachment,
        sendOverSocket: @escaping @Sendable (String, String, String) async throws -> Void = { _, _, _ in }
    ) -> ChatViewModel {
        ChatViewModel(
            store: store,
            sendOverSocket: sendOverSocket,
            uploadAttachment: upload,
            now: { try! Instant.parse("2026-08-09T06:59:48.220Z") }
        )
    }

    private func staging() -> StagedAttachment {
        StagedAttachment(
            kind: .image,
            mimeType: "image/png",
            data: Data([0x89, 0x50, 0x4E, 0x47]),
            width: 1600,
            height: 1200
        )
    }

    private static func uploaded(id: SylID) -> Attachment {
        Attachment(
            id: id,
            kind: .image,
            mimeType: "image/png",
            bytes: 4,
            width: 1600,
            height: 1200,
            durationMs: nil,
            sha256: String(repeating: "c", count: 64),
            createdAt: Date(timeIntervalSince1970: 0),
            hasThumbnail: true
        )
    }

    private actor Flag {
        private(set) var value = false
        func raise() { value = true }
    }

    private actor Observation {
        private(set) var messages = 0
        private(set) var attachments = 0

        func record(messages: Int, attachments: Int) {
            self.messages = messages
            self.attachments = attachments
        }
    }
}

// MARK: - Files

final class AttachmentFileTests: XCTestCase {
    func testShouldMapEveryTypeTheServiceCanStoreToAnExtension() {
        XCTAssertEqual(AttachmentFile.fileExtension(for: "image/png"), "png")
        XCTAssertEqual(AttachmentFile.fileExtension(for: "image/jpeg"), "jpg")
        XCTAssertEqual(AttachmentFile.fileExtension(for: "IMAGE/JPEG"), "jpg")
        XCTAssertEqual(AttachmentFile.fileExtension(for: "video/quicktime"), "mov")
    }

    /// A closed map, not a derivation. Splitting a server-supplied MIME string on `/`
    /// and using the tail is how a temp filename ends up with a path in it.
    func testShouldFallBackToAnInertExtensionRatherThanDeriveOneFromTheString() {
        XCTAssertEqual(AttachmentFile.fileExtension(for: "image/../../etc/passwd"), "bin")
        XCTAssertEqual(AttachmentFile.fileExtension(for: "application/x-anything"), "bin")
    }
}

// MARK: - Result sugar

extension Result {
    fileprivate var success: Success? {
        if case .success(let value) = self { return value }
        return nil
    }

    fileprivate var refusal: Failure? {
        if case .failure(let error) = self { return error }
        return nil
    }
}
