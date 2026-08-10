import AVFoundation
import AVKit
import SwiftUI
import SylKit

// MARK: - Wiring

/// Everything a bubble needs in order to fetch a picture: which server is the paired
/// one, and how to talk to it with a credential.
///
/// Carried in the environment rather than threaded through `ChatSnapshot`, because it is
/// a property of *this installation* and not of the conversation. It also has to survive
/// a re-pairing without anything re-rendering the transcript from disk.
struct AttachmentContext {
    /// Nil when the app is not usefully paired. The cells then say "Blocked" rather than
    /// spinning, which is the honest reading of "we have no server to ask".
    var source: AttachmentSource?
    var fetcher: any AttachmentFetching

    @MainActor
    func makeLoader() -> AttachmentLoader {
        AttachmentLoader(source: source, fetcher: fetcher)
    }

    /// The default: no server and a fetcher that always reports itself unreachable.
    ///
    /// Previews, the offscreen render harness and any test that has not wired a context
    /// get this. It degrades to an honest placeholder — never to a spinner, and never to
    /// a crash.
    static let unwired = AttachmentContext(source: nil, fetcher: UnreachableFetcher())
}

private struct UnreachableFetcher: AttachmentFetching {
    func data(from url: URL) async throws -> Data { throw AttachmentFetchError.offline }
}

private struct AttachmentContextKey: EnvironmentKey {
    static let defaultValue = AttachmentContext.unwired
}

extension EnvironmentValues {
    var attachmentContext: AttachmentContext {
        get { self[AttachmentContextKey.self] }
        set { self[AttachmentContextKey.self] = newValue }
    }
}

// MARK: - The strip

/// Everything one message carried, under its words.
///
/// A vertical stack rather than a grid. A grid looks better with exactly four images and
/// worse with one, two, three or five, and every attachment here has a *known* aspect
/// ratio that a grid would have to override — which is the layout jump T032 exists to
/// prevent, reintroduced for symmetry's sake.
struct AttachmentStrip: View {
    let attachments: [Attachment]

    var body: some View {
        if !attachments.isEmpty {
            VStack(alignment: .leading, spacing: SylTheme.Metric.snug) {
                ForEach(attachments) { attachment in
                    AttachmentView(attachment: attachment)
                }
            }
        }
    }
}

// MARK: - The inline cell

/// One attachment, inline in a turn.
///
/// ## No layout jump (T032)
///
/// **The box is reserved from the contract, before a single byte is fetched.**
/// `Attachment` carries `width` and `height` for exactly this — the openapi note on
/// `width` says so in as many words — so the cell's height is a function of the
/// available width and a number that arrived with the message. Nothing about it changes
/// when the image loads: the picture appears *inside* a frame that was already the right
/// shape.
///
/// This is the difference between a transcript that settles and one that shudders. The
/// naive version sizes itself from the decoded image, so every arriving thumbnail
/// reflows everything below it, and on a scrolled-back transcript the content jumps
/// under the reader's thumb.
///
/// ## The height cap, and what it costs
///
/// A 9:16 screenshot at full measure is taller than the phone, and a transcript where
/// one picture is a whole page of scrolling is worse than one that crops. So the
/// *reserved ratio* is clamped, and an image taller than the clamp is centre-cropped
/// inline and shown whole in the viewer. The crop is a deliberate, stated cost; a
/// pillarboxed letterbox with grey bars would be a worse one.
struct AttachmentView: View {
    let attachment: Attachment

    @Environment(\.attachmentContext) private var context
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @StateObject private var loader = AttachmentLoader(source: nil, fetcher: UnreachableFetcher())
    @State private var isViewing = false

    /// Never taller than one and a half times its width.
    ///
    /// Applied to the *reserved* ratio only. The attachment's own ratio is untouched, so
    /// the viewer still shows the whole picture.
    private static let tallestReservedRatio: Double = 2.0 / 3.0

    private var reservedRatio: Double {
        max(attachment.aspectRatio, Self.tallestReservedRatio)
    }

    var body: some View {
        Button {
            isViewing = true
        } label: {
            Color.clear
                // The whole point. The frame comes from the contract, not from the
                // bytes, so it is correct on the first frame and never changes.
                .aspectRatio(reservedRatio, contentMode: .fit)
                .frame(minHeight: SylTheme.Metric.minimumTouchTarget)
                .overlay { content }
                // The box does not move, so this is the only motion here: the plate
                // resolving into the picture. Settled rather than sprung, and off
                // entirely under Reduce Motion, where the swap is simply instant.
                .animation(
                    reduceMotion ? nil : SylTheme.Motion.settle,
                    value: displayState.data != nil
                )
                .clipShape(RoundedRectangle(cornerRadius: SylTheme.Metric.codeRadius, style: .continuous))
                .overlay {
                    // A hairline, so a picture with a pale edge does not bleed into the
                    // veil. The same hairline as everything else on this screen.
                    RoundedRectangle(cornerRadius: SylTheme.Metric.codeRadius, style: .continuous)
                        .strokeBorder(SylTheme.Colour.hairline, lineWidth: SylTheme.Metric.hair)
                }
        }
        .buttonStyle(.plain)
        // Its own element, deliberately NOT folded into the turn's combined label.
        // `ChatTurn` combines its prose into one sentence so a reply reads as a reply;
        // an attachment inside that sentence would be an unreachable noun. As a sibling
        // it is one focusable thing that says what it is and can be opened.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityHint(isOpenable ? "Opens full screen" : "")
        .accessibilityAddTraits(isOpenable ? [.isButton, .isImage] : [.isImage])
        .task(id: attachment.id) {
            // Adopted here rather than in an `onAppear`, and the difference is a bug.
            //
            // A `@StateObject` is constructed before the environment is readable, so the
            // loader starts with no server and has to be given one. Doing that in
            // `onAppear` looks equivalent and is not: SwiftUI does not order `onAppear`
            // against `task`, so on the runs where the task went first the loader had no
            // source and reported the attachment *refused* — a security-shaped message
            // for a plumbing mistake, intermittently, which is the worst possible way for
            // that word to appear on screen.
            loader.adopt(context)

            // `thumb` for the inline cell. Adjutant downloads the full file and renders
            // it at 160 points, so a 4 MB screenshot costs 4 MB to show a thumbnail —
            // over a tailnet on cellular that is the difference between instant and not.
            // `AttachmentLoader` falls back to `.original` on its own when the service
            // reports no thumbnail, rather than asking for one and getting a 404.
            await loader.load(attachment, variant: .thumb)
        }
        .fullScreenCover(isPresented: $isViewing) {
            AttachmentViewer(attachment: attachment)
        }
    }

    private var isOpenable: Bool {
        displayState.data != nil || attachment.kind == .video
    }

    /// What to draw, which is the loader's state **plus whatever is already cached**.
    ///
    /// The loader starts `idle` and only leaves it once `.task` has run, so a cell whose
    /// bytes are already in memory would otherwise paint an empty plate for a frame
    /// before flipping to the picture. On a `LazyVStack` that is a visible flicker every
    /// time a row scrolls back on screen, and it is entirely avoidable: `NSCache` is a
    /// synchronous read.
    ///
    /// It is also what makes this cell renderable offscreen at all. `ImageRenderer` runs
    /// no `task` and no `onAppear`, so before this the design harness could only ever
    /// photograph the empty state — which is exactly the state nobody needs to look at.
    private var displayState: AttachmentLoadState {
        if case .idle = loader.state, let cached = AttachmentLoader.cachedBytes(for: attachment) {
            return .loaded(cached)
        }
        return loader.state
    }

    @ViewBuilder
    private var content: some View {
        if case .loaded(let data) = displayState, attachment.kind == .image,
           let image = UIImage(data: data) {
            Image(uiImage: image)
                .resizable()
                // Fill, not fit. The box is already the right shape for anything inside
                // the clamp; past it, filling crops and fitting would leave bars, and
                // bars in a palette this quiet read as a rendering fault.
                .scaledToFill()
        } else {
            AttachmentPlaceholder(attachment: attachment, state: displayState)
        }
    }

    /// What VoiceOver says, in the order someone needs it: what it is, then whether it
    /// is here.
    private var accessibilityLabel: String {
        let noun = attachment.kind == .video
            ? "Video, \(AttachmentPlaceholder.durationLabel(for: attachment))"
            : "Photo"
        switch displayState {
        case .loaded: return noun
        case .idle, .loading: return "\(noun), loading"
        case .unavailable(let reason): return "\(noun). \(reason.detail)"
        }
    }
}

// MARK: - What a cell shows when it is not showing a picture

/// The plate: every state of an attachment that is not a rendered image.
///
/// Its own type for two reasons. It is a pure function of `(attachment, state)`, so it
/// can be put in front of a human in every state at once — which is the only way the
/// offline case ever gets looked at, because a design harness cannot make a network
/// fail. And it is where the two decisions the render harness forced now live:
///
/// **There is no spinner.** The box is already the right size and the wait is a
/// thumbnail's, so a `ProgressView` inside it was motion with nothing to say — and it
/// was the one piece of stock UIKit furniture on a screen that has none. A quiet glyph
/// says "a picture belongs here" without pretending to measure anything.
///
/// **Idle and loading look identical**, deliberately. They are indistinguishable to the
/// eye, and the distinction belongs to the loader rather than to the plate.
struct AttachmentPlaceholder: View {
    let attachment: Attachment
    let state: AttachmentLoadState

    var body: some View {
        ZStack {
            // Not `sylGlass`: this sits inside his glass object as often as on her bare
            // page, and glass on glass reads as a smudge. A card fill, plus the hairline
            // the cell already draws, works on both.
            SylTheme.Colour.card.opacity(0.35)
            marking
        }
    }

    @ViewBuilder
    private var marking: some View {
        switch state {
        case .unavailable(let reason):
            caption(glyph: glyph(for: reason), text: reason.summary)

        case .loaded where attachment.kind != .video:
            // Bytes that are not a picture: a truncated download, or a format this OS
            // cannot decode. Saying so beats an empty rectangle.
            caption(glyph: "exclamationmark.triangle", text: "Unavailable")

        default:
            if attachment.kind == .video {
                videoBody
            } else {
                Image(systemName: "photo")
                    .font(.system(size: 17, weight: .regular))
                    .foregroundStyle(SylTheme.Colour.inkSoft.opacity(0.55))
            }
        }
    }

    /// What a video looks like when there is no poster frame — which is **always**,
    /// today.
    ///
    /// `hasThumbnail` is false for every video by contract, and poster-frame generation
    /// is deferred (`syl-008.5.5`). So this is not a fallback that will rarely be seen:
    /// it *is* the video cell. It shows what is actually known — that this is a video,
    /// how long it runs, and that tapping plays it — rather than a black rectangle
    /// pretending to be a frame nobody extracted. The box is still exactly the right
    /// shape, because `width` and `height` came with the message.
    ///
    /// A downloaded video looks the same as one still on the Mac, and that is honest:
    /// decoding a frame would mean an `AVAssetImageGenerator` per cell on the main
    /// thread, and the difference is invisible to the eye and irrelevant to the tap.
    private var videoBody: some View {
        VStack(spacing: SylTheme.Metric.snug) {
            Image(systemName: "play.fill")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(SylTheme.Colour.luminanceCore)
                .frame(
                    width: SylTheme.Metric.minimumTouchTarget,
                    height: SylTheme.Metric.minimumTouchTarget
                )
                .background { Circle().fill(SylTheme.Colour.luminance.opacity(0.55)) }
            Text(Self.durationLabel(for: attachment))
                .font(SylTheme.Typeface.numeral)
                .foregroundStyle(SylTheme.Colour.inkSoft)
        }
    }

    private func caption(glyph: String, text: String) -> some View {
        VStack(spacing: SylTheme.Metric.tight) {
            Image(systemName: glyph)
                .font(.system(size: 15, weight: .regular))
                .foregroundStyle(SylTheme.Colour.inkSoft)
            Text(text)
                .sylLabelStyle()
                .foregroundStyle(SylTheme.Colour.inkSoft)
                .multilineTextAlignment(.center)
        }
        .padding(SylTheme.Metric.snug)
    }

    private func glyph(for reason: AttachmentUnavailable) -> String {
        switch reason {
        case .offline: return "icloud.slash"
        case .refused: return "hand.raised"
        case .failed: return "exclamationmark.triangle"
        }
    }

    /// `nonisolated`: it is arithmetic on a value, and pinning it to the main actor
    /// would make the one computed thing on a video cell untestable without a hop.
    nonisolated static func durationLabel(for attachment: Attachment) -> String {
        guard let milliseconds = attachment.durationMs, milliseconds > 0 else { return "Video" }
        let total = milliseconds / 1000
        return String(format: "%d:%02d", total / 60, total % 60)
    }
}

// MARK: - Full screen

/// The picture on its own: pinch to zoom, swipe to dismiss, share.
///
/// Presented as a `fullScreenCover` rather than pushed, because a photo viewer that
/// keeps a navigation bar and a tab bar is a photo viewer with a third of the photo
/// missing.
struct AttachmentViewer: View {
    let attachment: Attachment

    @Environment(\.attachmentContext) private var context
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @StateObject private var loader = AttachmentLoader(source: nil, fetcher: UnreachableFetcher())

    @State private var zoom: CGFloat = 1
    @State private var committedZoom: CGFloat = 1
    @State private var offset: CGSize = .zero
    /// Where the sheet has been dragged to. Doubles as the dismiss gesture's progress.
    @State private var dragged: CGSize = .zero
    @State private var shareURL: URL?
    @State private var player: AVPlayer?

    private static let maximumZoom: CGFloat = 6

    var body: some View {
        ZStack {
            // The veil, at full strength, so the viewer is still somewhere in this app
            // rather than a black modal borrowed from another one.
            SylTheme.Veil()
                .ignoresSafeArea()
                .opacity(1 - dismissProgress * 0.5)

            content
                .scaleEffect(zoom)
                .offset(x: offset.width + dragged.width, y: offset.height + dragged.height)
                .gesture(zoomGesture)
                .simultaneousGesture(dismissGesture)

            chrome
        }
        .task {
            loader.adopt(context)
            await loader.load(attachment, variant: .original)
        }
        .onDisappear {
            // Playback stops when the viewer does. An `AVPlayer` left running behind a
            // dismissed cover keeps decoding and keeps the audio route.
            player?.pause()
            player = nil
        }
    }

    @ViewBuilder
    private var content: some View {
        switch loader.state {
        case .loaded(let data) where attachment.kind == .image:
            if let image = UIImage(data: data) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .accessibilityLabel("Photo")
            } else {
                message(AttachmentUnavailable.failed("This device could not read the image.").detail)
            }

        case .loaded(let data) where attachment.kind == .video:
            videoContent(data)

        case .unavailable(let reason):
            message(reason.detail)

        case .idle, .loading, .loaded:
            if reduceMotion {
                message("Loading")
            } else {
                ProgressView().tint(SylTheme.Colour.luminance)
            }
        }
    }

    /// Video, and only on an explicit tap (T034).
    ///
    /// **Nothing autoplays.** The player is not even constructed until the play control
    /// is pressed, which is a stronger guarantee than `autoplay = false`: there is no
    /// object to start.
    @ViewBuilder
    private func videoContent(_ data: Data) -> some View {
        if let player {
            VideoPlayer(player: player)
                .aspectRatio(attachment.aspectRatio, contentMode: .fit)
                .accessibilityLabel("Video")
        } else {
            Button {
                start(data)
            } label: {
                VStack(spacing: SylTheme.Metric.step) {
                    Image(systemName: "play.fill")
                        .font(.system(size: 22, weight: .semibold))
                        .foregroundStyle(SylTheme.Colour.luminanceCore)
                        .frame(width: 72, height: 72)
                        .background { Circle().fill(SylTheme.Colour.luminance.opacity(0.55)) }
                    Text("Play")
                        .sylLabelStyle()
                        .foregroundStyle(SylTheme.Colour.inkSoft)
                }
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Play video")
        }
    }

    private func message(_ text: String) -> some View {
        Text(text)
            .font(SylTheme.Typeface.detail)
            .foregroundStyle(SylTheme.Colour.inkSoft)
            .multilineTextAlignment(.center)
            .padding(SylTheme.Metric.gutter)
            .frame(maxWidth: SylTheme.Metric.proseMeasure)
    }

    // MARK: Chrome

    private var chrome: some View {
        VStack {
            HStack(spacing: SylTheme.Metric.step) {
                control("xmark", label: "Close") { dismiss() }
                Spacer()
                if let shareURL {
                    ShareLink(item: shareURL) {
                        Image(systemName: "square.and.arrow.up")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(SylTheme.Colour.ink)
                            .frame(
                                width: SylTheme.Metric.minimumTouchTarget,
                                height: SylTheme.Metric.minimumTouchTarget
                            )
                            .sylGlass(radius: SylTheme.Metric.minimumTouchTarget / 2, presence: 0.7)
                    }
                    .accessibilityLabel("Share")
                }
            }
            .padding(.horizontal, SylTheme.Metric.gutter)
            Spacer()
        }
        .opacity(1 - dismissProgress)
        .onChange(of: loader.state) { _, state in
            // The share sheet needs a file, not bytes. Written once, when the bytes
            // arrive, rather than on every body evaluation.
            guard let data = state.data else { return shareURL = nil }
            shareURL = AttachmentFile.write(data, for: attachment)
        }
    }

    private func control(_ symbol: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(SylTheme.Colour.ink)
                .frame(
                    width: SylTheme.Metric.minimumTouchTarget,
                    height: SylTheme.Metric.minimumTouchTarget
                )
                .sylGlass(radius: SylTheme.Metric.minimumTouchTarget / 2, presence: 0.7)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    // MARK: Gestures

    private var zoomGesture: some Gesture {
        MagnifyGesture()
            .onChanged { value in
                zoom = min(max(committedZoom * value.magnification, 1), Self.maximumZoom)
            }
            .onEnded { _ in
                committedZoom = zoom
                if zoom <= 1 {
                    // Snapped back rather than left a hair off. A viewer that returns to
                    // 1.02 leaves the image imperceptibly soft and the dismiss gesture
                    // disabled, which reads as the sheet being stuck.
                    withAnimation(reduceMotion ? nil : SylTheme.Motion.responsive) {
                        zoom = 1
                        committedZoom = 1
                        offset = .zero
                    }
                }
            }
    }

    /// Swipe to dismiss — and only while the image is at rest.
    ///
    /// A zoomed image needs the drag for panning; taking it for dismissal is the single
    /// most common defect in hand-rolled photo viewers, because it makes a zoomed photo
    /// impossible to look around.
    private var dismissGesture: some Gesture {
        DragGesture()
            .onChanged { value in
                if zoom > 1 {
                    offset = CGSize(
                        width: offset.width + value.translation.width - dragged.width,
                        height: offset.height + value.translation.height - dragged.height
                    )
                    dragged = value.translation
                } else {
                    dragged = value.translation
                }
            }
            .onEnded { value in
                defer { dragged = .zero }
                guard zoom <= 1 else { return }
                if abs(value.translation.height) > 120 {
                    dismiss()
                }
            }
    }

    /// How far along the dismiss gesture is, `0...1`. Drives the fade so the gesture has
    /// something to answer rather than snapping at a threshold.
    private var dismissProgress: Double {
        guard zoom <= 1 else { return 0 }
        return min(Double(abs(dragged.height)) / 240, 1)
    }

    // MARK: Playback

    /// Build the player and start it. Called from the play control and nowhere else.
    private func start(_ data: Data) {
        guard let url = AttachmentFile.write(data, for: attachment) else { return }

        // **Never take the audio session.**
        //
        // Doing nothing is not the safe option here, and that is the trap. The app's
        // default category is `.soloAmbient`, which *interrupts* whatever the Commander
        // is listening to the instant an `AVPlayer` starts — so a video tapped in a
        // transcript would stop his music. `.ambient` with `.mixWithOthers` is the
        // category that yields, and it is set rather than activated: `setActive(true)`
        // is a claim, and `setActive(false)` hands the route to whoever the system picks
        // next, which is also a decision that is not ours to make.
        try? AVAudioSession.sharedInstance()
            .setCategory(.ambient, mode: .default, options: [.mixWithOthers])

        let player = AVPlayer(url: url)
        // Never hold the screen awake for something in a chat bubble. The home screen's
        // rule, unchanged.
        player.preventsDisplaySleepDuringVideoPlayback = false
        self.player = player
        player.play()
    }
}

// MARK: - Files

/// Bytes on disk, for the two things that need a URL rather than a `Data`: the share
/// sheet and `AVPlayer`.
enum AttachmentFile {
    /// A temp file named for the attachment, so opening the same video twice reuses one
    /// file instead of littering the container.
    static func write(_ data: Data, for attachment: Attachment) -> URL? {
        let name = attachment.sha256.prefix(16) + "." + fileExtension(for: attachment.mimeType)
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(String(name))
        if FileManager.default.fileExists(atPath: url.path) { return url }
        do {
            try data.write(to: url, options: .atomic)
            return url
        } catch {
            return nil
        }
    }

    /// A closed map, not a guess.
    ///
    /// `mimeType` on a stored attachment is the *sniffed* type, so the set is exactly
    /// what the service's own allowlist admits. An unknown type gets `bin`, which shares
    /// and plays badly — and that is better than deriving an extension from a
    /// server-supplied string, which is how a filename ends up with a path in it.
    static func fileExtension(for mimeType: String) -> String {
        switch mimeType.lowercased() {
        case "image/png": return "png"
        case "image/jpeg", "image/jpg": return "jpg"
        case "image/heic": return "heic"
        case "image/gif": return "gif"
        case "image/webp": return "webp"
        case "video/mp4": return "mp4"
        case "video/quicktime": return "mov"
        default: return "bin"
        }
    }
}
