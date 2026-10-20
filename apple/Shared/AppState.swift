import Foundation
import Observation

/// Which server, who's signed in, and the shortcuts every screen uses.
@Observable
final class AppState {
    var server: URL? { didSet { UserDefaults.standard.set(server?.absoluteString, forKey: "server") } }
    var token: String? { didSet { Keychain.set(token, for: server?.host ?? "server") } }
    var hello: Hello?
    var me: Me?
    /// What's playing full screen (any screen can start it).
    var playing: PlayRequest?

    func play(_ id: String, from start: Double? = nil, queue: [String] = []) { playing = PlayRequest(itemId: id, start: start, queue: queue) }

    init() {
        if let s = UserDefaults.standard.string(forKey: "server"), let u = URL(string: s) {
            server = u
            token = Keychain.get(u.host ?? "server")
        }
    }

    var api: API { API(base: server ?? URL(string: "http://localhost")!, token: token) }

    func signedIn(with token: String) async {
        self.token = token
        await loadMe()
    }
    func loadMe() async {
        guard token != nil else { return }
        do { me = try await api.get("/api/me") } catch let e as API.Failure where e.status == 401 { token = nil; me = nil } catch { }
    }
    func signOut() async {
        await api.fire("POST", "/api/signout")
        token = nil; me = nil
    }
    func forgetServer() { token = nil; me = nil; hello = nil; server = nil }

    static var deviceName: String {
        #if os(tvOS)
        return "Apple TV"
        #else
        return "iPhone"
        #endif
    }

    /// What Apple's player handles itself (the server converts or repackages the rest).
    static var caps: [String: Any] {
        ["video": ["h264", "hevc"], "audio": ["aac", "mp3", "ac3", "eac3", "alac", "flac"], "containers": ["mp4", "m4a", "mp3", "wav"], "hdr": true]
    }
}

struct PlayRequest: Identifiable {
    let id = UUID()
    let itemId: String
    let start: Double?
    let queue: [String]
}

struct FoundServer: Identifiable, Hashable { let url: URL; let name: String; var id: String { url.absoluteString } }

/// Every Cellovision server answering on this device's Wi-Fi.
enum Finder {
    static func localIPv4() -> String? {
        var ifaddr: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&ifaddr) == 0, let first = ifaddr else { return nil }
        defer { freeifaddrs(ifaddr) }
        var found: String?
        for ptr in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let i = ptr.pointee
            guard let sa = i.ifa_addr, sa.pointee.sa_family == UInt8(AF_INET) else { continue }
            let name = String(cString: i.ifa_name)
            guard name.hasPrefix("en") else { continue }
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            if getnameinfo(sa, socklen_t(sa.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 {
                found = String(cString: host)
                if name == "en0" { break }
            }
        }
        return found
    }

    static func find() async -> [FoundServer] {
        guard let ip = localIPv4() else { return [] }
        let prefix = ip.split(separator: ".").dropLast().joined(separator: ".")
        return await withTaskGroup(of: FoundServer?.self) { group in
            for i in 1...254 {
                group.addTask {
                    let u = URL(string: "http://\(prefix).\(i):8420")!
                    if let h = await API.hello(u, timeout: 1.5) { return FoundServer(url: u, name: h.name) }
                    return nil
                }
            }
            var out: [FoundServer] = []
            for await r in group { if let r { out.append(r) } }
            return out.sorted { $0.id < $1.id }
        }
    }
}
