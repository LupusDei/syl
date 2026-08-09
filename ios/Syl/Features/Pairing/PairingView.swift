import SwiftUI
import SylKit

/// The first screen of a freshly installed app, and — if everything works — the last
/// time it is ever seen.
///
/// Two fields, because two things are unknown: where the Mac is, and the eight digits
/// proving the person holding the phone is the person at the Mac. Neither can be
/// baked in. The address cannot, because a tailnet hostname is per-machine; the
/// credential cannot, because a credential in a TestFlight build is a credential in
/// everyone's hands.
///
/// The failure area is the part worth defending in review. It renders one of four
/// distinct outcomes with a *specific next action*, rather than a spinner that stops
/// and a red word — see `PairingViewModel.Failure`.
struct PairingView: View {
    /// **`@StateObject`, and this is not interchangeable with `@ObservedObject`.**
    ///
    /// The parent builds this model from the app delegate and the profile store, so
    /// the obvious shape is a computed property handed in as `PairingView(model:)`.
    /// That shape is a bug with no error message: the parent's body re-evaluates
    /// whenever anything it observes publishes — push registration finishing, the
    /// network monitor noticing Wi-Fi, a scene-phase change — and each evaluation
    /// would construct a *fresh* model and hand it to an `@ObservedObject`. The
    /// hostname and the eight digits he was halfway through typing vanish, at a
    /// moment unrelated to anything he did.
    ///
    /// `@StateObject` evaluates its autoclosure exactly once for the lifetime of the
    /// view, so the model outlives every one of those re-renders.
    @StateObject private var model: PairingViewModel
    @FocusState private var focus: Field?

    init(
        serverEntry: String,
        deviceName: String,
        onPaired: @escaping (ServerProfile, TokenGrant) -> Void
    ) {
        _model = StateObject(
            wrappedValue: PairingViewModel(
                serverEntry: serverEntry,
                deviceName: deviceName,
                onPaired: onPaired
            )
        )
    }

    private enum Field: Hashable { case server, code }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("your-mac.tail0000.ts.net", text: $model.serverEntry)
                        .textContentType(.URL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused($focus, equals: .server)
                } header: {
                    Text("Server")
                } footer: {
                    Text("Whatever `npm run pair` printed. The full URL works too.")
                }

                Section {
                    TextField("4821-9930", text: $model.code)
                        .keyboardType(.numberPad)
                        .textContentType(.oneTimeCode)
                        .focused($focus, equals: .code)
                        .monospaced()
                } header: {
                    Text("Pairing code")
                } footer: {
                    Text("""
                        Run `npm run pair` on the Mac. The code lasts ten minutes and \
                        pairs one device.
                        """)
                }

                if let failure = model.failure {
                    Section {
                        // A label rather than an alert: an alert is dismissed and gone,
                        // and this is a thing to read while retyping.
                        Label {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(failure.title).font(.headline)
                                Text(failure.recovery)
                                    .font(.callout)
                                    .foregroundStyle(.secondary)
                            }
                        } icon: {
                            Image(systemName: icon(for: failure))
                                .foregroundStyle(.orange)
                        }
                    }
                }

                Section {
                    Button {
                        Task { await pair() }
                    } label: {
                        HStack {
                            Text(isPairing ? "Pairing…" : "Pair this device")
                            if isPairing {
                                Spacer()
                                ProgressView()
                            }
                        }
                    }
                    .disabled(!model.canSubmit)
                }
            }
            .navigationTitle("Connect to Syl")
            .onAppear { focus = model.serverEntry.isEmpty ? .server : .code }
        }
    }

    private var isPairing: Bool {
        if case .pairing = model.state { return true }
        return false
    }

    private func pair() async {
        await model.pair()
        // Put the cursor back where the fix is. Small, and it is most of what makes
        // the difference between a screen that helps and a screen that just refuses.
        if let failure = model.failure {
            focus = failure.isAboutTheCode ? .code : .server
        }
    }

    /// Distinct glyphs, because the four outcomes are four situations.
    private func icon(for failure: PairingViewModel.Failure) -> String {
        switch failure {
        case .unreachable: return "wifi.exclamationmark"
        case .expiredCode: return "clock.badge.exclamationmark"
        case .alreadyUsedCode: return "checkmark.seal.fill"
        case .somethingElseAnswered: return "questionmark.circle"
        case .malformedCode, .incorrectCode, .unusableServer: return "exclamationmark.triangle"
        }
    }
}
