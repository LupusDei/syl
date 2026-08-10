import SwiftUI

/// The connection state, said plainly.
///
/// The server genuinely will be unreachable sometimes — the Mac reboots, the tailnet
/// drops on a WiFi-to-cellular handoff, the phone goes through a tunnel. An assistant
/// that silently fails to sync is worse than one that says so, which is why this is kept
/// rather than designed away.
///
/// It used to appear and disappear with no animation at all — a bare `if` in a `VStack`,
/// so the entire transcript jumped every time the connection state changed. That is now
/// a transition, because a layout that moves without being animated reads as a glitch.
struct ConnectionBanner: View {
    let summary: String
    let notice: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(summary)
                .font(SylTheme.Typeface.detail.weight(.medium))
                .foregroundStyle(SylTheme.Colour.ink)
            if let notice {
                Text(notice)
                    .font(SylTheme.Typeface.numeral)
                    .foregroundStyle(SylTheme.Colour.inkFaint)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, SylTheme.Metric.gutter)
        .padding(.vertical, SylTheme.Metric.snug)
        // A hairline and nothing else.
        //
        // This carried `.ultraThinMaterial` across the full width and it was the one
        // element left on the screen that read as iOS rather than as Syl — an opaque
        // grey strip capping the veil, exactly like a system banner. Nothing else in
        // this app puts a filled bar above content. The rule alone separates it, and
        // the veil runs unbroken from the navigation bar to the composer.
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(SylTheme.Colour.hairline)
                .frame(height: SylTheme.Metric.hair)
        }
        .accessibilityElement(children: .combine)
    }
}

/// The conversation before there is one.
///
/// Deliberately two lines and no more. Starter-prompt chips were considered and
/// rejected: they are useful for ten minutes on day one and dead weight for the
/// following year, and this is a daily tool for one person who knows what it is for.
struct EmptyConversation: View {
    var body: some View {
        VStack(spacing: SylTheme.Metric.snug) {
            Text("Nothing here yet.")
                .font(SylTheme.Typeface.title)
                .foregroundStyle(SylTheme.Colour.ink)
            Text("Ask her for something, or wait — she starts most mornings.")
                .font(SylTheme.Typeface.detail)
                .foregroundStyle(SylTheme.Colour.inkSoft)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, SylTheme.Metric.gutter)
        .padding(.vertical, SylTheme.Metric.chapter)
        .accessibilityElement(children: .combine)
    }
}

/// "Syl replied" — the pill that appears when something arrives while he is reading
/// history.
///
/// The transcript used to scroll to the newest turn unconditionally, which meant a
/// message landing while he was reading back through yesterday yanked the view out from
/// under him. Auto-scrolling only when he is already at the bottom fixes that, but it
/// leaves a second problem: he now has no idea anything arrived. This is the answer to
/// the second problem, and the two are only correct together.
struct NewTurnPill: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: SylTheme.Metric.snug) {
                Image(systemName: "arrow.down")
                    .font(.system(size: 11, weight: .semibold))
                Text("Syl replied")
                    .font(SylTheme.Typeface.detail)
            }
            .foregroundStyle(SylTheme.Colour.ink)
            .padding(.horizontal, SylTheme.Metric.step)
            .frame(height: SylTheme.Metric.minimumTouchTarget)
            .sylGlass(radius: SylTheme.Metric.minimumTouchTarget / 2, presence: 0.85)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Syl replied. Scroll to the newest message.")
    }
}
