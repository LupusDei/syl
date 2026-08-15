import SwiftUI
import SylKit

/// From Syl: the place her videos live.
///
/// ## One entry per sending, and deliberately not a grid
///
/// A grid of every render separates the picture from the reason, which is the one thing
/// that must not happen here. Her experiments live in her memory with what she thought of
/// them; a **sending** is the small number she chose to give him, and each one arrives
/// with what she wanted to say. So a row is her face, her words, and the date — in that
/// order of prominence — and the words are never subordinate to the picture.
///
/// ## The still is her face, never a play glyph
///
/// The row draws the video's **poster**, which the service pulls from part-way into the
/// clip rather than from frame zero, because her loops open on empty starfield and frame
/// zero is nothing at all. It is fetched as `?variant=thumb`: before the poster existed,
/// the inline video cell downloaded the whole clip to draw a play triangle — 8.4 MB over
/// a tailnet, on cellular, for a still.
///
/// ## A sending with no video is not an error
///
/// It is the state the backend guarantees: her words arrive whatever happens to the
/// render. A row without a video shows the words, the date, and one line in her voice
/// saying which of the two it is — still being made, or never coming. Those must not
/// look alike and neither may look like a fault.
struct FromSylListView: View {
    /// Nil until the first fetch answers. Renders as the bare veil, which is neither a
    /// spinner nor a false "she has never sent you anything".
    var snapshot: SendingListSnapshot?

    /// Set false only for offscreen rendering. `ImageRenderer` lays out nothing inside a
    /// `ScrollView`, exactly as `HomeView`, `ChatView` and `GoalListView` all record.
    var scrolls: Bool = true

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            SylTheme.Veil()
                .ignoresSafeArea()
            MoteField(count: 24, presence: 0.7)
                .ignoresSafeArea()
                .allowsHitTesting(false)

            if scrolls {
                ScrollView {
                    content
                }
                .scrollIndicators(.hidden)
            } else {
                VStack(spacing: 0) {
                    content
                    Spacer(minLength: 0)
                }
            }
        }
        .animation(reduceMotion ? nil : SylTheme.Motion.settle, value: snapshot)
        .navigationTitle("From Syl")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                // The serif, as on chat's bar and the goals list. A stock system title
                // here is the single most visible way a new screen announces that it
                // belongs to a different app from the rest of Syl.
                Text("From Syl")
                    .font(SylTheme.Typeface.title)
                    .foregroundStyle(SylTheme.Colour.ink)
                    .accessibilityAddTraits(.isHeader)
            }
        }
        .toolbarBackground(.hidden, for: .navigationBar)
    }

    @ViewBuilder
    private var content: some View {
        if let snapshot {
            if snapshot.isEmpty {
                empty
            } else {
                LazyVStack(alignment: .leading, spacing: SylTheme.Metric.loose) {
                    ForEach(snapshot.rows) { row in
                        SendingRow(snapshot: row)
                    }
                }
                .padding(.horizontal, SylTheme.Metric.gutter)
                .padding(.top, SylTheme.Metric.step)
                .padding(.bottom, SylTheme.Metric.chapter)
            }
        }
    }

    /// She has sent him nothing yet. The same voice as the clear day and the empty sky:
    /// a statement about the world rather than a report about the app.
    private var empty: some View {
        VStack(alignment: .leading, spacing: SylTheme.Metric.snug) {
            Text(SendingListSnapshot.emptyHeadline)
                .font(SylTheme.Typeface.title)
                .foregroundStyle(SylTheme.Colour.ink)

            Text(SendingListSnapshot.emptyExplanation)
                .font(SylTheme.Typeface.detail)
                .foregroundStyle(SylTheme.Colour.inkSoft)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, SylTheme.Metric.gutter)
        .padding(.vertical, SylTheme.Metric.chapter)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - A row

/// One sending: her face, her words, the date.
///
/// The still leads because it is her, and the words sit directly under it because they
/// are the point. Neither is a card — `sylGlass` composites `.ultraThinMaterial`, which
/// as a column of eight turns the whole screen into grey slabs, and `GoalListView`
/// already recorded that. Content on the bare veil, separated by air.
private struct SendingRow: View {
    let snapshot: SendingRowSnapshot

    @State private var isPlaying = false

    var body: some View {
        VStack(alignment: .leading, spacing: SylTheme.Metric.step) {
            still

            Text(snapshot.words)
                .font(SylTheme.Typeface.item)
                .foregroundStyle(SylTheme.Colour.ink)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)

            if let note = snapshot.note {
                // The honest line, and the reason the three states are distinguishable
                // at a glance. Not a badge and not a colour — a sentence.
                Text(note)
                    .font(SylTheme.Typeface.detail)
                    .foregroundStyle(SylTheme.Colour.inkSoft)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Text(snapshot.dateLine)
                .sylLabelStyle()
                .foregroundStyle(SylTheme.Colour.inkSoft)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(snapshot.accessibilityLabel)
        .accessibilityHint(snapshot.isPlayable ? "Plays this one" : "")
        .fullScreenCover(isPresented: $isPlaying) {
            if let video = snapshot.video {
                // The viewer chat already has: it fetches the original, plays on an
                // explicit tap and never takes the audio session.
                AttachmentViewer(attachment: video)
            }
        }
    }

    /// Her face, when there is one to draw.
    ///
    /// A row with no video draws **nothing at all here** rather than a plate with a play
    /// glyph on it: the affordance would promise something that cannot happen, and the
    /// words and the note below already say what is true.
    ///
    /// A clip that has no poster — which the service says does not happen for a sending,
    /// and which this refuses to trust — gets the plate instead. It does **not** get the
    /// original downloaded to produce a still.
    @ViewBuilder
    private var still: some View {
        if let video = snapshot.video {
            Button {
                isPlaying = true
            } label: {
                if let poster = snapshot.still {
                    SendingPoster(attachment: poster)
                } else {
                    SendingPosterless(attachment: video)
                }
            }
            .buttonStyle(.plain)
            .accessibilityHidden(true)
        }
    }
}

// MARK: - Her face

/// The poster frame, fetched as a thumbnail and never as the clip.
///
/// Its own view so the fetch and the frame live in one place, and so the loader gets a
/// `@StateObject` per row rather than one shared between them.
private struct SendingPoster: View {
    let attachment: Attachment

    @Environment(\.attachmentContext) private var context
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @StateObject private var loader = AttachmentLoader(source: nil, fetcher: NoFetcher())

    var body: some View {
        Color.clear
            // The box comes from the contract — `width` and `height` arrived with the
            // sending — so it is the right shape on the first frame and does not move
            // when the poster lands. Her clips are portrait; a row that resized itself
            // around each one would shudder down the whole list.
            .aspectRatio(attachment.aspectRatio, contentMode: .fit)
            .frame(maxHeight: 420)
            .overlay { content }
            .clipShape(
                RoundedRectangle(cornerRadius: SylTheme.Metric.cardRadius, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: SylTheme.Metric.cardRadius, style: .continuous)
                    .strokeBorder(SylTheme.Colour.hairline, lineWidth: SylTheme.Metric.hair)
            }
            .animation(reduceMotion ? nil : SylTheme.Motion.settle, value: displayState.data != nil)
            .task(id: attachment.id) {
                // Adopted in `task` rather than `onAppear`, and the difference is a bug
                // `AttachmentView` already paid for: SwiftUI does not order the two, so
                // on the runs where the task went first the loader had no source and
                // reported the attachment *refused* — a security-shaped word for a
                // plumbing mistake.
                loader.adopt(context)
                // `.thumb`, which on a sending's video is a poster the service really
                // has. This is the whole cost argument: the original is the clip.
                await loader.load(attachment, variant: .thumb)
            }
    }

    /// The loader's state plus whatever is already cached, so a row scrolling back on
    /// screen paints the poster on its first frame instead of flashing an empty plate.
    private var displayState: AttachmentLoadState {
        if case .idle = loader.state, let cached = AttachmentLoader.cachedBytes(for: attachment) {
            return .loaded(cached)
        }
        return loader.state
    }

    @ViewBuilder
    private var content: some View {
        if let data = displayState.data, let image = UIImage(data: data) {
            ZStack(alignment: .bottomTrailing) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()

                // Small, in the corner, over her face rather than instead of it. The
                // still is the subject; this only says the still moves.
                Image(systemName: "play.fill")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(SylTheme.Colour.luminanceCore)
                    .frame(width: 34, height: 34)
                    .background { Circle().fill(SylTheme.Colour.veilDeep.opacity(0.55)) }
                    .padding(SylTheme.Metric.step)
                    .allowsHitTesting(false)
            }
        } else {
            waiting
        }
    }

    /// The plate before the poster arrives, and when it cannot.
    ///
    /// No spinner: the box is already the right size and the wait is a thumbnail's, so a
    /// `ProgressView` would be motion with nothing to say — the same decision the chat
    /// cell records. Unreachable says so instead, because "not downloaded" is a true
    /// sentence and a permanent spinner is not.
    @ViewBuilder
    private var waiting: some View {
        ZStack {
            SylTheme.Colour.card.opacity(0.35)

            if case .unavailable(let reason) = displayState {
                VStack(spacing: SylTheme.Metric.tight) {
                    Image(systemName: glyph(for: reason))
                        .font(.system(size: 15, weight: .regular))
                        .foregroundStyle(SylTheme.Colour.inkSoft)
                    Text(reason.summary)
                        .sylLabelStyle()
                        .foregroundStyle(SylTheme.Colour.inkSoft)
                }
                .padding(SylTheme.Metric.snug)
            }
        }
    }

    private func glyph(for reason: AttachmentUnavailable) -> String {
        switch reason {
        case .offline: return "icloud.slash"
        case .refused: return "hand.raised"
        case .failed: return "exclamationmark.triangle"
        }
    }
}

/// A playable clip with no poster: the case the service says cannot happen.
///
/// It draws the box, the duration and a play control, and **fetches nothing at all**.
/// The tempting fallback — ask for the original and pull a frame out of it — is the
/// 8.4 MB the chat cell used to spend to draw a triangle, and it would be spent here on
/// every row, invisibly, over a tailnet.
private struct SendingPosterless: View {
    let attachment: Attachment

    var body: some View {
        Color.clear
            .aspectRatio(attachment.aspectRatio, contentMode: .fit)
            .frame(maxHeight: 420)
            .overlay {
                ZStack {
                    SylTheme.Colour.card.opacity(0.35)
                    VStack(spacing: SylTheme.Metric.snug) {
                        Image(systemName: "play.fill")
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundStyle(SylTheme.Colour.luminanceCore)
                            .frame(
                                width: SylTheme.Metric.minimumTouchTarget,
                                height: SylTheme.Metric.minimumTouchTarget)
                            .background { Circle().fill(SylTheme.Colour.luminance.opacity(0.55)) }
                        Text(AttachmentPlaceholder.durationLabel(for: attachment))
                            .font(SylTheme.Typeface.numeral)
                            .foregroundStyle(SylTheme.Colour.inkSoft)
                    }
                }
            }
            .clipShape(
                RoundedRectangle(cornerRadius: SylTheme.Metric.cardRadius, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: SylTheme.Metric.cardRadius, style: .continuous)
                    .strokeBorder(SylTheme.Colour.hairline, lineWidth: SylTheme.Metric.hair)
            }
    }
}

/// The loader's starting fetcher, before the environment is readable.
///
/// A `@StateObject` is constructed before `@Environment` can be read, so the real
/// fetcher is adopted in `task`. Starting from something that reports itself unreachable
/// means a view that never adopts a context says so rather than spinning.
private struct NoFetcher: AttachmentFetching {
    func data(from url: URL) async throws -> Data { throw AttachmentFetchError.offline }
}

// MARK: - Previews

#Preview("From Syl") {
    NavigationStack {
        FromSylListView(snapshot: SendingListSnapshot.preview)
    }
    .environment(\.colorScheme, .dark)
}

#Preview("Nothing yet") {
    NavigationStack {
        FromSylListView(snapshot: SendingListSnapshot())
    }
    .environment(\.colorScheme, .dark)
}

extension SendingListSnapshot {
    /// Preview data. Not test data — the tests build their own from real model types.
    static var preview: SendingListSnapshot {
        SendingListSnapshot(rows: [
            SendingRowSnapshot(
                words: "The light came through the window at exactly the angle you like, and I "
                    + "wanted you to see it.",
                because: "He said the winter here makes him forget the sky has colours.",
                dateLine: "Today",
                standing: .rendering,
                video: nil,
                still: nil,
                id: "syl:sending:0198e2c0-0000-7000-8000-00000000c001"
            ),
            SendingRowSnapshot(
                words: "Ela asked about you today, in the way she does when she has been "
                    + "thinking a while.",
                because: "He wanted to know when she brings him up unprompted.",
                dateLine: "Yesterday",
                standing: .failed,
                video: nil,
                still: nil,
                id: "syl:sending:0198e2c0-0000-7000-8000-00000000c003"
            ),
        ])
    }
}
