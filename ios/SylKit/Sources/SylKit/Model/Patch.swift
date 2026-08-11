import Foundation

/// A field in a PATCH body, which has three states rather than two.
///
/// `T?` cannot express the difference between "leave this alone" and "clear it",
/// and for a to-do that difference is the whole operation: unlinking a goal and
/// dropping a due date are things the Commander will actually do. Modelling it as
/// an optional would silently turn both into no-ops.
///
/// Encoding is the parent's job — see `encodePatch(_:forKey:)` — because omitting a
/// key is a decision the keyed container makes, not the value.
public enum Patch<Value: Codable & Equatable & Sendable>: Equatable, Sendable {
    /// Omit the key. The server leaves the field alone.
    case unchanged
    /// Send the value.
    case set(Value)
    /// Send an explicit null. The server clears the field.
    case clear

    public var isUnchanged: Bool {
        if case .unchanged = self { return true }
        return false
    }
}

extension KeyedEncodingContainer {
    /// Encodes a `Patch`, omitting the key entirely when it is `.unchanged`.
    mutating func encodePatch<Value>(_ patch: Patch<Value>, forKey key: Key) throws {
        switch patch {
        case .unchanged: return
        case .set(let value): try encode(value, forKey: key)
        case .clear: try encodeNil(forKey: key)
        }
    }
}

extension KeyedDecodingContainer {
    /// Decodes a `Patch`: absent is `.unchanged`, null is `.clear`, anything else is
    /// `.set`. Present so a queued outbox row can be re-read from disk unchanged.
    func decodePatch<Value>(_ type: Value.Type, forKey key: Key) throws -> Patch<Value> {
        guard contains(key) else { return .unchanged }
        if try decodeNil(forKey: key) { return .clear }
        return .set(try decode(Value.self, forKey: key))
    }
}
