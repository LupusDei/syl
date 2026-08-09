import Foundation

// MARK: - Identifiers

/// A resource identifier: `syl:<type>:<uuidv7>`.
///
/// Deliberately a plain `String` rather than a wrapper type. The wire carries a
/// string, every store column will hold a string, and a wrapper would buy type
/// safety at the cost of a conversion at every boundary. `SylIDs.isWellFormed`
/// is where the shape is checked, and it is checked in tests rather than on
/// every decode — a server that starts emitting a malformed id is a contract
/// failure, not something the app should try to survive at runtime.
public typealias SylID = String

/// Helpers for the `syl:<type>:<uuidv7>` identifier convention.
public enum SylIDs {
    /// The interactive lane's well-known constant id.
    ///
    /// A client and a server that both use a constant cannot disagree about which
    /// thread a message belongs to. Adjutant reconstructed conversation scope from
    /// sender and recipient, shipped messages into the wrong thread, and paid for
    /// the fix twice — once in the bug and again in the backfill migration.
    public static let interactiveConversation: SylID =
        "syl:conversation:00000000-0000-7000-8000-000000000001"

    /// The resource type embedded in an id, or nil if it is not well formed.
    public static func type(of id: SylID) -> String? {
        let parts = id.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0] == "syl", !parts[1].isEmpty else { return nil }
        return String(parts[1])
    }

    /// Whether an id matches the convention. Mirrors the `Id` pattern in `openapi.yaml`.
    public static func isWellFormed(_ id: SylID) -> Bool {
        let parts = id.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0] == "syl" else { return false }

        let type = parts[1]
        guard let first = type.first, first.isLowercaseASCIILetter else { return false }
        guard type.allSatisfy({ $0.isLowercaseASCIILetter || $0 == "_" }) else { return false }

        return isUUID(parts[2])
    }

    private static func isUUID(_ candidate: Substring) -> Bool {
        let groups = candidate.split(separator: "-", omittingEmptySubsequences: false)
        guard groups.count == 5 else { return false }
        let expected = [8, 4, 4, 4, 12]
        for (group, length) in zip(groups, expected) {
            guard group.count == length, group.allSatisfy({ $0.isHexDigit }) else { return false }
        }
        return true
    }
}

private extension Character {
    var isLowercaseASCIILetter: Bool { self >= "a" && self <= "z" }
}

// MARK: - Wall time and zones

/// 24-hour local wall-clock time, `"07:00"`.
///
/// Carried alongside an IANA `Timezone`. The instant is a materialisation of the
/// next occurrence and never the source of truth — storing only the instant is
/// the fixed-offset bug in a different costume.
public typealias WallTime = String

/// An IANA zone name, `"America/Chicago"`. **Never a fixed UTC offset.**
public typealias Timezone = String

/// A `YYYY-MM-DD` local date, used for one-shot reminders and goal horizons.
public typealias LocalDate = String

// MARK: - Instants

/// The wire representation of an instant: RFC 3339, UTC, millisecond precision,
/// with a literal `Z`.
///
/// Two things here are load-bearing and neither is Foundation's default.
///
/// `JSONDecoder.DateDecodingStrategy.iso8601` **cannot parse fractional seconds**,
/// and every instant in this contract carries them. Using it produces a decoder
/// that fails on every single timestamp the server sends.
///
/// A fixed UTC offset is rejected rather than accepted. An offset is a property of
/// an instant, not of a place; one that reaches a model survives exactly one DST
/// boundary and then moves every recurring reminder by an hour.
public enum Instant {
    /// `2026-08-09T07:00:03.114Z`
    private static let fractional = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
    /// Tolerated on the way in only, for a whole-second instant.
    private static let whole = Date.ISO8601FormatStyle(includingFractionalSeconds: false)

    /// Errors this codec raises. They are deliberately specific: a wrong instant is
    /// invisible until a reminder fires an hour off.
    public enum Failure: Error, Equatable, CustomStringConvertible {
        case notUTC(String)
        case unparseable(String)

        public var description: String {
            switch self {
            case .notUTC(let value):
                return """
                    instant \"\(value)\" is not UTC. Instants are RFC 3339 with a literal Z; \
                    a fixed offset is a property of an instant, not of a place, and survives \
                    exactly one DST boundary.
                    """
            case .unparseable(let value):
                return "instant \"\(value)\" is not RFC 3339 with millisecond precision"
            }
        }
    }

    /// Parses a wire instant. Requires a literal `Z`; accepts a whole-second instant
    /// but always re-emits milliseconds.
    public static func parse(_ value: String) throws -> Date {
        guard value.hasSuffix("Z") else { throw Failure.notUTC(value) }
        if let date = try? Date(value, strategy: fractional) { return date }
        if let date = try? Date(value, strategy: whole) { return date }
        throw Failure.unparseable(value)
    }

    /// Formats an instant the way the contract specifies: UTC, three fractional digits.
    ///
    /// The milliseconds are computed and rendered here rather than handed to
    /// `ISO8601FormatStyle(includingFractionalSeconds: true)`, because that style
    /// **truncates**. `2026-08-09T07:00:03.114Z` parses to a `Date` whose binary
    /// representation is a hair under `.114`, and formatting it back yields `.113` —
    /// a silent one-millisecond loss on every single round trip.
    ///
    /// It is invisible in a UI and fatal in a contract: the round-trip half of the
    /// fixture gate compares strings, and a reminder's `scheduledFor` that drifts a
    /// millisecond every time it passes through the client is the sort of thing that
    /// shows up much later as an off-by-one in a deduplication key.
    public static func format(_ date: Date) -> String {
        let epochMilliseconds = (date.timeIntervalSince1970 * 1000).rounded()
        let seconds = (epochMilliseconds / 1000).rounded(.down)
        let milliseconds = Int(epochMilliseconds - seconds * 1000)

        let whole = Self.whole.format(Date(timeIntervalSince1970: seconds))
        return String(whole.dropLast()) + String(format: ".%03dZ", milliseconds)
    }
}

// MARK: - Untyped JSON

/// A decoded JSON value, for the two places the contract is deliberately open:
/// `ApiError.details` and `SyncChange.resource`.
///
/// Both are `additionalProperties: true` in the spec, so a typed model would be a
/// guess. Keeping them as data means an error renderer can show `details` without
/// the client having to know every shape the server might put there, and a sync
/// change can be re-decoded into the model named by its `type`.
public enum JSONValue: Codable, Hashable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
        } else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "not a JSON value"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }

    /// The value at a top-level key, when this is an object.
    public subscript(key: String) -> JSONValue? {
        guard case .object(let members) = self else { return nil }
        return members[key]
    }
}

// MARK: - Coding helpers

extension KeyedDecodingContainer {
    /// Decodes a field the contract marks **required and nullable**.
    ///
    /// This is not `decodeIfPresent`, and the difference is the whole point. `T?`
    /// with the synthesised decoder tolerates an *absent* key, so a server that
    /// stopped sending a field would decode cleanly into `nil` and the app would
    /// quietly render as though the field were null. The key must be there; `null`
    /// is a legitimate value and an omission is a contract violation.
    func decodeRequiredNullable<T: Decodable>(_ type: T.Type, forKey key: Key) throws -> T? {
        guard contains(key) else {
            throw DecodingError.keyNotFound(
                key,
                DecodingError.Context(
                    codingPath: codingPath,
                    debugDescription: """
                        \"\(key.stringValue)\" is required and nullable — the key must be \
                        present, with an explicit null if it has no value.
                        """
                )
            )
        }
        if try decodeNil(forKey: key) { return nil }
        return try decode(T.self, forKey: key)
    }

    /// Decodes an instant that is required and nullable.
    func decodeRequiredNullableInstant(forKey key: Key) throws -> Date? {
        try decodeRequiredNullable(Date.self, forKey: key)
    }
}

extension KeyedEncodingContainer {
    /// Encodes a field the contract marks **required and nullable**, writing an
    /// explicit `null` rather than omitting the key.
    ///
    /// The synthesised encoder uses `encodeIfPresent` for `T?` and drops the key
    /// entirely when the value is nil. Decoding never notices; the difference only
    /// appears on the way out, which is why the contract suite round-trips.
    mutating func encodeRequiredNullable<T: Encodable>(_ value: T?, forKey key: Key) throws {
        if let value {
            try encode(value, forKey: key)
        } else {
            try encodeNil(forKey: key)
        }
    }
}
