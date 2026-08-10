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

    /// Where an orb goes. Only `today` is wired; the other two are the next screens.
    enum Destination: Equatable, Sendable {
        case goals
        case memory
        case today
    }

    /// Set false only for offscreen rendering.
    ///
    /// `ImageRenderer` lays out nothing inside a `ScrollView` — an offscreen host never
    /// gives the scroll view a content size, so it renders an empty page. Found by
    /// looking at the first render, which came back as backdrop and no content at all.
    var scrolls: Bool = true

    @Environment(\.colorScheme) private var systemScheme
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
                    ScrollView {
                        stack(viewport: geometry.size)
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
            day
        }
    }

    // MARK: - The hero

    /// Sized to the viewport so the first screen is exactly her, and the day begins
    /// precisely at the fold — close enough to hint that something is below, far enough
    /// that nothing competes with her.
    private func hero(viewport: CGSize) -> some View {
        VStack(spacing: 0) {
            // The ribbon lives *inside* the hero, drifting across her, rather than in a
            // band of its own.
            //
            // As a separate strip under her name it rendered as a near-flat hairline
            // spanning the full width — which reads as a divider rule, not as a
            // character. Laid over her it becomes what the concept art actually shows:
            // a current of light passing through her. It is also the only thing on this
            // screen that can say "thinking", because a still image cannot.
            ZStack {
                SylHero(presence: presence, intensity: presenceIntensity, prefersStill: !scrolls)

                // The ribbon appears only while she is *doing* something.
                //
                // Drawn continuously it was a coloured line lying across her — a
                // scratch, not light, and it competed with the art every second of
                // every day. Restricting it to the active states fixes the look and is
                // the better rule anyway: the art says who she is, the ribbon says what
                // she is doing, and most of the time she is not doing anything, which
                // is exactly the state this whole product is designed to make restful.
                if HomeSnapshot.isActive(presence) {
                    SylRibbon(state: presence, intensity: presenceIntensity)
                        .frame(height: viewport.height * 0.20)
                        .offset(y: viewport.height * 0.16)
                        .opacity(0.75)
                        .blendMode(.plusLighter)
                        .allowsHitTesting(false)
                        .transition(.opacity)
                }
            }
            // Enlarged on the Commander's note. The ceiling is the art's own ratio: at
            // this height she is already as wide as the screen, so any more height
            // would only add margin above and below her rather than making her bigger.
            .frame(height: max(viewport.height * 0.66, 360))
            .animation(SylTheme.Motion.breathe, value: presence)

            // Her name, in the one piece of real display type in the app. The glow
            // stands in for the light behind her, so the type belongs to the same scene
            // rather than sitting on top of it.
            Text("Syl")
                .font(.system(size: 54, design: .serif))
                .foregroundStyle(SylTheme.Colour.ink)
                .shadow(color: SylTheme.Colour.luminanceCore.opacity(0.9), radius: 14)
                .padding(.top, -SylTheme.Metric.step)

            // The presence line. Letterspaced, as in the concept — it is a caption to
            // her, not a heading of its own.
            Text(HomeSnapshot.phrase(for: presence) ?? snapshot.greeting)
                .font(.system(.subheadline, design: .serif))
                .tracking(2.2)
                .foregroundStyle(SylTheme.Colour.inkSoft)
                .multilineTextAlignment(.center)
                .contentTransition(.opacity)
                .animation(SylTheme.Motion.breathe, value: presence)
                .padding(.top, SylTheme.Metric.tight)
                .padding(.horizontal, SylTheme.Metric.gutter)

            Spacer(minLength: SylTheme.Metric.snug)

            orbs
                .padding(.bottom, SylTheme.Metric.gutter)
        }
        // One *visible* screen, not one raw geometry height.
        //
        // `GeometryReader` inside this scroll view reports a height that runs underneath
        // the tab bar, so sizing the hero to it pushed the day's first two lines into
        // the space behind the bar — they showed through it, clipped mid-word, on the
        // device. `containerRelativeFrame` measures the scroll container's own visible
        // extent and honours its safe-area insets, which is exactly the quantity "one
        // screen" was always supposed to mean.
        //
        // It needs a scroll container to measure, so the offscreen render path — which
        // has none — falls back to the raw viewport. That path has no tab bar either,
        // so there is nothing for it to get wrong.
        .modifier(OneScreenTall(active: scrolls, fallback: viewport.height))
    }

    private var orbs: some View {
        HStack(alignment: .top, spacing: SylTheme.Metric.chapter) {
            SylOrb(title: "Goals", symbol: "sparkle") { onOpen(.goals) }
            SylOrb(title: "Memory", symbol: "cloud") { onOpen(.memory) }
            SylOrb(
                title: "Today",
                symbol: "sun.horizon",
                // The one place a number is allowed, because it is not a statistic about
                // the system — it is the count of things still waiting on him, and it is
                // absent entirely when there are none.
                detail: snapshot.isClear ? nil : "\(snapshot.remaining) left"
            ) { onOpen(.today) }
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

            if snapshot.moments.isEmpty {
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
