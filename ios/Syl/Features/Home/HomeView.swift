import SwiftUI
import SylKit

/// The home screen: the day's spine, with Syl's presence as the weather around it.
///
/// ## The balance struck between the five concepts
///
/// The concepts disagree about what a home screen *is*, and the disagreement is the
/// interesting part.
///
/// - The **mind map** answers with a dashboard of counts — "12 connected", "5 in
///   motion". Those are the same class of thing proposal B threw out when it rejected
///   percent-complete and priority ladders: numbers that look like progress and are
///   not. Worse, they make a quiet day read as a failure, which is exactly backwards.
/// - The **constellation** answers with a launcher wearing a graph. Six taps and no
///   information — and the memory graph belongs in the admin, where it can be studied,
///   not on a phone at 06:00.
/// - The **two hero screens** answer with Syl herself, which is gorgeous and makes her
///   wallpaper — the precise failure proposal F names when it says "wallpaper that
///   moves is worse than wallpaper". But they carry the best single idea in the set:
///   a line under her name saying what she is doing.
/// - The **timeline** is the only one that answers "what do I need to do", which is
///   what `SOUL.md` says the first thing on any surface must answer.
///
/// So: the timeline's spine is the content, the hero screens' presence line is the
/// voice, and the amount of screen Syl occupies is decided by ``HomeSnapshot/prominence(remaining:)``.
///
/// ## Presence scales inversely with load
///
/// A full day pushes her to a band at the top and gives the spine the screen. As the
/// day empties she expands into the space it leaves, and on a clear day she has all of
/// it. This is how the master plan's "a quiet day is a success" stops being a sentence
/// in a document and becomes something you can see.
struct HomeView: View {
    /// Prepared off the main actor. See `HomeSnapshotLoader`.
    var snapshot: HomeSnapshot
    /// Already decayed by `PresenceTimeline` — never a raw frame state.
    var presence: PresenceState
    var presenceIntensity: Double
    var now: Date
    var onSelect: (DayMoment) -> Void = { _ in }

    /// Set false only for offscreen rendering.
    ///
    /// `ImageRenderer` lays out nothing inside a `ScrollView` — an offscreen host never
    /// gives the scroll view a content size, so it renders an empty page. Found by
    /// looking at the first render, which came back as backdrop and no content at all.
    /// The alternative was to render a hand-assembled copy of this layout, which would
    /// then drift from the real one and quietly stop being evidence of anything.
    var scrolls: Bool = true

    var body: some View {
        ZStack {
            SylTheme.Veil()
            MoteField(count: 34, presence: 0.35 + 0.65 * snapshot.prominence)
                .ignoresSafeArea()

            if scrolls {
                ScrollView {
                    stack
                }
                .scrollIndicators(.hidden)
            } else {
                VStack(spacing: 0) {
                    stack
                    Spacer(minLength: 0)
                }
            }
        }
        .animation(SylTheme.Motion.drift, value: snapshot.prominence)
    }

    private var stack: some View {
        VStack(alignment: .leading, spacing: SylTheme.Metric.loose) {
            header
            presenceBand
            body(for: snapshot)
        }
        .padding(.horizontal, SylTheme.Metric.gutter)
        .padding(.top, SylTheme.Metric.step)
        .padding(.bottom, SylTheme.Metric.chapter)
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: SylTheme.Metric.tight) {
            Text(now, format: .dateTime.weekday(.wide).day().month(.wide))
                .sylLabelStyle()
                .foregroundStyle(SylTheme.Colour.inkFaint)

            Text(snapshot.greeting)
                .font(SylTheme.Typeface.display)
                .foregroundStyle(SylTheme.Colour.ink)

            // The presence line. Reserves its own height so that a state change does
            // not reflow the whole screen underneath it — text appearing and
            // disappearing is fine, the day jumping half an inch is not.
            Text(HomeSnapshot.phrase(for: presence) ?? " ")
                .font(SylTheme.Typeface.subtitle)
                .foregroundStyle(SylTheme.Colour.inkSoft)
                .contentTransition(.opacity)
                .animation(SylTheme.Motion.breathe, value: presence)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    // MARK: - Presence

    /// The band Syl occupies. Height is the whole mechanic.
    private var presenceBand: some View {
        SylRibbon(state: presence, intensity: presenceIntensity)
            .frame(height: bandHeight)
            .frame(maxWidth: .infinity)
            .accessibilityElement()
            .accessibilityLabel("Syl")
            .accessibilityValue(HomeSnapshot.phrase(for: presence) ?? "Not present")
    }

    /// 96pt when the day is full, 300pt when it is clear.
    ///
    /// The floor is not zero even on the busiest day. She never disappears because the
    /// Commander is busy — being busy is not a reason to be abandoned, and a character
    /// that vanishes under load is one that is never there when it matters.
    private var bandHeight: CGFloat {
        96 + 204 * snapshot.prominence
    }

    // MARK: - The day

    @ViewBuilder
    private func body(for snapshot: HomeSnapshot) -> some View {
        if snapshot.moments.isEmpty {
            clearDay
        } else {
            VStack(alignment: .leading, spacing: SylTheme.Metric.gutter) {
                if let note = snapshot.note {
                    NoteCard(note: note)
                }

                VStack(alignment: .leading, spacing: SylTheme.Metric.step) {
                    Text(snapshot.isClear ? "Today" : "\(snapshot.remaining) left today")
                        .sylLabelStyle()
                        .foregroundStyle(SylTheme.Colour.inkFaint)
                        .contentTransition(.numericText())
                        .animation(SylTheme.Motion.settle, value: snapshot.remaining)

                    DaySpine(moments: snapshot.moments, now: now, onSelect: onSelect)
                }
            }
        }
    }

    /// Nothing left. **The best state the screen has, and composed as one.**
    ///
    /// No grey glyph, no "You're all caught up!", no empty-list illustration apologising
    /// for the absence of content. The day is clear, Syl has the whole screen, and the
    /// only text is one quiet line. If the Commander opens the app on a clear evening
    /// and finds it beautiful, the product has made its own argument.
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
        .padding(.top, SylTheme.Metric.snug)
        .transition(.opacity.combined(with: .scale(scale: 0.98)))
        .accessibilityElement(children: .combine)
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

#Preview("A full day") {
    HomeView(
        snapshot: .preview(remaining: 5),
        presence: .thinking,
        presenceIntensity: 0.7,
        now: .now
    )
}

#Preview("A clear day") {
    HomeView(
        snapshot: HomeSnapshot(
            moments: [], remaining: 0, note: nil,
            prominence: 1, greeting: "Good evening"
        ),
        presence: .idle,
        presenceIntensity: 0.4,
        now: .now
    )
}

#Preview("Late, and she says so") {
    HomeView(
        snapshot: .preview(remaining: 2, late: true),
        presence: .alert,
        presenceIntensity: 1,
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
        let outstanding = moments.filter { $0.standing != .done }.count

        return HomeSnapshot(
            moments: Array(moments.prefix(max(remaining + 1, 2))),
            remaining: min(remaining, outstanding),
            note: late ? DayNote(tone: .late, text: "Clarity focus — this was due earlier. I was late.") : nil,
            prominence: HomeSnapshot.prominence(remaining: remaining),
            greeting: "Good morning"
        )
    }
}
