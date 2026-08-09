import SwiftUI
import SylKit
import UIKit

/// The app delegate exists for exactly one reason: APNs hands the device token to a
/// delegate method and there is no SwiftUI equivalent.
///
/// Everything it touches reads its configuration from `UserDefaults` rather than from
/// app state, because this object runs on launch paths where app state does not exist
/// yet — a cold start from a notification, a background wake. Adjutant read the base
/// URL from app state here, found nothing, fell back to a default, and registered its
/// device token against `localhost`. Every push failed afterwards, silently.
@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate, ObservableObject {
    /// Built from `UserDefaults` and the Keychain, both of which are available before
    /// anything else is.
    private lazy var backend = SylBackend(tokens: KeychainTokenStore())
    private(set) lazy var notifications = NotificationService(backend: backend)
    private lazy var registrar = PushRegistrationService(backend: backend)

    /// The device's copy of Syl. Optional because a database that cannot be opened is
    /// a real state — a full disk, a corrupt file — and the app should still show the
    /// status screen and say so rather than refuse to launch.
    private(set) var store: LocalStore?
    private(set) var chat: ChatViewModel?
    private var syncEngine: SyncEngine?
    private var socket: WebSocketClient?
    private var socketPump: Task<Void, Never>?

    /// The last registration outcome, so the app can be honest about it rather than
    /// pretending push works.
    @Published private(set) var registration: RegistrationState = .idle

    enum RegistrationState: Equatable, Sendable {
        case idle
        case registering
        case registered(tokenSuffix: String, environment: PushEnvironment)
        case failed(String)
    }

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = notifications
        notifications.registerCategories()
        notifications.refreshAuthorization()
        notifications.requestAuthorization {
            application.registerForRemoteNotifications()
        }
        openStore()
        return true
    }

    /// Opens the database and hangs everything that reads from it off the result.
    ///
    /// Deliberately *before* anything talks to the network. The UI's source of truth is
    /// the disk, and the first frame after launch renders from it — a sequence that
    /// waited on a connection would be the spinner this design exists to remove.
    private func openStore() {
        guard let database = try? SylDatabase.onDisk() else { return }

        let store = LocalStore(database: database)
        let outbox = Outbox(database: database)
        let engine = SyncEngine(
            store: store,
            outbox: outbox,
            gateway: .live(backend: backend)
        )
        let socket = WebSocketClient(
            configuration: ServerConfiguration(baseURL: backend.baseURL),
            tokenProvider: TokenStoreProvider(store: KeychainTokenStore()),
            lastSeq: (try? store.syncState().lastFrameSeq) ?? 0
        )

        let chat = ChatViewModel(
            store: store,
            sendOverSocket: { text, clientId, key in
                try await socket.send(
                    text: text,
                    conversationId: SylIDs.interactiveConversation,
                    clientId: clientId,
                    idempotencyKey: key
                )
            },
            flush: { await engine.synchronise() }
        )

        self.store = store
        self.syncEngine = engine
        self.socket = socket
        self.chat = chat

        startSocket(socket, feeding: chat, store: store)
        Task { await engine.synchronise() }
    }

    /// Pumps socket events into the chat model, and keeps the frame-stream high-water
    /// mark on disk so a relaunch resumes where the socket left off.
    private func startSocket(
        _ socket: WebSocketClient,
        feeding chat: ChatViewModel,
        store: LocalStore
    ) {
        socketPump?.cancel()
        socketPump = Task { [weak self] in
            let events = await socket.events()
            await socket.start()

            for await event in events {
                await chat.apply(event)

                if case .needsHTTPSync = event {
                    // The gap is older than the replay buffer. The socket cannot fill
                    // it; only the durable cursor can.
                    await self?.syncEngine?.synchronise()
                }
                let seq = await socket.lastSeq
                try? store.setLastFrameSeq(seq)
            }
        }
    }

    /// Foreground reconcile. Push collapses a night of notifications into one and
    /// Apple offers no way to ask what arrived, so this is where anything that was
    /// dropped or coalesced reappears.
    func synchroniseNow() async {
        await syncEngine?.synchronise()
        await chat?.refresh()
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        registration = .registering

        let name = UIDevice.current.name
        let osVersion = UIDevice.current.systemVersion
        let registrar = registrar

        Task { @MainActor in
            do {
                let device = try await registrar.register(
                    deviceToken: deviceToken,
                    name: name,
                    osVersion: osVersion
                )
                registration = .registered(
                    tokenSuffix: device.tokenSuffix,
                    environment: device.environment
                )
            } catch {
                // Not fatal and not silent. Push is the last mile of the delivery
                // guarantee, and an app that cannot register should say so rather than
                // look healthy while every reminder goes nowhere.
                registration = .failed(Self.describe(error))
            }
        }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        registration = .failed(error.localizedDescription)
    }

    private static func describe(_ error: Error) -> String {
        (error as? APIError)?.errorDescription ?? error.localizedDescription
    }
}
