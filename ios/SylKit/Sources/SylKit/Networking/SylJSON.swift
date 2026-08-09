import Foundation

/// The one JSON coder configuration this client uses, on both transports.
///
/// Two settings here are the difference between working and not, and both are
/// non-defaults:
///
/// **No key conversion strategy.** `ttl_ms` on the `presence` frame is the only
/// snake_case field on the wire; everything else is camelCase. A blanket
/// `.convertFromSnakeCase` would rewrite `ttl_ms` to `ttlMs` — which happens to be
/// what we want for that one field — and leave every other field mangled, because
/// the strategy is applied to *all* keys, not the ones that need it. `WsPresence`
/// carries an explicit `CodingKeys` case instead, and it is the only one in the
/// package that differs from its property name.
///
/// **A custom date strategy.** `.iso8601` cannot parse fractional seconds and every
/// instant in this contract carries milliseconds, so the built-in strategy fails on
/// literally every timestamp. See `Instant`.
public enum SylJSON {
    public static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let raw = try container.decode(String.self)
            do {
                return try Instant.parse(raw)
            } catch {
                throw DecodingError.dataCorruptedError(
                    in: container,
                    debugDescription: String(describing: error)
                )
            }
        }
        return decoder
    }

    public static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(Instant.format(date))
        }
        return encoder
    }
}
