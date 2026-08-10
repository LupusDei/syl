import SwiftUI

/// One field. One sentence. Nothing else.
///
/// ## The rule this is built to obey
///
/// Proposal B:
///
/// > **They die at capture, not at review.** Every field a human must fill in is a tax
/// > collected at the moment of lowest motivation.
///
/// So there is no date picker, no goal selector, no priority, no category, no tag and no
/// list to choose. Not as an omission to be filled in later — as *the design*. `plan.md`
/// R5 names the failure directly: the moment this grows a second control it becomes the
/// thing proposal B exists to prevent.
///
/// The refusal is **structural rather than disciplined**, which is the only kind that
/// survives. ``LocalStore/createTodo(text:idempotencyKey:now:id:)`` takes a string and an
/// instant and has no parameter for a date or a goal, so there is nothing here for a
/// second control to be wired to. Someone adding a date picker would have to widen the
/// store first, in a file with its own tests saying why it is narrow.
///
/// ## No confirmation step and no inbox
///
/// > An explicit ask is never provisional.
///
/// The row exists the moment he commits — `open`, not `proposed`, on disk and in the
/// outbox in one transaction. There is no "added to inbox" toast, no undo bar, no triage
/// queue. A capture he has to confirm is a capture he has to think about twice, and the
/// whole point is that writing it down costs less than remembering it.
///
/// What that costs is a wrong word being written down. That is the right trade: a wrong
/// to-do is a line he edits or finishes; a confirmation step is a tax on every correct
/// one.
///
/// ## Where it lives
///
/// The foot of the day and the head of the list, so the thing he most often wants to do
/// is never more than one tap from where he already is.
struct CaptureField: View {
    /// Called with the trimmed sentence. **Never called with nothing** — see
    /// ``sentence(from:)``.
    var onCapture: (String) -> Void

    /// Starts focused. False everywhere except a surface whose only purpose is capture.
    var focusOnAppear: Bool = false

    @State private var draft: String = ""
    @FocusState private var isFocused: Bool

    /// What a commit would actually write, or `nil` if it would write nothing.
    ///
    /// Pure and `static` so the rule is testable without building a view — this is T015,
    /// and "a stray tap must not leave a blank row in his list forever" is a behaviour,
    /// not a styling choice.
    ///
    /// The store enforces the same rule and throws `LocalStoreError.emptyCapture`. Both
    /// halves are deliberate: the store's guard is the one that cannot be bypassed, and
    /// this one is what keeps the control visibly inert so he is never invited to tap
    /// something that will refuse him.
    static func sentence(from raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private var armed: Bool { Self.sentence(from: draft) != nil }

    var body: some View {
        HStack(alignment: .center, spacing: SylTheme.Metric.step) {
            field
            CommitControl(
                isArmed: armed,
                symbol: "plus",
                label: "Write it down",
                disabledHint: "Type something first",
                action: commit
            )
        }
        .onAppear {
            guard focusOnAppear else { return }
            isFocused = true
        }
    }

    private var field: some View {
        // Single line, deliberately. A `TextField` with `axis: .vertical` swallows the
        // return key as a newline, and then `onSubmit` never fires — which would leave
        // the disc as the only way to commit. One sentence does not need to wrap, and
        // the return key is the fastest commit on the device.
        TextField(
            "",
            text: $draft,
            prompt: Text("Write something down").foregroundStyle(SylTheme.Colour.inkFaint)
        )
        .textFieldStyle(.plain)
        .font(SylTheme.Typeface.Prose.body)
        .foregroundStyle(SylTheme.Colour.ink)
        .tint(SylTheme.Colour.luminance)
        .submitLabel(.done)
        .onSubmit(commit)
        .padding(.horizontal, SylTheme.Metric.step)
        .padding(.vertical, SylTheme.Metric.snug + 2)
        .frame(minHeight: SylTheme.Metric.minimumTouchTarget)
        .sylGlass(radius: 18, presence: 0.4)
        .focused($isFocused)
        .accessibilityLabel("New to-do")
        .accessibilityHint("One sentence. It is written the moment you commit.")
    }

    /// Write it, clear the field, and stay where he is.
    ///
    /// Focus is kept on purpose. Capture arrives in runs — three things remembered on the
    /// way to the car — and dismissing the keyboard after each one turns a run into three
    /// separate journeys back to the field.
    private func commit() {
        guard let sentence = Self.sentence(from: draft) else {
            // A stray tap on the return key. Nothing is written, and nothing is *said*
            // about nothing being written: an error for an empty commit would be the app
            // scolding him for a gesture that meant nothing.
            return
        }
        onCapture(sentence)
        draft = ""
        isFocused = true
    }
}

#Preview("Empty") {
    ZStack {
        SylTheme.Veil()
        CaptureField(onCapture: { _ in })
            .padding(SylTheme.Metric.gutter)
    }
}
