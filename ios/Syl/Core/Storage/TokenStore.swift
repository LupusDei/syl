import Foundation
import Security
import SylKit

/// Holds the bearer token.
///
/// A protocol rather than a concrete type so the notification and registration paths
/// can be tested without a Keychain — a unit test target on a simulator does not
/// reliably have one, and a test that silently skips because
/// `errSecMissingEntitlement` came back is worse than no test.
protocol TokenStore: Sendable {
    func read() -> String?
    func write(_ token: String)
    func clear()
}

/// The real one.
///
/// **The Keychain and not `UserDefaults`,** which is not a style preference: a
/// `UserDefaults` plist is readable by anything that can read the app container,
/// travels into every unencrypted backup, and is the difference between losing a
/// phone and losing the Commander's assistant.
///
/// ## The two accessibility decisions, and what each one costs
///
/// `kSecAttrAccessibleAfterFirstUnlock` and not `WhenUnlocked`: reminders arrive at
/// 07:00 and the ack that marks one delivered may run while the phone is still in a
/// pocket. A token the app cannot read until the Commander unlocks the device would
/// turn "delivered" into "delivered eventually, if he happens to look".
///
/// `…ThisDeviceOnly`, so the item is excluded from backups and does not migrate. The
/// three cases this is really about:
///
/// - **Reinstall from TestFlight.** Keychain items survive deleting an app, so the
///   token is still here and the app comes back already paired. That is the good
///   outcome and it is preserved — `ThisDeviceOnly` changes nothing about it. What it
///   cannot promise is that the token is still *valid*, which is why
///   `AppDelegate.verifyPairing` asks.
/// - **Restore onto a new phone.** The token does not come with it, and the new
///   device pairs for itself. That is correct rather than inconvenient: a device
///   token names a device, and the paired-devices list on the server should mean
///   something. Re-pairing is now a screen and eight digits, so the cost is small.
/// - **A backup that outlives the phone.** A migratable credential in an old backup
///   is a live credential in whatever eventually reads that backup. This one is not
///   in it at all.
///
/// Deliberately **not** `kSecAttrSynchronizable`. iCloud Keychain sync would put a
/// bearer token for the Commander's private tailnet onto every device on his Apple
/// ID, including ones that were never paired and are not on the tailnet.
struct KeychainTokenStore: TokenStore {
    private let service: String
    private let account: String

    init(service: String = "com.jmm.syl", account: String = "bearer-token") {
        self.service = service
        self.account = account
    }

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    func read() -> String? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data
        else {
            return nil
        }
        return String(decoding: data, as: UTF8.self)
    }

    func write(_ token: String) {
        // Delete-then-add rather than update: an update against a partially-written
        // item fails in ways that are tedious to distinguish, and there is exactly one
        // token.
        SecItemDelete(baseQuery as CFDictionary)

        var query = baseQuery
        query[kSecValueData as String] = Data(token.utf8)
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(query as CFDictionary, nil)
    }

    func clear() {
        SecItemDelete(baseQuery as CFDictionary)
    }
}

/// An in-memory store, for tests and for a simulator with no usable Keychain.
final class InMemoryTokenStore: TokenStore, @unchecked Sendable {
    private let lock = NSLock()
    private var token: String?

    init(token: String? = nil) {
        self.token = token
    }

    func read() -> String? { lock.withLock { token } }

    func write(_ token: String) { lock.withLock { self.token = token } }

    func clear() { lock.withLock { token = nil } }
}

/// Bridges a `TokenStore` to the thing SylKit asks for.
struct TokenStoreProvider: TokenProviding {
    let store: any TokenStore

    func token() async -> String? { store.read() }
}
