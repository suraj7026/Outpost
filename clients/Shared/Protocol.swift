import Foundation

public enum JSONValue: Codable, Equatable, Sendable {
    case string(String), number(Double), bool(Bool), object([String: JSONValue]), array([JSONValue]), null
    public init(from decoder: Decoder) throws {
        let box = try decoder.singleValueContainer()
        if box.decodeNil() { self = .null }
        else if let value = try? box.decode(Bool.self) { self = .bool(value) }
        else if let value = try? box.decode(Double.self) { self = .number(value) }
        else if let value = try? box.decode(String.self) { self = .string(value) }
        else if let value = try? box.decode([String: JSONValue].self) { self = .object(value) }
        else { self = .array(try box.decode([JSONValue].self)) }
    }
    public func encode(to encoder: Encoder) throws {
        var box = encoder.singleValueContainer()
        switch self {
        case .string(let value): try box.encode(value)
        case .number(let value): try box.encode(value)
        case .bool(let value): try box.encode(value)
        case .object(let value): try box.encode(value)
        case .array(let value): try box.encode(value)
        case .null: try box.encodeNil()
        }
    }
    public var text: String { if case .string(let value) = self { return value }; return "" }
    public var pretty: String { let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]; return (try? String(decoding: encoder.encode(self), as: UTF8.self)) ?? "" }
}
public struct ServerRecord: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let kind: String
    public let revision: Int
    public let data: [String: JSONValue]
    public let updatedAt: String
    public func text(_ key: String) -> String { data[key]?.text ?? "" }
    public var title: String { ["goal", "title", "name", "label", "tool", "text"].map(text).first(where: { !$0.isEmpty }) ?? kind.capitalized }
}
public struct Snapshot: Codable, Sendable { public let protocolVersion: Int; public let cursor: Int; public let records: [ServerRecord] }
public struct WireEvent: Codable, Sendable { public let protocolVersion: Int; public let eventId: String; public let feedCursor: Int; public let payload: ServerRecord }
public struct EventPage: Codable, Sendable { public let events: [WireEvent]; public let nextCursor: Int; public let hasMore: Bool }
public struct Projection: Sendable {
    public private(set) var cursor = 0
    public private(set) var records: [String: ServerRecord] = [:]
    public init() {}
    public mutating func replace(_ snapshot: Snapshot) throws {
        guard snapshot.protocolVersion == 1 else { throw ClientFailure.message("Unsupported server protocol") }
        records = Dictionary(snapshot.records.map { ("\($0.kind):\($0.id)", $0) }, uniquingKeysWith: { a,b in a.revision >= b.revision ? a : b }); cursor = snapshot.cursor
    }
    public mutating func apply(_ page: EventPage) throws {
        guard page.nextCursor >= cursor else { throw ClientFailure.message("Replay cursor moved backwards") }
        var last = cursor
        for event in page.events where event.feedCursor > cursor {
            guard event.protocolVersion == 1, event.feedCursor > last, event.feedCursor <= page.nextCursor else { throw ClientFailure.message("Invalid event ordering; reconnect to resnapshot") }
            last = event.feedCursor; let record = event.payload, key = "\(record.kind):\(record.id)"
            if record.revision > (records[key]?.revision ?? 0) { records[key] = record }
        }
        cursor = page.nextCursor
    }
}
public enum ClientFailure: LocalizedError { case message(String); public var errorDescription: String? { switch self { case .message(let value): value } } }
