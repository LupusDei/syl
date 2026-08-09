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
        return true
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
