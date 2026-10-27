import Foundation
import CryptoKit
import Security
import Observation
import LocalAuthentication

public struct DeviceIdentity {
    public let id: String
    let key: Curve25519.Signing.PrivateKey
    public var publicKey: String { key.publicKey.rawRepresentation.base64EncodedString() }
    public static func load() throws -> DeviceIdentity {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "dev.outpost.identity", kSecAttrAccount as String: "device"]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query.merging([kSecReturnData as String: true], uniquingKeysWith: { _,new in new }) as CFDictionary, &result)
        if status == errSecSuccess, let data = result as? Data {
            let stored = try JSONDecoder().decode([String: String].self, from: data)
            guard let id = stored["id"], let encoded = stored["key"], let key = Data(base64Encoded: encoded) else { throw ClientFailure.message("Device key is invalid") }
            return DeviceIdentity(id: id, key: try Curve25519.Signing.PrivateKey(rawRepresentation: key))
        }
        guard status == errSecItemNotFound else { throw ClientFailure.message("Keychain access failed (\(status))") }
        let identity = DeviceIdentity(id: UUID().uuidString.lowercased(), key: Curve25519.Signing.PrivateKey())
        let data = try JSONEncoder().encode(["id": identity.id, "key": identity.key.rawRepresentation.base64EncodedString()])
        let saved = SecItemAdd(query.merging([kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly], uniquingKeysWith: { _,new in new }) as CFDictionary, nil)
        guard saved == errSecSuccess else { throw ClientFailure.message("Could not save device key (\(saved))") }; return identity
    }
}
@MainActor @Observable public final class Connection {
    public var serverURL: String
    public private(set) var projection = Projection()
    public private(set) var connected = false
    public private(set) var lastSync: Date?
    public var error: String?
    public private(set) var busy = false
    public private(set) var commandStatus = ""
    private var identity: DeviceIdentity?
    private var pendingCommand: [String: JSONValue]?
    public init() { serverURL = UserDefaults.standard.string(forKey: "outpost.server") ?? "http://127.0.0.1:4318"; do { identity = try DeviceIdentity.load() } catch { self.error = error.localizedDescription } }
    public var deviceID: String { identity?.id ?? "Unavailable" }
    public var publicKey: String { identity?.publicKey ?? "" }
    public func records(_ kind: String, taskID: String? = nil) -> [ServerRecord] {
        projection.records.values.filter { $0.kind == kind && (taskID == nil || $0.text("taskId") == taskID) }.sorted { $0.updatedAt == $1.updatedAt ? $0.id < $1.id : $0.updatedAt < $1.updatedAt }
    }
    private func request(_ path: String, _ payload: [String: JSONValue], signed: Bool = true) async throws -> Data {
        guard let base = URL(string: serverURL), let host = base.host, base.scheme == "https" || (base.scheme == "http" && ["127.0.0.1", "localhost", "::1"].contains(host)) else { throw ClientFailure.message("Use HTTPS, or loopback HTTP for local development") }
        guard let identity else { throw ClientFailure.message("Device identity unavailable") }
        let data = try JSONEncoder().encode(payload)
        var request = URLRequest(url: base.appendingPathComponent(path)); request.httpMethod = "POST"; request.httpBody = data; request.timeoutInterval = 15
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if signed { request.setValue(try identity.key.signature(for: data).base64EncodedString(), forHTTPHeaderField: "X-Outpost-Signature") }
        let (body, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let failure = try? JSONDecoder().decode([String: JSONValue].self, from: body)
            throw ClientFailure.message(failure?["message"]?.text ?? "Server rejected the request")
        }
        return body
    }
    private func envelope(_ type: String, payload: [String: JSONValue] = [:]) -> [String: JSONValue] {
        ["deviceId": .string(deviceID), "issuedAt": .number(floor(Date().timeIntervalSince1970*1000)), "type": .string(type), "payload": .object(payload)]
    }
    public func pair(token: String) async {
        await perform {
            _ = try await self.request("v1/pair", ["deviceId": .string(self.deviceID), "name": .string("Outpost Native"), "publicKey": .string(self.publicKey), "token": .string(token)], signed: false)
            try await self.refreshSnapshot()
        }
    }
    public func connect() async { await perform { try await self.refreshSnapshot() } }
    private func refreshSnapshot() async throws {
        let data = try await request("v1/query", envelope("snapshot")); try projection.replace(JSONDecoder().decode(Snapshot.self, from: data))
        connected = true; lastSync = Date(); UserDefaults.standard.set(serverURL, forKey: "outpost.server")
    }
    public func sync() async {
        guard !busy, connected else { return }
        do {
            var more = true
            while more {
                let data = try await request("v1/query", envelope("events", payload: ["after": .number(Double(projection.cursor))]))
                let page = try JSONDecoder().decode(EventPage.self, from: data); try projection.apply(page); more = page.hasMore
            }
            lastSync = Date()
        } catch { connected = false; self.error = "Offline — last-known records retained. \(error.localizedDescription)" }
    }
    public func send(_ type: String, id: String, revision: Int, payload: [String: JSONValue] = [:], authenticate: Bool = false) async {
        guard connected, !busy, pendingCommand == nil else { error = "Reconnect or resolve the pending command before sending another."; return }
        await perform {
            if authenticate {
                let context = LAContext(); let allowed = try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Confirm this exact Outpost decision")
                guard allowed else { throw ClientFailure.message("Authentication cancelled") }
            }
            var command = self.envelope(type, payload: payload)
            command["protocolVersion"] = .number(1); command["commandId"] = .string(UUID().uuidString.lowercased()); command["idempotencyKey"] = .string(UUID().uuidString.lowercased()); command["aggregateId"] = .string(id); command["expectedRevision"] = .number(Double(revision))
            self.pendingCommand = command; self.commandStatus = "Sending — not yet accepted"
            _ = try await self.request("v1/commands", command)
            self.pendingCommand = nil; self.commandStatus = "Accepted by server — execution may still be pending"; try await self.refreshSnapshot()
        }
    }
    public var hasPendingCommand: Bool { pendingCommand != nil }
    public func retryPending() async {
        guard var command = pendingCommand else { return }
        await perform {
            command["issuedAt"] = .number(floor(Date().timeIntervalSince1970*1000))
            _ = try await self.request("v1/commands", command); self.pendingCommand = nil; self.commandStatus = "Server acceptance confirmed"; try await self.refreshSnapshot()
        }
    }
    public func download(_ artifact: ServerRecord) async throws -> URL {
        let data = try await request("v1/artifact", envelope("artifact", payload: ["artifactId": .string(artifact.id)]))
        let hash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        guard hash == artifact.text("hash") else { throw ClientFailure.message("Artifact integrity check failed") }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(artifact.id, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent(URL(fileURLWithPath: artifact.text("name")).lastPathComponent)
        try data.write(to: url, options: [.atomic]); return url
    }
    private func perform(_ operation: () async throws -> Void) async {
        guard !busy else { return }; busy = true; error = nil
        defer { busy = false }
        do { try await operation() } catch { self.error = error.localizedDescription; if pendingCommand != nil { commandStatus = "Acceptance unknown — retry uses the same operation key" } }
    }
}
