import SylKit
import XCTest

@testable import Syl

/// Tapping plays her, with the poster as the still (`syl-015.4.8`, T017).
///
/// Two things are being protected here and they pull in opposite directions. The row has
/// to show **her face** rather than a generic video affordance — root acceptance item 5 —
/// and it has to do that without downloading the clip, which is what showing a still
/// naively costs: 8.4 MB over a tailnet, on cellular, per row.
@MainActor
final class FromSylPlaybackTests: XCTestCase {
    private let paired = URL(string: "https://reason-2.tail714e0e.ts.net/api/v1")!

    override func setUp() {
        super.setUp()
        AttachmentLoader.clearCacheForTesting()
    }

    // MARK: - The poster, not the clip

    /// The request the row actually makes. `?variant=thumb` is the poster; no variant at
    /// all is the whole mp4.
    func testShouldAskForThePosterVariantRatherThanTheOriginal() async throws {
        let poster = SendingFixtures.video(hasThumbnail: true)
        let fetcher = RecordingFetcher()
        let loader = AttachmentLoader(source: AttachmentSource(baseURL: paired), fetcher: fetcher)

        await loader.load(poster, variant: .thumb)

        let urls = await fetcher.urls
        let asked = try XCTUnwrap(urls.first)
        XCTAssertTrue(asked.query?.contains("variant=thumb") == true, "asked for \(asked)")
        XCTAssertTrue(asked.path.contains(SylIDs.canonical(poster.id)))
    }

    /// **The trap this whole design is built around.** `AttachmentLoader` falls back to
    /// the original when an attachment reports no thumbnail — correct for a chat picture,
    /// ruinous for a clip — so the row must never hand it one. The projection is where
    /// that is decided, and this is the assertion that keeps it decided.
    func testShouldOfferNoStillAtAllForAClipThatHasNoPoster() {
        let posterless = SendingFixtures.video(hasThumbnail: false)
        let sending = SendingFixtures.sending(suffix: "f001", state: .ready, video: posterless)

        let row = project([sending]).rows.first

        XCTAssertNil(row?.still, "a still here would be the entire clip, fetched to draw a frame")
        XCTAssertNotNil(row?.video, "and it is still playable — only the still is refused")
    }

    /// The ordinary case, and the one the backend guarantees: a sending's video carries a
    /// poster, which is the single exception to `hasThumbnail` being false on every video
    /// in the contract.
    func testShouldDrawTheStillFromTheVideosOwnPoster() {
        let sending = SendingFixtures.sending(
            suffix: "f002", state: .ready, video: SendingFixtures.video(hasThumbnail: true))

        let row = project([sending]).rows.first

        XCTAssertEqual(row?.still?.id, row?.video?.id)
        XCTAssertEqual(row?.still?.hasThumbnail, true)
    }

    /// A sending with no video at all offers nothing to play and nothing to draw — and
    /// says why in words instead. Never a play glyph over nothing.
    func testShouldOfferNothingToPlayOnASendingWithNoVideo() {
        let rows = project([
            SendingFixtures.sending(suffix: "f003", state: .pending),
            SendingFixtures.sending(
                suffix: "f004", state: .failed, reason: SendingFixtures.failureReason),
        ]).rows

        for row in rows {
            XCTAssertNil(row.video)
            XCTAssertNil(row.still)
            XCTAssertFalse(row.isPlayable)
            XCTAssertNotNil(row.note, "the row says which of the two it is")
        }
    }

    // MARK: - The context the bytes need

    /// **Without a context in the subtree the bytes silently never load**, and this is
    /// what that failure looks like: not a spinner, not an error he could act on, but the
    /// word *Blocked* on every row — a security-shaped message for a plumbing mistake.
    ///
    /// It is why the app applies `\.attachmentContext` at the `TabView` root rather than
    /// on the one tab that happened to need it first.
    func testShouldRefuseEveryFetchWhenNoContextWasApplied() async {
        let loader = AttachmentLoader(source: nil, fetcher: RecordingFetcher())
        loader.adopt(.unwired)

        await loader.load(SendingFixtures.video())

        XCTAssertEqual(loader.state, .unavailable(.refused(.notAWebOrigin)))
    }

    /// And what the app hands it instead: a real origin, composed from the paired server
    /// rather than from anything the attachment carried — `Attachment` has no URL on it,
    /// on purpose.
    func testShouldBuildAUsableAttachmentContextFromThePairedServer() {
        let context = AppDelegate(tokens: InMemoryTokenStore()).attachmentContext

        XCTAssertNotNil(context.source, "an unwired context is what makes every row say Blocked")
    }

    // MARK: - Helpers

    private func project(_ sendings: [Sending]) -> SendingListSnapshot {
        SendingListSnapshot.project(
            sendings,
            now: SendingFixtures.instant("2026-08-11T14:00:00.000Z"),
            timeZone: TimeZone(identifier: "America/Chicago") ?? .gmt,
            locale: Locale(identifier: "en_GB"))
    }
}

/// Records every URL asked for, and answers with bytes that are not an image — enough
/// for the loader's state machine, and nothing this suite needs to decode.
private actor RecordingFetcher: AttachmentFetching {
    private(set) var urls: [URL] = []

    func data(from url: URL) async throws -> Data {
        urls.append(url)
        return Data([0x00, 0x01])
    }
}
