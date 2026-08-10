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
    /// The one Keychain handle.
    ///
    /// It used to be constructed in three places, which was harmless only because
    /// nothing ever wrote to it (`syl-q1f`). Now that pairing does, three handles
    /// would mean three objects that have to agree about when the token changed.
    private let tokens: any TokenStore

    /// Built from `UserDefaults` and the Keychain, both of which are available before
    /// anything else is.
    private lazy var backend = SylBackend(tokens: tokens)
    private(set) lazy var notifications = NotificationService(backend: backend)
    private lazy var registrar = PushRegistrationService(backend: backend)

    /// Whether this device holds a credential at all.
    ///
    /// The gate on the whole app: without a token every request goes out with no
    /// `Authorization` header, the socket answers `.unauthenticated` and stops, and
    /// the app is inert against a real backend while looking perfectly healthy. That
    /// was the bug. Showing the pairing screen instead is the fix.
    @Published private(set) var isPaired: Bool

    override init() {
        let tokens = KeychainTokenStore()
        self.tokens = tokens
        // Read once, synchronously, before any view exists. A Keychain item survives
        // deleting the app, so a reinstall from TestFlight normally comes back already
        // paired — which is the good case, and is why `verifyPairing` exists to catch
        // the bad one rather than making every launch re-pair defensively.
        self.isPaired = tokens.read() != nil
        super.init()
    }

    /// Convenience for tests and previews, which have no Keychain worth speaking of.
    init(tokens: any TokenStore) {
        self.tokens = tokens
        self.isPaired = tokens.read() != nil
        super.init()
    }

    /// The device's copy of Syl. Optional because a database that cannot be opened is
    /// a real state — a full disk, a corrupt file — and the app should still show the
    /// status screen and say so rather than refuse to launch.
    private(set) var store: LocalStore?
    private(set) var chat: ChatViewModel?
    /// The home screen's model. Holds its own `PresenceTimeline` rather than reading
    /// chat's, because chat keeps the raw frame state and never decays it.
    private(set) var home: HomeViewModel?
    private var syncEngine: SyncEngine?
    /// Answers for anything push accepted but never showed. See `syl-u9e`.
    private var deliveryReconciler: DeliveryReconciler?
    private var socket: WebSocketClient?
    private var socketPump: Task<Void, Never>?
    /// The base URL the live socket was opened against. Compared on foreground so a
    /// server-profile change moves the socket too — `SylBackend` re-reads the URL for
    /// every HTTP call, but a socket is a long-lived thing and would otherwise keep
    /// hammering the host the Commander switched away from.
    private var socketBaseURL: URL?

    /// What a chat bubble needs in order to fetch a picture.
    ///
    /// Computed on every read rather than cached, for the same reason `SylBackend`
    /// rebuilds its client on every call: the paired base URL lives in `UserDefaults`
    /// and can change under the app. A cached `AttachmentSource` would be a copy of the
    /// origin as it was at launch, and the failure mode is not a broken image — it is
    /// the origin guard refusing every attachment from the server the Commander just
    /// switched to, which reads as a security alarm when it is a stale value.
    var attachmentContext: AttachmentContext {
        AttachmentContext(
            source: AttachmentSource(baseURL: backend.baseURL),
            fetcher: AuthenticatedAttachmentFetcher(tokens: tokens)
        )
    }

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
            tokenProvider: TokenStoreProvider(store: tokens),
            lastSeq: (try? store.syncState().lastFrameSeq) ?? 0,
            // Restored together. A mark without the run it came from is `syl-47j` one
            // launch later: the socket compares it against a stream that never issued
            // it, concludes it is caught up, and discards everything that follows.
            serverEpoch: (try? store.syncState().serverEpoch) ?? nil
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

        // The other half of the delivery guarantee. `deliveredAt` only ever means APNs
        // accepted the request, and Apple keeps just the most recent notification per
        // app while a device is offline — so a night of reminders reaches the phone as
        // one. This is what finds the rest.
        let reconciler = DeliveryReconciler(
            outbox: outbox,
            fetch: DeliveryReconciler.liveFetch(backend: backend),
            presenter: notifications.deliveryPresenter,
            flush: { await engine.synchronise() }
        )

        let home = HomeViewModel(store: store)

        self.store = store
        self.syncEngine = engine
        self.deliveryReconciler = reconciler
        self.socket = socket
        self.socketBaseURL = backend.baseURL
        self.chat = chat
        self.home = home

        // Notification actions write to the outbox rather than calling the network, so
        // a snooze tapped while the tailnet is down survives.
        notifications.attach(outbox: outbox) { await engine.synchronise() }

        startSocket(socket, feeding: chat, home: home, store: store)
        Task { await self.reconcile() }
    }

    /// Drain the outbox, then answer for everything the server is still waiting on.
    ///
    /// The order is not arbitrary. Pushing first means any acknowledgement he already
    /// made — a notification tapped while the tunnel was down — reaches the server
    /// before we ask what is outstanding, so the reconcile does not re-surface a
    /// reminder he has already dealt with.
    private func reconcile() async {
        await syncEngine?.synchronise()
        await deliveryReconciler?.reconcile()
    }

    /// Pumps socket events into the chat model, and keeps the frame-stream high-water
    /// mark on disk so a relaunch resumes where the socket left off.
    private func startSocket(
        _ socket: WebSocketClient,
        feeding chat: ChatViewModel,
        home: HomeViewModel,
        store: LocalStore
    ) {
        socketPump?.cancel()
        socketPump = Task { [weak self] in
            let events = await socket.events()
            await socket.start()

            let restored = try? store.syncState()
            var persisted: (seq: Int, epoch: String?) =
                (restored?.lastFrameSeq ?? 0, restored?.serverEpoch)

            for await event in events {
                await chat.apply(event)
                home.apply(event)

                if case .needsHTTPSync = event {
                    // The gap is older than the replay buffer. The socket cannot fill
                    // it; only the durable cursor can.
                    await self?.syncEngine?.synchronise()
                }

                // Only when it actually moved, and off the main actor. Presence and
                // connection-state events do not advance the mark at all, and a
                // synchronous SQLite write per frame during a `speaking` burst is a
                // main-thread stall on the busiest path in the app.
                //
                // **The epoch is part of "moved".** A restarted server resets the mark
                // to zero and names a new run; watching the number alone would miss
                // the reconnect where the mark happens to land back on the same value,
                // and the row would keep pointing at a run that has ended.
                let seq = await socket.lastSeq
                let epoch = await socket.serverEpoch
                guard (seq, epoch) != persisted else { continue }
                persisted = (seq, epoch)
                await Task.detached(priority: .utility) {
                    try? store.setLastFrameSeq(seq, serverEpoch: epoch)
                }.value
            }
        }
    }

    // MARK: - Pairing

    /// A pairing succeeded. Take the credential and start behaving like a paired app.
    ///
    /// **Order is load-bearing and every step of it has a failure attached.** The
    /// profile is selected before the token is stored, because `SylBackend` reads the
    /// base URL from `UserDefaults` on every call: storing first leaves a window where
    /// the app holds the new token and is still pointed at the old server. The socket
    /// is rebuilt last, because it captured both.
    func completePairing(grant: TokenGrant, profile: ServerProfile, profiles: ServerProfileStore) {
        profiles.add(profile)
        profiles.select(profile)
        tokens.write(grant.token)
        isPaired = true

        // The socket was opened at launch against no credential and gave up
        // immediately. Nothing prompts it to try again on its own — that is what left
        // `WebSocketClient` returning `.unauthenticated` forever.
        rebuildSocket()
        Task { await self.reconcile() }
    }

    /// Check on launch whether the stored token is still a credential.
    ///
    /// This is the case the Keychain surviving a reinstall creates. The token comes
    /// back from before the app was deleted, and it may be perfectly good — usually
    /// it is — or it may have been revoked, or the store it was minted against may
    /// have been rebuilt. Both look identical from here until something is asked.
    ///
    /// `whoami` is the cheapest possible authenticated call and exists for exactly
    /// this. **The distinction it draws is the whole point**: a refusal means the
    /// token is dead and the Commander must re-pair; a transport failure means the
    /// tunnel is still coming up, which under Tailscale is routine after a wake.
    /// Treating the second as the first would send him to a pairing screen every time
    /// his phone came out of his pocket, which is worse than not checking at all.
    func verifyPairing() async {
        guard isPaired else { return }
        do {
            _ = try await backend.client().send(SylAPI.whoami())
        } catch let error as APIError where error.requiresReauthentication {
            tokens.clear()
            isPaired = false
        } catch {
            // Unreachable, or something else answered. Keep the token: the app works
            // from disk, and the next foreground tries again.
        }
    }

    /// What the admin WebView is given, and nothing besides.
    ///
    /// This is the **only** place in the app that hands out the raw bearer token
    /// rather than a client with it already attached, and it is written as two named
    /// closures so that stays visible. See `AdminConsoleViewModel` for what is done
    /// with it and `AdminNavigationPolicy` for the condition it is done under.
    ///
    /// `verify` is the same `whoami` call as `verifyPairing`, and draws the same
    /// distinction — but it deliberately does **not** clear the token on a refusal.
    /// Opening a debug screen is not a reason to un-pair the app; the screen says the
    /// credential was rejected, and `verifyPairing` on the next foreground is what acts
    /// on it.
    var adminConsoleAccess: AdminConsoleAccess {
        let tokens = self.tokens
        let backend = self.backend
        return AdminConsoleAccess(
            readCredential: { tokens.read() },
            verify: {
                do {
                    _ = try await backend.client().send(SylAPI.whoami())
                    return .authenticated
                } catch let error as APIError where error.requiresReauthentication {
                    return .rejected
                } catch let error as APIError {
                    return .unreachable(error.errorDescription ?? error.localizedDescription)
                } catch {
                    return .unreachable(error.localizedDescription)
                }
            }
        )
    }

    /// Foreground reconcile. Push collapses a night of notifications into one and
    /// Apple offers no way to ask what arrived, so this is where anything that was
    /// dropped or coalesced reappears.
    ///
    /// It reappears through `DeliveryReconciler`, and until `syl-u9e` it did not
    /// reappear at all: this method synchronised resources and nothing ever asked the
    /// server which deliveries were still unacknowledged, so a push Apple accepted and
    /// never showed was closed forever.
    func synchroniseNow() async {
        rebuildSocketIfServerChanged()
        await reconcile()
        await chat?.refresh()
    }

    /// Reopens the socket when the selected server profile has moved.
    ///
    /// HTTP follows the change on its own because `SylBackend` reads `UserDefaults`
    /// per call. A socket cannot: it is one long-lived connection to one host, so the
    /// only way to follow is to open a new one.
    private func rebuildSocketIfServerChanged() {
        guard socketBaseURL != nil, socketBaseURL != backend.baseURL else { return }
        rebuildSocket()
    }

    /// Close the socket and open a new one against whatever is current now.
    ///
    /// Separate from the "if the server changed" check because pairing needs it
    /// unconditionally: the URL may be identical — pairing against the mock, or
    /// re-pairing the same Mac — and the connection still has to be remade, because
    /// what changed is the credential it presents.
    private func rebuildSocket() {
        guard store != nil else { return }
        let socket = self.socket
        socketPump?.cancel()
        socketPump = nil
        Task { await socket?.stop() }
        self.socket = nil
        self.socketBaseURL = nil
        openSocket()
    }

    private func openSocket() {
        guard let store, let chat, let home, socket == nil else { return }
        let socket = WebSocketClient(
            configuration: ServerConfiguration(baseURL: backend.baseURL),
            tokenProvider: TokenStoreProvider(store: tokens),
            lastSeq: (try? store.syncState().lastFrameSeq) ?? 0,
            // Restored together. A mark without the run it came from is `syl-47j` one
            // launch later: the socket compares it against a stream that never issued
            // it, concludes it is caught up, and discards everything that follows.
            serverEpoch: (try? store.syncState().serverEpoch) ?? nil
        )
        self.socket = socket
        self.socketBaseURL = backend.baseURL
        startSocket(socket, feeding: chat, home: home, store: store)
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
