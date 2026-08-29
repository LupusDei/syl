import SwiftUI
import SylKit

/// The home screen: Syl, and then the day beneath her.
///
/// ## The shape, and what it costs
///
/// The first version led with the day and kept Syl to a band. The Commander's verdict
/// was that it was not as beautiful as the concept, and that verdict is correct — an app
/// opened dozens of times a day earns the right to be looked at, and a column of text
/// does not earn that on its own.
///
/// So she leads. The trade is real and worth stating rather than pretending away:
/// proposal F warns that a character always on screen becomes wallpaper, and "wallpaper
/// that moves is worse than wallpaper". Three things hold that off, and none of them is
/// a behavioural instruction:
///
/// 1. **The hero is one screen, not the whole screen.** The day is directly beneath it
///    and a single scroll reaches it. `SOUL.md` still gets its answer to "what do I need
///    to do" — it is one thumb-flick away rather than first.
/// 2. **Presence is expressed as light, not as existence.** The art is always there; the
///    aura, the ribbon and the line under her name are not. At `absent` she is unlit and
///    still — which is the restraint rule surviving intact in a layout that never hides
///    her.
/// 3. **The scroll pays for itself.** The hero collapses as the day rises, so the moment
///    you go looking for work the decoration gets out of the way instead of being
///    scrolled past every time.
///
/// ## The three orbs are doors, not statistics
///
/// The concept labels them Goals / Memory / Today. They stay verbs-in-disguise: each
/// opens something. What they explicitly do not do is carry counts. The mind-map concept
/// did carry counts and it was rejected for it — "4 active", "12 connected" is the
/// dashboard failure mode, and it makes a quiet day look like an empty one.
struct HomeView: View {
    var snapshot: HomeSnapshot
    /// Why the day could not be read, if it could not. `nil` is the only state in which
    /// an empty spine may be called a clear day — see ``couldNotRead(_:)`` and `syl-019`.
    ///
    /// Defaulted so every existing caller keeps compiling into the succeeded case, which
    /// is what they all meant; only ``HomeScreen`` has a failure to pass.
    var loadFailure: String?
    /// What he did that Syl has not been told about, if anything.
    ///
    /// Defaulted like ``loadFailure``, so every preview and offscreen render draws the
    /// screen it drew before. See ``StallNotice`` for why the words live outside this
    /// file and ``queueHasStalled(_:)`` for why the card is drawn where it is.
    var stall: StallNotice?
    var presence: PresenceState
    var presenceIntensity: Double
    var now: Date
    /// The day's two intents, passed straight through to ``DaySpine``. They replaced a
    /// single anonymous `onSelect` that went nowhere: a row can be finished, and a
    /// reminder can be asked to move, and those are different acts.
    var onComplete: (DayMoment) -> Void = { _ in }
    var onPostpone: (DayMoment) -> Void = { _ in }
    var onDismissRefusal: (DayMoment) -> Void = { _ in }
    var onOpen: (Destination) -> Void = { _ in }
    /// Writes a to-do from the foot of the day. See ``CaptureField``.
    ///
    /// A closure of its own rather than a new `Destination` case, deliberately: adding a
    /// case to that enum breaks every exhaustive `switch` over it, and three squads are
    /// in this file's neighbourhood at once. Additive with a default, nothing else moves.
    var onCapture: (String) -> Void = { _ in }
    /// Opens everything he owes — the list the day cannot show, because the day can only
    /// show things with a time.
    var onOpenList: () -> Void = {}
    /// He held her face down (`syl-chzl.7`). Nil where there is no live face to open —
    /// a preview, an offscreen render, a device with no object graph behind it.
    ///
    /// **Additive, and it has to stay additive.** Every closure above keeps doing exactly
    /// what it did; this one is reached by a gesture none of them use. See ``doors()``
    /// for the assertion that says so.
    var onAwaken: (() -> Void)?

    /// What she is doing about that press, when there is anything to say.
    ///
    /// **Nil is the ordinary case and this screen is unchanged in it.** She is warming
    /// behind this view for anywhere from five to thirty seconds, and for that whole time
    /// he keeps his home screen: he can read the day, scroll it, open a door, walk away.
    /// The only thing this adds is one line over her own figure saying she is coming —
    /// and, in the case that matters most, one line saying she is not.
    ///
    /// Defaulted, like every closure above, so a preview, an offscreen render and every
    /// existing call site draw exactly the screen they drew before.
    var awakening: FaceNotice?

    /// Cancel the wait, or dismiss the failure. See ``LiveFaceModel/dismissNotice()`` —
    /// they are one gesture to him and two acts underneath, and this screen is not the
    /// place that knows which.
    var onCancelAwakening: () -> Void = {}

    /// Where an orb goes.
    ///
    /// `Hashable` since `syl-011.5.3`, because it is now a navigation path value:
    /// `HomeScreen` pushes `.goals` onto a `NavigationStack`. Goals, Memory and From Syl
    /// all lead somewhere; `today` is already this screen and scrolls instead.
    ///
    /// **Adding a case here breaks every exhaustive switch over it**, which is exactly
    /// why `onCapture` above is a closure rather than a fourth case. That is a feature:
    /// the compiler finds each site and each one gets a decision, which is why none of
    /// them has a `default`.
    enum Destination: Hashable, Sendable {
        case goals
        case memory
        /// What she has sent him. `syl-015.4.7`.
        case fromSyl
        case today
    }

    /// Set false only for offscreen rendering.
    ///
    /// `ImageRenderer` lays out nothing inside a `ScrollView` — an offscreen host never
    /// gives the scroll view a content size, so it renders an empty page. Found by
    /// looking at the first render, which came back as backdrop and no content at all.
    var scrolls: Bool = true

    @Environment(\.colorScheme) private var systemScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Bumped by the Today orb. A counter rather than a flag, so two taps in a row scroll
    /// twice instead of the second being swallowed as "no change".
    @State private var scrollToDay = 0
    /// What he *asked for*, as opposed to what he got. See ``EnvironmentValues/
    /// sylAppearance`` — the two are different questions and this screen needs both.
    @Environment(\.sylAppearance) private var appearance

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                SylTheme.Veil()
                MoteField(count: 40, presence: 1)
                    .ignoresSafeArea()

                if scrolls {
                    ScrollViewReader { proxy in
                        ScrollView {
                            stack(viewport: geometry.size)
                        }
                        // The Today orb's whole job. The day is already on this screen,
                        // one fold below her — so the honest action is to take him to it,
                        // not to push a second copy onto a stack.
                        .onChange(of: scrollToDay) { _, _ in
                            withAnimation(reduceMotion ? nil : SylTheme.Motion.settle) {
                                proxy.scrollTo(Self.dayAnchor, anchor: .top)
                            }
                        }
                    }
                    .scrollIndicators(.hidden)
                } else {
                    stack(viewport: geometry.size)
                }
            }
            .environment(
                \.colorScheme,
                Self.scheme(for: appearance, sceneIsPresent: sceneIsPresent, system: systemScheme)
            )
        }
    }

    /// The appearance this screen renders in.
    ///
    /// ## Why it forces anything at all
    ///
    /// The scene is deep space, so with clips bundled this screen wants to be night in
    /// *both* system appearances. That is not a stylistic whim. The clips are painted on
    /// a starfield, and the light palette's ink is a deep slate blue chosen to be read
    /// against pale fog. Put that ink over a starfield and it is unreadable; put the pale
    /// veil around the starfield and you get the bright-rectangle problem in reverse — a
    /// dark box floating on a light page.
    ///
    /// Forcing the appearance rather than adding a third palette means every token
    /// already defined for night — ink, veil, hairline, glass — applies unchanged, and
    /// `Image("SylHero")` resolves to the night still for free, because the asset
    /// catalogue's `luminosity` variant follows this same environment value.
    ///
    /// ## Why forcing it *unconditionally* was wrong
    ///
    /// All of the above is an argument about what to do when **nobody has said
    /// otherwise**, and it was written when nobody could. Applied unconditionally it made
    /// this the one screen in the app that ignores the Commander: he set iOS to Light and
    /// got a bright conversation next to a black home — the same "one product" failure
    /// `syl-008` spent a day fixing on the other screen.
    ///
    /// So the rule is now scoped to the case it was always reasoning about. Under
    /// ``AppearanceChoice/system`` the starfield argument stands untouched. Under an
    /// explicit Day or Night he has answered the question himself, and the scene gives
    /// way instead: ``SceneCatalogue/shouldPlay(reduceMotion:appearance:)`` falls back to
    /// the still, and the still resolves to the daylight painting through the same
    /// `luminosity` variant. The starfield never ends up in a bright frame — it simply
    /// is not the thing being drawn.
    static func scheme(
        for choice: AppearanceChoice,
        sceneIsPresent: Bool,
        system: ColorScheme
    ) -> ColorScheme {
        switch choice {
        case .system: return sceneIsPresent ? .dark : system
        case .day: return .light
        case .night: return .dark
        }
    }

    /// True when the app ships scene clips, which is what makes this screen want to be a
    /// night scene in the absence of an explicit choice.
    private var sceneIsPresent: Bool { !SceneCatalogue.clips.isEmpty }

    private func stack(viewport: CGSize) -> some View {
        VStack(spacing: 0) {
            hero(viewport: viewport)
            day.id(Self.dayAnchor)
        }
    }

    /// Where the Today orb goes.
    private static let dayAnchor = "home-day"

    // MARK: - The hero

    /// Sized to the viewport so the first screen is exactly her, and the day begins
    /// precisely at the fold — close enough to hint that something is below, far enough
    /// that nothing competes with her.
    private func hero(viewport: CGSize) -> some View {
        // She fills the frame; the type and the orbs sit ON her, on a glossy fade.
        //
        // This was a VStack — art in a band, then the name, then the orbs beneath it —
        // and it gave her a rectangle to stand in. Now she is the screen and everything
        // else is composited over the bottom of it, which is what the concept art always
        // showed and what the Commander asked for.
        ZStack(alignment: .bottom) {
            // The hero art alone. What she is *doing* used to be drawn across it, as a
            // ribbon — see ``SylHalo`` for why it moved, and for why the ribbon was
            // right in chat and wrong here.
            figure
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .animation(SylTheme.Motion.breathe, value: presence)

            nameplate(width: viewport.width)
        }
        // **Over her, and over nothing else.** An overlay rather than a row in the
        // nameplate stack, so that a face on its way moves not one point of the layout
        // he is reading — and it sits at the top of the hero, clear of her own light and
        // clear of the doors, where the eye that just pressed her is already looking.
        .overlay(alignment: .top) {
            if let awakening {
                AwakeningNotice(
                    notice: awakening,
                    onCancel: onCancelAwakening,
                    // Pressing again *is* the gesture. Routing retry through the same
                    // handler the long press uses means there is one way in, so the
                    // guard against opening two sessions covers this button for free.
                    onRetry: onAwaken
                )
                .padding(.top, SylTheme.Metric.chapter)
                .padding(.horizontal, SylTheme.Metric.gutter)
                .transition(.opacity)
            }
        }
        .animation(reduceMotion ? nil : SylTheme.Motion.settle, value: awakening)
        // One *visible* screen, not one raw geometry height.
        //
        // `GeometryReader` inside this scroll view reports a height that runs underneath
        // the tab bar, so sizing the hero to it pushed the day's first two lines into the
        // space behind the bar — they showed through it, clipped mid-word, on the device.
        // `containerRelativeFrame` measures the scroll container's own visible extent and
        // honours its safe-area insets, which is exactly the quantity "one screen" was
        // always supposed to mean.
        //
        // It needs a scroll container to measure, so the offscreen render path — which
        // has none — falls back to the raw viewport. That path has no tab bar either, so
        // there is nothing for it to get wrong.
        .modifier(OneScreenTall(active: scrolls, fallback: viewport.height))
    }

    /// Her, as a value.
    ///
    /// A property rather than an expression inside ``hero(viewport:)`` so a test can hold
    /// the hero this screen actually builds and check what reached it. That is not
    /// ceremony: the long press is a `UIGestureRecognizer` behind a `UIViewRepresentable`
    /// inside a `GeometryReader` inside a `ScrollView`, and none of that is reachable
    /// from a test — but *"did the home screen hand its hero a way to wake her"* is the
    /// question that actually goes wrong, and this makes it answerable.
    var figure: SylHero {
        SylHero(
            presence: presence,
            intensity: presenceIntensity,
            prefersStill: !scrolls,
            onAwaken: onAwaken
        )
    }

    /// Her name, her line, and the three doors — over a glossy fade.
    ///
    /// The fade is what makes this legible without a panel. Type laid directly on the art
    /// competes with a starfield and loses; a card under it would put a rectangle back on
    /// the screen, which is the thing we just removed. A gradient does neither: the image
    /// deepens toward the bottom, and the words rise out of it.
    ///
    /// Two layers rather than one. The `veilDeep` ramp supplies the contrast the type
    /// needs, and a thin `luminanceCore` sheen just above it catches the eye the way a
    /// curved glass surface would — that is the "glossy" part, and without it the ramp
    /// alone reads as a grey wash.
    private func nameplate(width: CGFloat) -> some View {
        VStack(spacing: 0) {
            Text("Syl")
                .font(.system(size: 54, design: .serif))
                .foregroundStyle(SylTheme.Colour.ink)
                .shadow(color: SylTheme.Colour.luminanceCore.opacity(0.9), radius: 14)

            // Her line, inside the halo that orbits it. The halo owns the `Text` because
            // it is sized from the phrase's own measured lines, and it occupies a layout
            // box exactly the size of its ring — which is what makes "the ring never
            // collides with the title above or the orbs below" a fact about this stack
            // rather than a promise about some numbers.
            SylHalo(
                phrase: HomeSnapshot.phrase(for: presence) ?? snapshot.greeting,
                state: presence,
                intensity: presenceIntensity,
                availableWidth: width
            )

            orbs
                .padding(.bottom, SylTheme.Metric.gutter)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, SylTheme.Metric.chapter)
        .background(alignment: .top) {
            ZStack(alignment: .top) {
                LinearGradient(
                    stops: [
                        .init(color: SylTheme.Colour.veilDeep.opacity(0), location: 0.00),
                        .init(color: SylTheme.Colour.veilDeep.opacity(0.55), location: 0.32),
                        .init(color: SylTheme.Colour.veilDeep.opacity(0.88), location: 0.62),
                        .init(color: SylTheme.Colour.veilDeep, location: 1.00),
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                )

                // The gloss: a single soft band of her own light along the top of the
                // fade, so it reads as a surface catching light rather than as a scrim.
                LinearGradient(
                    colors: [
                        SylTheme.Colour.luminanceCore.opacity(0),
                        SylTheme.Colour.luminanceCore.opacity(0.16),
                        SylTheme.Colour.luminanceCore.opacity(0),
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                )
                .frame(height: 90)
                .blendMode(.plusLighter)
            }
            .allowsHitTesting(false)
        }
    }

        // One *visible* screen, not one raw geometry height.
        //
    /// **Even slots rather than fixed spacing**, since From Syl made this a fourth door.
    ///
    /// Four 82-point spheres separated by `chapter` need 448 points and the narrowest
    /// phone this app runs on has 375. A smaller constant would have fixed today's count
    /// and broken on the next one; distributing the width means the row breathes at three
    /// doors and still fits at four, on every device, with no number to revisit.
    private var orbs: some View {
        HStack(alignment: .top, spacing: 0) {
            ForEach(doors(), id: \.title) { door in
                door.frame(maxWidth: .infinity)
            }
        }
    }

    /// The four doors, as values.
    ///
    /// ## Why this is a function and not four expressions in a stack
    ///
    /// **So that "a plain tap still does what it did today" is a test rather than a
    /// hope.** `syl-chzl.7` adds a long press to this screen and is explicit that
    /// regressing tap-to-open would be a worse outcome than not shipping the gesture at
    /// all — and a snapshot cannot catch a lost tap handler, because a door whose action
    /// went nowhere renders pixel-identical to one that works. This project has the scar:
    /// the Memory orb shipped looking exactly like its neighbours and doing nothing, and
    /// the Commander reasonably concluded the app was broken.
    ///
    /// Returning the orbs lets a test press each one and assert where it goes. Nothing
    /// about what is drawn changed.
    func doors() -> [SylOrb] {
        [
            SylOrb(title: "Goals", symbol: "sparkle") { onOpen(.goals) },
            // Open since `syl-ryp.2`. It was dimmed because an orb identical to the two
            // beside it that does nothing when tapped is worse than one visibly not
            // ready — he tapped it and reasonably concluded the app was broken. It now
            // leads to the constellation, so the dimming would be the lie instead.
            SylOrb(title: "Memory", symbol: "cloud") { onOpen(.memory) },
            // An envelope rather than a play triangle, and that is the same ruling the
            // screen's title carries: what arrives there is not a video, it is her. A
            // file-format glyph would name the wrong thing on the one door where the
            // sender is the point.
            SylOrb(title: "From Syl", symbol: "envelope") { onOpen(.fromSyl) },
            SylOrb(
                title: "Today",
                symbol: "sun.horizon",
                // The one place a number is allowed, because it is not a statistic about
                // the system — it is the count of things still waiting on him, and it is
                // absent entirely when there are none.
                detail: snapshot.isClear ? nil : "\(snapshot.remaining) left"
            ) { scrollToDay &+= 1 },
        ]
    }

    /// The waking notice, as a value — nil when there is nothing to say.
    ///
    /// A function for exactly the reason ``doors()`` is one, and against the same scar:
    /// **a button whose handler went missing renders pixel-identical to one that works.**
    /// The two handlers here are the only way to cancel a session that is billing and the
    /// only way to retry one that failed, so a snapshot proving the pill is drawn proves
    /// nothing worth knowing. This lets a test press them and check where they go.
    func awakeningNotice() -> AwakeningNotice? {
        awakening.map {
            AwakeningNotice(notice: $0, onCancel: onCancelAwakening, onRetry: onAwaken)
        }
    }

    // MARK: - The day

    private var day: some View {
        VStack(alignment: .leading, spacing: SylTheme.Metric.gutter) {
            HStack(spacing: SylTheme.Metric.snug) {
                Text(now, format: .dateTime.weekday(.wide).day().month(.wide))
                    .sylLabelStyle()
                    .foregroundStyle(SylTheme.Colour.inkFaint)
                Spacer()
                if !snapshot.isClear {
                    Text("\(snapshot.remaining) left")
                        .sylLabelStyle()
                        .foregroundStyle(SylTheme.Colour.inkFaint)
                        .contentTransition(.numericText())
                        .animation(SylTheme.Motion.settle, value: snapshot.remaining)
                }
            }

            if let note = snapshot.note {
                NoteCard(note: note)
            }

            // ABOVE the spine and outside the three-way choice below, because it is true
            // of every one of those states. A day that reads as clear while three of his
            // completions sit undelivered is the most misleading version of this screen
            // there is, and it is the version he actually had for three days.
            if let stall {
                queueHasStalled(stall)
            }

            if let failure = loadFailure {
                // BEFORE ANY READING OF THE SPINE. An empty spine means "nothing is due"
                // only when the read that produced it succeeded; if it failed, the spine
                // is not empty, it is UNKNOWN, and those must never render the same
                // (`syl-019`).
                couldNotRead(failure)
            } else if snapshot.moments.isEmpty {
                clearDay
            } else {
                DaySpine(
                    moments: snapshot.moments,
                    now: now,
                    onComplete: onComplete,
                    onPostpone: onPostpone,
                    onDismissRefusal: onDismissRefusal
                )
            }

            // Write one down, and the door to everything the day cannot show. See
            // ``FootOfDay`` — it lives in its own file because this one is being edited
            // by three squads at once, and because a whole-screen render can never draw
            // it.
            FootOfDay(
                openElsewhere: snapshot.openElsewhere,
                onCapture: onCapture,
                onOpenList: onOpenList
            )
            .padding(.top, SylTheme.Metric.step)
        }
        .padding(.horizontal, SylTheme.Metric.gutter)
        .padding(.top, SylTheme.Metric.gutter)
        .padding(.bottom, SylTheme.Metric.chapter)
    }

    /// The day could not be read — which is NOT the same as the day being clear.
    ///
    /// She says she does not know, rather than that there is nothing, because those are
    /// different facts and only one of them is safe to be wrong about. Being told his
    /// day is clear when it is not is how he misses something; being told she cannot see
    /// it costs him one glance at the list.
    ///
    /// The error text is shown, deliberately and unprettified. This screen is currently
    /// the only place the failure is observable at all, so hiding the detail behind a
    /// friendly sentence would remove the only evidence anyone has.
    private func couldNotRead(_ failure: String) -> some View {
        VStack(alignment: .leading, spacing: SylTheme.Metric.snug) {
            Text("I cannot see your day")
                .font(SylTheme.Typeface.title)
                .foregroundStyle(SylTheme.Colour.ink)

            Text("Something went wrong reading it, so I will not tell you it is clear — I do not know that. Your list below is intact.")
                .font(SylTheme.Typeface.detail)
                .foregroundStyle(SylTheme.Colour.inkSoft)

            Text(failure)
                .font(SylTheme.Typeface.detail.monospaced())
                .foregroundStyle(SylTheme.Colour.inkSoft)
                .textSelection(.enabled)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .transition(.opacity.combined(with: .scale(scale: 0.98)))
        .accessibilityElement(children: .combine)
    }

    /// His work is on this device and nowhere else, and this is the screen that says so.
    ///
    /// Not a toast and not a badge. He finishes things here, the row leaves the spine
    /// looking finished, and the queue behind it is the one part of that transaction he
    /// cannot see — so the notice has to sit in the day itself, above the work, for as
    /// long as it is true. It disappears on its own the moment the queue drains, because
    /// it is derived from the queue rather than dismissed.
    ///
    /// The date is rendered rather than counted in words: "since Tuesday" is what turns
    /// this from a network grumble into the fact that Syl has been out of step with him
    /// for three days.
    private func queueHasStalled(_ notice: StallNotice) -> some View {
        VStack(alignment: .leading, spacing: SylTheme.Metric.snug) {
            Text(notice.title)
                .font(SylTheme.Typeface.title)
                .foregroundStyle(SylTheme.Colour.ink)

            Text(notice.detail)
                .font(SylTheme.Typeface.detail)
                .foregroundStyle(SylTheme.Colour.inkSoft)

            Text("Since \(notice.since.formatted(.dateTime.weekday(.wide).hour().minute()))")
                .font(SylTheme.Typeface.detail)
                .foregroundStyle(SylTheme.Colour.inkSoft)

            Text(notice.reason)
                .font(SylTheme.Typeface.detail.monospaced())
                .foregroundStyle(SylTheme.Colour.inkFaint)
                .textSelection(.enabled)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .transition(.opacity.combined(with: .scale(scale: 0.98)))
        .accessibilityElement(children: .combine)
    }

    /// Nothing left. Still the best state the screen has — she simply has the screen
    /// above it now rather than expanding into this space.
    private var clearDay: some View {
        VStack(alignment: .leading, spacing: SylTheme.Metric.snug) {
            Text("The day is clear")
                .font(SylTheme.Typeface.title)
                .foregroundStyle(SylTheme.Colour.ink)

            Text("Nothing needs you. I will speak up if that changes.")
                .font(SylTheme.Typeface.detail)
                .foregroundStyle(SylTheme.Colour.inkSoft)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .transition(.opacity.combined(with: .scale(scale: 0.98)))
        .accessibilityElement(children: .combine)
    }
}

/// Sizes a view to one visible screen of its scroll container.
///
/// Split out as a modifier because `containerRelativeFrame` and a plain `frame` cannot
/// be selected between inline without changing the view's type on each branch.
private struct OneScreenTall: ViewModifier {
    let active: Bool
    let fallback: CGFloat

    func body(content: Content) -> some View {
        if active {
            content.containerRelativeFrame(.vertical)
        } else {
            content.frame(height: fallback)
        }
    }
}

/// The one card, when there is one.
private struct NoteCard: View {
    let note: DayNote

    var body: some View {
        HStack(alignment: .top, spacing: SylTheme.Metric.step) {
            Image(systemName: note.tone == .late ? "clock.badge.exclamationmark" : "exclamationmark.circle")
                .font(.system(size: 18, weight: .light))
                .foregroundStyle(tint)
                .frame(width: 26, height: 26)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 2) {
                Text(note.tone == .late ? "I was late" : "Needs you now")
                    .sylLabelStyle()
                    .foregroundStyle(tint)

                Text(note.text)
                    .font(SylTheme.Typeface.detail)
                    .foregroundStyle(SylTheme.Colour.ink)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 0)
        }
        .padding(SylTheme.Metric.gutter)
        .sylGlass()
        .accessibilityElement(children: .combine)
    }

    private var tint: Color {
        note.tone == .late ? SylTheme.Colour.warmth : SylTheme.Colour.accent
    }
}

// MARK: - Previews

#Preview("Hero") {
    HomeView(snapshot: .preview(remaining: 4), presence: .thinking, presenceIntensity: 0.7, now: .now)
}

#Preview("Clear") {
    HomeView(
        snapshot: HomeSnapshot(moments: [], remaining: 0, note: nil, prominence: 1, greeting: "Good evening"),
        presence: .idle,
        presenceIntensity: 0.4,
        now: .now
    )
}

extension HomeSnapshot {
    /// Preview data. Not test data — the tests build their own from real model types.
    static func preview(remaining: Int, late: Bool = false) -> HomeSnapshot {
        // Fixed wall-clock hours, so "Morning light" is not timestamped 6:40 PM. A
        // preview whose data contradicts its own labels teaches the reader to distrust
        // the screenshot.
        let day = Calendar(identifier: .gregorian)
            .date(from: DateComponents(year: 2026, month: 8, day: 10)) ?? .now
        let hours: [Int] = [7, 9, 11, 14, 19]

        let titles = [
            "Morning light — gratitude and breath",
            "Clarity focus — journal and reflect",
            "Inner alignment — meditation and stillness",
            "Create and flow — art, writing or music",
            "Evening reflection — review and release",
        ]

        let moments = titles.enumerated().map { index, title in
            DayMoment(
                id: "m\(index)",
                title: title,
                at: day.addingTimeInterval(Double(hours[index]) * 3600),
                standing: index == 0 ? .done : (index == 1 ? .due : .upcoming),
                origin: index.isMultiple(of: 2) ? .reminder : .todo,
                urgent: false,
                late: late && index == 1,
                pinned: index == 3
            )
        }

        // Derived, never asserted. An earlier version took `remaining` as a parameter
        // and rendered "2 left today" above four unfinished rows — preview data that
        // contradicts itself is worse than none, because it gets screenshotted.
        let shown = Array(moments.prefix(max(remaining + 1, 2)))
        let outstanding = shown.filter { $0.standing != .done }.count

        return HomeSnapshot(
            moments: shown,
            remaining: outstanding,
            note: late ? DayNote(tone: .late, text: "Clarity focus — this was due earlier. I was late.") : nil,
            prominence: HomeSnapshot.prominence(remaining: outstanding),
            greeting: "Good morning",
            // The whole point of the door: things with no day, which the spine above it
            // can never show. A preview with zero here would screenshot the one state
            // that hides the feature.
            openElsewhere: 7
        )
    }
}
