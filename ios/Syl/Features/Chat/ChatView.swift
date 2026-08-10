import SwiftUI
import SylKit

/// The conversation.
///
/// Renders from `ChatViewModel`, which renders from disk. There is no loading state on
/// the way in, deliberately: the first frame after launch shows his conversation, and
/// anything the network brings arrives on top of it.
///
/// ## What this screen is, after `syl-008`
///
/// A veil with her light running down the left margin of everything she says. It is the
/// home screen's composition — living backdrop, suspended particles, content sitting
/// *on* the atmosphere — applied to a transcript. Before this it was a competent generic
/// SwiftUI chat that shared not one symbol with the rest of the app.
struct ChatView: View {
    @ObservedObject var model: ChatViewModel
    @FocusState private var composerFocused: Bool

    /// Whether the newest turn is on screen. Drives whether an arriving message scrolls
    /// or merely announces itself.
    @State private var isAtBottom = true

    /// Set when a turn arrives while he is reading history.
    @State private var hasUnseenTurn = false

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Off for the offscreen render path.
    ///
    /// `ImageRenderer` lays out nothing inside a `ScrollView` — an offscreen host never
    /// gives the scroll view a content size, so it renders an empty page. `HomeView`
    /// carries the same switch for the same reason, and the first chat render came back
    /// as a blank frame exactly as its comment predicts.
    var scrolls: Bool = true

    /// The id of the sentinel at the foot of the transcript.
    private static let footAnchor = "transcript-foot"

    var body: some View {
        ZStack {
            // The same backdrop as home, and for the same reason: the thing that
            // separates "a nice gradient" from "somewhere that exists" is the light
            // moving and the air having something in it.
            SylTheme.Veil()
                .ignoresSafeArea()
            MoteField(count: 28, presence: 0.8)
                .ignoresSafeArea()
                .allowsHitTesting(false)

            VStack(spacing: 0) {
                if model.isConnectionNoteworthy {
                    ConnectionBanner(
                        summary: model.connectionSummary,
                        notice: model.notice
                    )
                    .transition(.move(edge: .top).combined(with: .opacity))
                }

                transcript

                ChatComposer(
                    draft: $model.draft,
                    isFocused: $composerFocused,
                    send: { Task { await model.send() } }
                )
            }
        }
        .animation(
            reduceMotion ? nil : SylTheme.Motion.settle,
            value: model.isConnectionNoteworthy
        )
        .navigationTitle("Syl")
        .navigationBarTitleDisplayMode(.inline)
        // The nav bar must not paint an opaque strip over the veil — that was the single
        // most visible seam between this screen and home.
        .toolbarBackground(.hidden, for: .navigationBar)
        .task { await model.refresh() }
    }

    /// The transcript, which is also the keyboard's dismiss target.
    ///
    /// Two dismiss mechanisms rather than one, because they cover different intentions:
    /// a drag means "I want to read what is above", a tap means "I am done typing".
    /// Shipping only the scroll dismissal leaves someone who taps a message stuck behind
    /// the keyboard with no obvious way out, and there is no Done button on a chat
    /// composer to fall back to. **Both are kept verbatim from the original — they were
    /// the best thing about it.**
    @ViewBuilder
    private var transcript: some View {
        if scrolls {
            scrollingTranscript
        } else {
            VStack {
                transcriptContent
                Spacer(minLength: 0)
            }
        }
    }

    /// The rows themselves, independent of the container they sit in.
    private var transcriptContent: some View {
        LazyVStack(alignment: .leading, spacing: SylTheme.Metric.gutter) {
            if model.snapshot.groups.isEmpty {
                EmptyConversation()
            }

            ForEach(rows) { row in
                switch row {
                case .day(let day):
                    DayDivider(day: day)
                case .turn(let group, let showsTime):
                    ChatTurn(
                        group: group,
                        showsTime: showsTime,
                        isStalled: model.isStalled(group),
                        retry: { Task { await model.retryQueued() } }
                    )
                    .id(group.id)
                }
            }

            // A zero-height sentinel. Its visibility *is* the answer to "is he at the
            // bottom", which no SwiftUI API gives directly on every version this app
            // supports.
            Color.clear
                .frame(height: 1)
                .id(Self.footAnchor)
                .onAppear {
                    isAtBottom = true
                    hasUnseenTurn = false
                }
                .onDisappear { isAtBottom = false }
        }
        .padding(.horizontal, SylTheme.Metric.gutter)
        .padding(.vertical, SylTheme.Metric.step)
    }

    private var scrollingTranscript: some View {
        ScrollViewReader { proxy in
            ZStack(alignment: .bottom) {
                ScrollView {
                    transcriptContent
                }
                .scrollIndicators(.hidden)
                // Land at the newest turn on first paint rather than relying solely on
                // an `onChange` that has nothing to react to yet — the pattern Adjutant
                // records as intermittently failing on long transcripts.
                .defaultScrollAnchor(.bottom)
                // `.interactively` rather than `.immediately` so the keyboard tracks the
                // finger and can be pulled back by reversing. The gesture is reversible,
                // which `.immediately` is not.
                .scrollDismissesKeyboard(.interactively)
                // A plain `.onTapGesture` on the ScrollView would swallow taps on the
                // messages themselves and compete with the scroll gesture. A
                // simultaneous, zero-distance drag recogniser dismisses without
                // consuming anything: text stays selectable and scrolling is unaffected.
                .simultaneousGesture(
                    DragGesture(minimumDistance: 0).onEnded { _ in
                        composerFocused = false
                    }
                )
                .onChange(of: model.snapshot.groups.last?.id) { _, id in
                    guard id != nil else { return }
                    if isAtBottom {
                        scrollToFoot(proxy)
                    } else {
                        // Do not yank the view out from under someone reading history.
                        // Tell him instead.
                        hasUnseenTurn = true
                    }
                }

                if hasUnseenTurn {
                    NewTurnPill { scrollToFoot(proxy) }
                        .padding(.bottom, SylTheme.Metric.step)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
            .animation(reduceMotion ? nil : SylTheme.Motion.settle, value: hasUnseenTurn)
        }
    }

    private var rows: [TranscriptRow] {
        TranscriptRhythm.rows(for: model.snapshot.groups)
    }

    private func scrollToFoot(_ proxy: ScrollViewProxy) {
        hasUnseenTurn = false
        withAnimation(reduceMotion ? nil : SylTheme.Motion.settle) {
            proxy.scrollTo(Self.footAnchor, anchor: .bottom)
        }
    }
}
