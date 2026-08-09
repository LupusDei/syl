import Foundation
import SylKit
import UIKit

/// Turns an APNs device token into a `RegisterDeviceRequest`.
///
/// Pure, and separate from the service that sends it, because the two things that go
/// wrong here are both decisions rather than I/O: the hex encoding of the token, and
/// which APNs environment it belongs to.
enum PushRegistration {
    /// APNs hands the token over as raw bytes and every server on earth wants lower
    /// case hex. Getting this wrong produces `BadDeviceToken` and nothing else.
    static func hexEncode(_ token: Data) -> String {
        token.map { String(format: "%02x", $0) }.joined()
    }

    /// Which APNs environment this build's tokens belong to.
    ///
    /// **Carried per token, never as a global setting.** A TestFlight or App Store
    /// build always produces `production` tokens; an Xcode-installed build always
    /// produces `sandbox`. During development both exist at once, so a single
    /// server-wide setting breaks one of them — and the only symptom is
    /// `BadDeviceToken` on every send.
    ///
    /// It is derived from the build configuration rather than read from a plist,
    /// because a plist can disagree with the thing that actually signed the binary.
    /// Adjutant's entitlement said `development` while it shipped through TestFlight;
    /// it worked only because an environment variable elsewhere happened to be right.
    static var environment: PushEnvironment {
        #if DEBUG
            return .sandbox
        #else
            return .production
        #endif
    }

    static func request(
        token: Data,
        name: String,
        appVersion: String,
        osVersion: String,
        environment: PushEnvironment = PushRegistration.environment
    ) -> RegisterDeviceRequest {
        RegisterDeviceRequest(
            token: hexEncode(token),
            environment: environment,
            platform: .ios,
            name: name,
            appVersion: appVersion,
            osVersion: osVersion
        )
    }

    /// `0.1.0 (14)` — marketing version and build number, because a TestFlight bug
    /// report that says only "0.1.0" cannot be matched to a build.
    static func appVersion(bundle: Bundle = .main) -> String {
        let marketing = bundle.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0"
        let build = bundle.infoDictionary?["CFBundleVersion"] as? String ?? "0"
        return "\(marketing) (\(build))"
    }
}

/// Registers the device with the service.
///
/// Idempotency: the key is derived from the token, so re-registering the same token
/// on every launch replays one stored response rather than writing a row per launch.
/// Re-registering is the correct behaviour — a token can be reissued after a restore
/// — and it must not accumulate.
struct PushRegistrationService: Sendable {
    private let backend: SylBackend

    init(backend: SylBackend) {
        self.backend = backend
    }

    @discardableResult
    func register(
        deviceToken: Data,
        name: String,
        osVersion: String
    ) async throws -> Device {
        let request = PushRegistration.request(
            token: deviceToken,
            name: name,
            appVersion: PushRegistration.appVersion(),
            osVersion: osVersion
        )
        return try await backend.client().send(
            try SylAPI.registerDevice(
                request,
                idempotencyKey: Self.idempotencyKey(for: request)
            )
        )
    }

    /// Same token, same environment, same key. A launch that changes nothing writes
    /// nothing.
    static func idempotencyKey(for request: RegisterDeviceRequest) -> String {
        "device-\(request.environment.rawValue)-\(request.token.suffix(32))"
    }
}
