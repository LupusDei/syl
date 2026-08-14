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

    /// How close to the top of the loaded range counts as asking for more history.
    ///
    /// Roughly half a screen. Far enough that it fires while he is still dragging, rather
    /// than after he has hit the end and stopped; near enough that resting part-way up the
    /// transcript loads nothing, which is the difference between proximity and the mere
    /// existence of the control.
    private static let proximityToTheTop: CGFloat = 400

    /// Names the scroll view's own space, so the content's offset within it can be read.
    private static let scrollSpace = "transcript-scroll"

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
                    draft: model.draft,
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
        .toolbar {
            ToolbarItem(placement: .principal) {
                // Her name, in the display serif.
                //
                // Screenshotting chat beside home showed they shared palette, glass,
                // motes and letterspacing — and that chat contained **no serif at all**.
                // Home's identity is carried as much by New York as by the colours, and
                // a conversation with no headings in it had nothing of that. The nav
                // title was the stock system face, which is to say Settings' face.
                Text("Syl")
                    .font(SylTheme.Typeface.title)
                    .foregroundStyle(SylTheme.Colour.ink)
                    .accessibilityAddTraits(.isHeader)
            }
        }
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

            if model.snapshot.mayHaveEarlier {
                // **No `onAppear` here, and it is not an omission.**
                //
                // This row used to carry `.onAppear { loadEarlier() }`. Inside a
                // `LazyVStack`, `onAppear` means "this view was instantiated", not
                // "this view became visible" — it is true for rows nowhere near the
                // screen whenever something forces the stack to size its whole content
                // (`.defaultScrollAnchor(.bottom)` does exactly that), and it is true
                // again on every subtree rebuild. Loading reassigns the snapshot, which
                // rebuilds this subtree, which re-creates this row, which fired it
                // again; `isLoadingEarlier` was cleared by `defer` long before the next
                // appearance. The loop ended when the WHOLE CONVERSATION was resident.
                //
                // The trigger now belongs to the model, which is the only place a latch
                // survives the rebuild the load itself causes
                // (`reachedTheTopOfTheWindow()`). The scroll-proximity half is wired in
                // `syl-025.3.2`; until then this control is the way back, and a control
                // he taps is a correct state to ship.
                EarlierMessages(isLoading: model.isLoadingEarlier) {
                    Task { await model.loadEarlier() }
                }
            }

            ForEach(model.snapshot.rows) { row in
                switch row {
                case .day(let day):
                    DayDivider(day: day)
                case .turn(let group, let showsTime):
                    ChatTurn(
                        group: group,
                        showsTime: showsTime,
                        // This turn's blocks only. Handing every row the whole map made
                        // SwiftUI deep-compare the entire transcript per row, per update.
                        blocks: model.snapshot.blocks(forGroup: group.id),
                        isStalled: model.isStalled(group),
                        retry: { Task { await model.retryQueued() } }
                    )
                    .id(group.id)
                }
            }

            // She thinks *below the last thing said*, in the flow of the conversation.
            //
            // This was an overlay pinned to the bottom of the viewport, which put the
            // ribbon at the foot of the screen regardless of where the conversation
            // ended — so after a send it floated in empty space far below his message,
            // reading as decoration rather than as an answer to what he just asked.
            // In flow it sits directly under his turn, it scrolls with the transcript,
            // and `scrollToFoot` brings it to rest just above the keyboard.
            if HomeSnapshot.isActive(model.presence) {
                PresenceInTranscript(
                    presence: model.presence,
                    intensity: model.intensity
                )
                .allowsHitTesting(false)
                .transition(.opacity)
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
                        .background(
                            GeometryReader { geometry in
                                Color.clear.preference(
                                    key: NearTheTopKey.self,
                                    value: geometry.frame(in: .named(Self.scrollSpace)).minY
                                        >= -Self.proximityToTheTop
                                )
                            }
                        )
                }
                .coordinateSpace(name: Self.scrollSpace)
                .scrollIndicators(.hidden)
                // Her turns dissolve at the top edge instead of colliding with her name.
                //
                // The navigation bar is deliberately transparent so the veil runs
                // unbroken behind it — but transparent also means the transcript scrolls
                // *under* the title, and a paragraph passing through "Syl" is unreadable
                // in both directions. The Commander's screenshot shows exactly that.
                //
                // A mask rather than a painted scrim, because the mask is measured
                // against this view and therefore lands correctly whether or not a
                // connection banner is above it — a fixed scrim at the top of the screen
                // is right in one of those cases and wrong in the other. It is the same
                // edge-melt the hero uses so she ends by dissolving rather than on a
                // rectangle.
                .mask(
                    LinearGradient(
                        stops: [
                            .init(color: .clear, location: 0),
                            .init(color: .black, location: 0.05),
                            .init(color: .black, location: 1),
                        ],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                )
                // Land at the newest turn on first paint rather than relying solely on
                // an `onChange` that has nothing to react to yet — the pattern Adjutant
                // records as intermittently failing on long transcripts.
                .defaultScrollAnchor(.bottom)
                // `.interactively` rather than `.immediately` so the keyboard tracks the
                // finger and can be pulled back by reversing. The gesture is reversible,
                // which `.immediately` is not.
                // **Scroll geometry, and deliberately not a lifecycle callback.**
                //
                // The obvious wiring is the symmetric pair on the `EarlierMessages` row —
                // `.onAppear` to load, `.onDisappear` to re-arm. It is wrong in a way that
                // reads as correct: both fire as that row is realised and derealised, and
                // a load moves that row, so the `onDisappear` would clear the latch the
                // load had just set. The latch would be defeated by the precise mechanism
                // it exists to survive, and every model-level test would still pass,
                // because they call the two methods in a hand-written order the view does
                // not follow.
                //
                // The content's offset within the scroll view has none of that. It is a
                // property of the scroll view rather than of any row inside the
                // `LazyVStack`, so nothing about rebuilding the stack can produce a
                // spurious crossing.
                //
                // `onScrollGeometryChange` would say this in one line and is iOS 18; this
                // app deploys to 17. A preference carrying the already-reduced BOOLEAN
                // rather than the raw offset is what keeps the behaviour identical:
                // SwiftUI delivers a preference change only when the value differs, so the
                // action runs once per crossing rather than on every frame of a drag.
                .onPreferenceChange(NearTheTopKey.self) { isNearTheTop in
                    Task { @MainActor in
                        if isNearTheTop {
                            await model.reachedTheTopOfTheWindow()
                        } else {
                            model.leftTheTopOfTheWindow()
                        }
                    }
                }
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
                    // **His own message ALWAYS scrolls.** The `isAtBottom` gate exists to
                    // stop an arriving reply yanking the view away from someone reading
                    // history — it was never meant to apply to the message he just typed.
                    // Gating his own send behind it produced exactly the defect he
                    // reported: he sends, and his words are stranded mid-screen with the
                    // keyboard covering where they should have gone.
                    //
                    // The rule is the one already written down for motion: his finger
                    // caused it, so anything other than "it goes where he put it" reads
                    // as the app losing his message.
                    if model.snapshot.groups.last?.role == .user || isAtBottom {
                        scrollToFoot(proxy)
                    } else {
                        // Do not yank the view out from under someone reading history.
                        // Tell him instead.
                        hasUnseenTurn = true
                    }
                }
                // The keyboard is a viewport change, not a content change, so nothing
                // above fires for it. Without this the transcript keeps its old offset
                // and the newest turn ends up behind the keyboard.
                .onChange(of: composerFocused) { _, focused in
                    guard focused, isAtBottom else { return }
                    scrollToFoot(proxy)
                }
                // She started thinking, so the ribbon just took up room below his
                // message. Follow it, or the thing that says "she is working on it"
                // appears off-screen.
                .onChange(of: HomeSnapshot.isActive(model.presence)) { _, active in
                    guard active, isAtBottom else { return }
                    scrollToFoot(proxy)
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

    private func scrollToFoot(_ proxy: ScrollViewProxy) {
        hasUnseenTurn = false
        withAnimation(reduceMotion ? nil : SylTheme.Motion.settle) {
            proxy.scrollTo(Self.footAnchor, anchor: .bottom)
        }
    }
}

/// Whether the transcript is scrolled close enough to the top of its loaded range that he
/// is asking for more history.
///
/// Carries the **reduced** boolean rather than the raw offset on purpose. SwiftUI delivers
/// a preference change only when the value differs, so reducing before publishing turns a
/// continuous stream of offsets into one event per crossing — which is the whole
/// requirement, expressed in the type rather than in a guard someone has to remember.
private struct NearTheTopKey: PreferenceKey {
    static let defaultValue = false

    static func reduce(value: inout Bool, nextValue: () -> Bool) {
        value = value || nextValue()
    }
}
