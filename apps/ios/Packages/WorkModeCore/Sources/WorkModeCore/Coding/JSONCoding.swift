import Foundation

/// ISO-8601 instant parsing/formatting shared by every Work Mode JSON payload.
///
/// The API emits UTC instants with millisecond precision (`2026-10-05T09:00:00.000Z`) but older payloads,
/// fixtures and hand-written requests may omit the fractional part, carry an offset (`+01:00`) or more than
/// three fractional digits. `parse` accepts all of these; `format` always produces the canonical
/// `yyyy-MM-dd'T'HH:mm:ss.SSS'Z'` UTC form the server expects (an offset is required by `isoDateTimeSchema`).
public enum WorkModeDateCoding {
    // ISO8601DateFormatter is documented as thread-safe.
    private static let withFractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(identifier: "UTC")
        return formatter
    }()

    private static let withoutFractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        formatter.timeZone = TimeZone(identifier: "UTC")
        return formatter
    }()

    /// Parses an ISO-8601 instant with or without fractional seconds. Returns nil for anything without a
    /// timezone designator: a local wall-clock time is not an instant.
    public static func parse(_ string: String) -> Date? {
        let trimmed = string.trimmingCharacters(in: .whitespaces)
        if let date = withFractional.date(from: trimmed) { return date }
        if let date = withoutFractional.date(from: trimmed) { return date }
        // More than three fractional digits (e.g. microseconds from another producer): truncate to millis.
        if let normalised = truncateFraction(trimmed), let date = withFractional.date(from: normalised) {
            return date
        }
        return nil
    }

    /// Canonical wire form: UTC with milliseconds, e.g. `2026-10-05T09:00:00.000Z`.
    public static func format(_ date: Date) -> String {
        withFractional.string(from: date)
    }

    private static func truncateFraction(_ string: String) -> String? {
        guard let dot = string.firstIndex(of: ".") else { return nil }
        var end = string.index(after: dot)
        while end < string.endIndex, string[end].isASCII, string[end].isNumber {
            end = string.index(after: end)
        }
        let digits = string[string.index(after: dot)..<end]
        guard digits.count > 3 else { return nil }
        return String(string[..<dot]) + "." + digits.prefix(3) + String(string[end...])
    }
}

extension JSONDecoder {
    /// Decoder for every Work Mode payload: camelCase keys (as the API sends them) and ISO-8601 instants
    /// with or without fractional seconds.
    public static var workMode: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let string = try container.decode(String.self)
            guard let date = WorkModeDateCoding.parse(string) else {
                throw DecodingError.dataCorruptedError(
                    in: container,
                    debugDescription: "Expected an ISO-8601 instant with a timezone, got \(string)"
                )
            }
            return date
        }
        return decoder
    }
}

extension JSONEncoder {
    /// Encoder for every Work Mode payload: camelCase keys, canonical UTC instants, sorted keys (stable
    /// output for files in the App Group container and for tests). Nil optionals are omitted.
    public static var workMode: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(WorkModeDateCoding.format(date))
        }
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }
}

extension KeyedDecodingContainer {
    /// Decodes an array of `RestrictionCategory` raw values, dropping unknown entries and duplicates and
    /// returning canonical order. Missing key or null → `[]`.
    func decodeCategories(forKey key: Key) throws -> [RestrictionCategory] {
        guard let raw = try decodeIfPresent([String].self, forKey: key) else { return [] }
        return RestrictionCategory.canonical(raw.compactMap(RestrictionCategory.init(rawValue:)))
    }

    /// Decodes an array, skipping elements that fail to decode (used only where an unknown element can be
    /// safely ignored, e.g. an override type a newer server introduced). Missing key or null → `[]`.
    func decodeLossyArray<Element: Decodable>(_ type: Element.Type, forKey key: Key) throws -> [Element] {
        guard contains(key), try decodeNil(forKey: key) == false else { return [] }
        var container = try nestedUnkeyedContainer(forKey: key)
        var elements: [Element] = []
        while !container.isAtEnd {
            if let element = try? container.decode(Element.self) {
                elements.append(element)
            } else {
                _ = try? container.decode(DiscardedValue.self)
            }
        }
        return elements
    }
}

/// Consumes any JSON value so a lossy array decode can move past an element it could not decode.
private struct DiscardedValue: Decodable {
    init(from decoder: Decoder) throws {}
}
