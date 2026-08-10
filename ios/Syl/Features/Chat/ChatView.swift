import SwiftUI
import SylKit

/// The conversation.
///
/// Renders from `ChatViewModel`, which renders from disk. There is no loading state
/// on the way in, deliberately: the first frame after launch shows his conversation,
/// and anything the network brings arrives on top of it.
struct ChatView: View {
    @ObservedObject var model: ChatViewModel
    @FocusState private var composerFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            if model.isConnectionNoteworthy {
                ConnectionBanner(
                    summary: model.connectionSummary,
                    notice: model.notice
                )
            }

            messageList

            Composer(
                draft: $model.draft,
                isFocused: $composerFocused,
                send: { Task { await model.send() } }
            )
        }
        .navigationTitle("Syl")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.refresh() }
    }

    /// The transcript, which is also the keyboard's dismiss target.
    ///
    /// Two mechanisms rather than one, because they cover different intentions: a drag
    /// means "I want to read what is above", a tap means "I am done typing". Shipping
    /// only the scroll dismissal leaves someone who taps a message stuck behind the
    /// keyboard with no obvious way out, and there is no Done button on a chat composer
    /// to fall back to.
    private var messageList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    if model.snapshot.groups.isEmpty {
                        EmptyConversation()
                    }
                    ForEach(model.snapshot.groups) { group in
                        MessageGroupView(group: group)
                            .id(group.id)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }
            // Drag the transcript, lose the keyboard. `.interactively` rather than
            // `.immediately` so the keyboard tracks the finger and can be pulled back
            // by reversing — the gesture is reversible, which `.immediately` is not.
            .scrollDismissesKeyboard(.interactively)
            // Tap anywhere in the transcript to dismiss.
            //
            // A plain `.onTapGesture` on the ScrollView would swallow taps on the
            // messages themselves, and it competes with the scroll gesture. A
            // simultaneous, zero-distance drag recogniser dismisses without consuming
            // anything: text stays selectable and scrolling is unaffected.
            .simultaneousGesture(
                DragGesture(minimumDistance: 0).onEnded { _ in
                    composerFocused = false
                }
            )
            .onChange(of: model.snapshot.groups.last?.id) { _, id in
                guard let id else { return }
                withAnimation(.easeOut(duration: 0.2)) {
                    proxy.scrollTo(id, anchor: .bottom)
                }
            }
        }
    }
}

/// One run of consecutive messages from the same speaker.
struct MessageGroupView: View {
    let group: MessageGroup

    private var isFromCommander: Bool { group.role == .user }

    var body: some View {
        VStack(alignment: isFromCommander ? .trailing : .leading, spacing: 4) {
            ForEach(group.messages) { message in
                Text(message.text)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(bubbleBackground)
                    .foregroundStyle(isFromCommander ? Color.white : Color.primary)
                    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                    // A pending bubble is visibly unfinished rather than
                    // indistinguishable from a sent one.
                    .opacity(group.isPending ? 0.55 : 1)
                    .frame(maxWidth: .infinity, alignment: isFromCommander ? .trailing : .leading)
            }

            Text(footnote)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: isFromCommander ? .trailing : .leading)
    }

    private var bubbleBackground: Color {
        isFromCommander ? .accentColor : Color(.secondarySystemBackground)
    }

    private var footnote: String {
        let time = group.startedAt.formatted(date: .omitted, time: .shortened)
        return group.isPending ? "\(time) · sending" : time
    }
}

struct EmptyConversation: View {
    var body: some View {
        VStack(spacing: 8) {
            Text("Nothing here yet.")
                .font(.headline)
            Text("Ask her for something, or wait — she starts most mornings.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 48)
    }
}

/// The connection state, said plainly.
///
/// The server genuinely will be unreachable sometimes — the Mac reboots, the tailnet
/// drops on a WiFi-to-cellular handoff, the phone goes through a tunnel. An assistant
/// that silently fails to sync is worse than one that says so.
struct ConnectionBanner: View {
    let summary: String
    let notice: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(summary)
                .font(.footnote.weight(.medium))
            if let notice {
                Text(notice)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(Color(.secondarySystemBackground))
    }
}

struct Composer: View {
    @Binding var draft: String
    var isFocused: FocusState<Bool>.Binding
    let send: () -> Void

    private var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Message", text: $draft, axis: .vertical)
                .lineLimit(1...6)
                .textFieldStyle(.plain)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Color(.secondarySystemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                .focused(isFocused)

            Button(action: send) {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.title2)
            }
            .disabled(!canSend)
            .accessibilityLabel("Send")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.bar)
    }
}
