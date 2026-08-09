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
/// `kSecAttrAccessibleAfterFirstUnlock` and not `WhenUnlocked`: reminders arrive at
/// 07:00 and the ack that marks one delivered may run while the phone is still in a
/// pocket. A token the app cannot read until the Commander unlocks the device would
/// turn "delivered" into "delivered eventually, if he happens to look".
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
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
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
