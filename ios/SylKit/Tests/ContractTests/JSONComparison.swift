import Foundation
import SylKit

/// Semantic JSON comparison, and the reason the round-trip is a *gate* rather than a
/// smoke test.
///
/// Comparing bytes would fail on key order and number formatting. Comparing parsed
/// values catches the two things that matter and nothing else:
///
/// - a key present in the fixture and missing from the re-encoded output — which is
///   what an **unknown key** looks like from this side, because a decoder that
///   ignored a field cannot write it back;
/// - a key the model invented, or a value it changed.
enum JSONComparison {
    /// A human-readable account of the first differences found, or nil when the two
    /// documents are semantically identical.
    static func difference(expected: Data, actual: Data) throws -> String? {
        let decoder = JSONDecoder()
        let lhs = try decoder.decode(JSONValue.self, from: expected)
        let rhs = try decoder.decode(JSONValue.self, from: actual)

        var problems: [String] = []
        compare(lhs, rhs, path: "$", into: &problems)
        return problems.isEmpty ? nil : problems.joined(separator: "\n")
    }

    private static func compare(
        _ expected: JSONValue,
        _ actual: JSONValue,
        path: String,
        into problems: inout [String]
    ) {
        switch (expected, actual) {
        case (.null, .null):
            return

        case (.bool(let a), .bool(let b)):
            if a != b { problems.append("\(path): expected \(a), got \(b)") }

        case (.number(let a), .number(let b)):
            // Exact equality is right here: every number in this contract is either an
            // integer or a fixed-precision decimal that survives a Double round-trip.
            if a != b { problems.append("\(path): expected \(a), got \(b)") }

        case (.string(let a), .string(let b)):
            if a != b { problems.append("\(path): expected \"\(a)\", got \"\(b)\"") }

        case (.array(let a), .array(let b)):
            if a.count != b.count {
                problems.append("\(path): expected \(a.count) elements, got \(b.count)")
                return
            }
            for (index, pair) in zip(a, b).enumerated() {
                compare(pair.0, pair.1, path: "\(path)[\(index)]", into: &problems)
            }

        case (.object(let a), .object(let b)):
            for key in Set(a.keys).subtracting(b.keys).sorted() {
                problems.append(
                    """
                    \(path).\(key): dropped. Either the model does not know this field, \
                    or it decodes it and never writes it back.
                    """
                )
            }
            for key in Set(b.keys).subtracting(a.keys).sorted() {
                problems.append("\(path).\(key): invented — the fixture has no such field.")
            }
            for key in Set(a.keys).intersection(b.keys).sorted() {
                // Force-unwrapping is safe: `key` came from the intersection.
                compare(a[key]!, b[key]!, path: "\(path).\(key)", into: &problems)
            }

        default:
            problems.append("\(path): type mismatch — expected \(kind(expected)), got \(kind(actual))")
        }
    }

    private static func kind(_ value: JSONValue) -> String {
        switch value {
        case .null: return "null"
        case .bool: return "boolean"
        case .number: return "number"
        case .string: return "string"
        case .array: return "array"
        case .object: return "object"
        }
    }
}
