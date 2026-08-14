import Foundation

/// The composer's live text, on its own.
///
/// ## Why this is a whole object for one string
///
/// It was `@Published var draft` on `ChatViewModel`. SwiftUI invalidates a view when any
/// `@Published` property of an object it observes changes — not only the ones the view
/// reads — and `ChatView` observes the view model for the transcript, the presence ribbon
/// and the connection banner. So every character he typed invalidated `ChatView.body` and
/// the entire `LazyVStack` under it, and it was measured rebuilding twenty to thirty
/// transcript rows per keystroke.
///
/// **Nothing he types is about the transcript.** Splitting the string onto its own
/// observable is what makes that true structurally rather than by careful arrangement:
/// the view model holds this as a plain `let`, and reading a `let` creates no
/// subscription, so `ChatView` can pass it to the composer without ever hearing from it.
///
/// The alternative — `@State` inside `ChatComposer` — is a smaller change and a worse one.
/// The send path needs the text, the send path lives on the view model, and a draft that
/// only the view knows about has to be handed back through a closure on every keystroke or
/// read out of the view at send time. It also puts the one piece of state a test needs to
/// drive somewhere no test can reach.
@MainActor
final class ChatDraft: ObservableObject {
    @Published var text = ""

    init(_ text: String = "") {
        self.text = text
    }
}
