import Foundation
import Security

/// Talking to the Cellovision server: JSON in and out, signed in with a token.
struct API {
    let base: URL
    let token: String?

    struct Failure: LocalizedError { let message: String; let status: Int; var errorDescription: String? { message } }

    private func request(_ method: String, _ path: String, body: [String: Any]? = nil) async throws -> Data {
        guard let url = URL(string: path, relativeTo: base) else { throw Failure(message: "Bad address", status: 0) }
        var r = URLRequest(url: url, timeoutInterval: 30)
        r.httpMethod = method
        r.setValue("application/json", forHTTPHeaderField: "content-type")
        if let token { r.setValue("Bearer \(token)", forHTTPHeaderField: "authorization") }
        if let body { r.httpBody = try JSONSerialization.data(withJSONObject: body) }
        let (data, res) = try await URLSession.shared.data(for: r)
        let status = (res as? HTTPURLResponse)?.statusCode ?? 0
        if status >= 400 {
            let msg = (try? JSONDecoder().decode(ServerError.self, from: data))?.error ?? "Error \(status)"
            throw Failure(message: msg, status: status)
        }
        return data
    }

    func get<T: Decodable>(_ path: String, as: T.Type = T.self) async throws -> T {
        try JSONDecoder().decode(T.self, from: try await request("GET", path))
    }
    func send<T: Decodable>(_ method: String, _ path: String, _ body: [String: Any] = [:], as: T.Type = T.self) async throws -> T {
        try JSONDecoder().decode(T.self, from: try await request(method, path, body: body))
    }
    func fire(_ method: String, _ path: String, _ body: [String: Any] = [:]) async {
        _ = try? await request(method, path, body: body)
    }

    /// Tells the server about a problem (it emails the owner).
    func report(_ kind: String, _ message: String, _ detail: String = "") async {
        #if os(tvOS)
        let device = "Apple TV"
        #else
        let device = "iPhone"
        #endif
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
        await fire("POST", "/api/report", ["source": "apple", "kind": kind, "message": String(message.prefix(500)), "detail": String(detail.prefix(6000)), "device": "\(device) · \(ProcessInfo.processInfo.operatingSystemVersionString)", "version": version])
    }

    /// An item's page: the item plus its family (seasons, episodes, tracks…).
    func page(_ id: String) async throws -> (Item, PageExtra) {
        let data = try await request("GET", "/api/item?id=\(id)")
        let d = JSONDecoder()
        return (try d.decode(Item.self, from: data), try d.decode(PageExtra.self, from: data))
    }

    /// A media address the system player can open (it can't add our header, so the token rides along).
    func media(_ path: String) -> URL {
        var c = URLComponents(url: URL(string: path, relativeTo: base)!, resolvingAgainstBaseURL: true)!
        var q = c.queryItems ?? []
        if let token { q.append(URLQueryItem(name: "t", value: token)) }
        c.queryItems = q
        return c.url!
    }
    func image(_ id: String, _ which: String = "poster", width: Int = 300) -> URL {
        media("/api/img/\(id)/\(which)?w=\(width)")
    }

    /// Is there a Cellovision server here? Its hello, or nil.
    static func hello(_ base: URL, timeout: TimeInterval = 2) async -> Hello? {
        var r = URLRequest(url: base.appendingPathComponent("api/hello"), timeoutInterval: timeout)
        r.setValue("application/json", forHTTPHeaderField: "accept")
        guard let (data, res) = try? await URLSession.shared.data(for: r), (res as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return try? JSONDecoder().decode(Hello.self, from: data)
    }
}

/// The sign-in token, kept in the Keychain (this device only).
enum Keychain {
    private static let service = "com.cellovision.token"
    static func get(_ account: String) -> String? {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account,
                                kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
        return String(data: d, encoding: .utf8)
    }
    static func set(_ value: String?, for account: String) {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
        SecItemDelete(q as CFDictionary)
        guard let value else { return }
        var add = q
        add[kSecValueData as String] = Data(value.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(add as CFDictionary, nil)
    }
}
