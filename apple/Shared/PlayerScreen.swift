import SwiftUI
import AVKit
import AVFoundation

/// Full-screen playback with Apple's own player (Siri Remote on Apple TV; picture-in-picture and
/// AirPlay on iPhone). The server picks how (Fit to Device); progress is saved as it plays, and the
/// next episode (or the next song in the queue) follows.
struct PlayerScreen: View {
    @Environment(AppState.self) private var state
    let request: PlayRequest
    @State private var model = PlayerModel()

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if let photo = model.photoURL {
                AsyncImage(url: photo) { $0.resizable().scaledToFit() } placeholder: { ProgressView() }.ignoresSafeArea()
            } else if let player = model.player {
                SystemPlayer(player: player).ignoresSafeArea()
            } else if let e = model.error {
                VStack(spacing: 16) { Text(e).foregroundStyle(.white); Button("Close") { state.playing = nil } }
            } else { ProgressView().tint(.white) }
        }
        #if os(iOS)
        .overlay(alignment: .topLeading) {
            Button { state.playing = nil } label: { Image(systemName: "xmark.circle.fill").font(.title).foregroundStyle(.white.opacity(0.8)) }.padding()
                .opacity(model.photoURL != nil || model.error != nil ? 1 : 0)
        }
        #endif
        .task { await model.start(request, state: state) }
        .onDisappear { model.stop() }
        .onChange(of: model.finished) { _, f in if f { state.playing = nil } }
    }
}

@Observable
final class PlayerModel {
    var player: AVPlayer?
    var photoURL: URL?
    var error: String?
    var finished = false

    private var api: API?
    private var itemId = ""
    private var item: (Item, PageExtra)?
    private var plan: Plan?
    private var offset: Double = 0
    private var queue: [String] = []
    private var observer: Any?
    private var endObserver: NSObjectProtocol?
    private var failObserver: NSObjectProtocol?
    private var lastReport = Date.distantPast

    @MainActor
    func start(_ r: PlayRequest, state: AppState) async {
        api = state.api
        queue = r.queue
        await open(r.itemId, from: r.start)
    }

    @MainActor
    private func open(_ id: String, from start: Double?) async {
        guard let api else { return }
        cleanUp()
        itemId = id
        do {
            let page = try await api.page(id)
            item = page
            if page.0.kind == "photo" { photoURL = api.image(id, "poster", width: 1920); return }
            var body: [String: Any] = ["id": id, "caps": AppState.caps]
            if let start { body["start"] = start; body["hlsStart"] = start }
            let p: Plan = try await api.send("POST", "/api/play", body)
            plan = p
            offset = p.mode == "direct" ? 0 : (p.start ?? 0)
            let player = self.player ?? AVPlayer()
            player.replaceCurrentItem(with: AVPlayerItem(url: api.media(p.url)))
            if p.mode == "direct", let resume = p.resume, resume > 0 { await player.seek(to: CMTime(seconds: resume, preferredTimescale: 600)) }
            #if os(iOS)
            try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
            try? AVAudioSession.sharedInstance().setActive(true)
            #endif
            self.player = player
            watch(player)
            player.play()
        } catch {
            self.error = error.localizedDescription
            let msg = "\(id): \(error.localizedDescription)"
            Task { await api.report("playback failed", msg) }
        }
    }

    private var position: Double { offset + (player?.currentTime().seconds.isFinite == true ? player!.currentTime().seconds : 0) }

    private func watch(_ player: AVPlayer) {
        observer = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 5, preferredTimescale: 1), queue: .main) { [weak self] _ in
            guard let self, Date().timeIntervalSince(self.lastReport) >= 10, player.rate > 0 else { return }
            self.report()
        }
        endObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: player.currentItem, queue: .main) { [weak self] _ in
            Task { @MainActor in await self?.ended() }
        }
        failObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemFailedToPlayToEndTime, object: player.currentItem, queue: .main) { [weak self] note in
            guard let self, let api = self.api else { return }
            let err = (note.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? Error)?.localizedDescription ?? "unknown"
            let msg = "\(self.item?.0.title ?? self.itemId): \(err)"
            let detail = "mode \(self.plan?.mode ?? "?")"
            Task { await api.report("playback failed", msg, detail) }
        }
    }

    private func report(_ extra: [String: Any] = [:]) {
        guard let api, plan != nil else { return }
        lastReport = Date()
        var body: [String: Any] = ["id": itemId, "position": position, "paused": (player?.rate ?? 0) == 0, "mode": plan?.mode ?? ""]
        for (k, v) in extra { body[k] = v }
        Task { await api.fire("POST", "/api/playing", body) }
    }

    @MainActor
    private func ended() async {
        let duration = item?.0.duration ?? 0
        // A converted stream that stops early isn't the real end.
        if duration > 0, duration - position > 10, plan?.mode != "direct" { return }
        report(["position": duration])
        if let next = item?.1.nextEpisode?.id { endSession(); await open(next, from: 0) }
        else if !queue.isEmpty { let n = queue.removeFirst(); endSession(); await open(n, from: 0) }
        else { finished = true }
    }

    private func endSession() {
        guard let api, let s = plan?.session else { return }
        Task { await api.fire("DELETE", "/api/hls", ["session": s]) }
    }

    private func cleanUp() {
        if let o = observer { player?.removeTimeObserver(o); observer = nil }
        if let e = endObserver { NotificationCenter.default.removeObserver(e); endObserver = nil }
        if let e = failObserver { NotificationCenter.default.removeObserver(e); failObserver = nil }
    }

    func stop() {
        if plan != nil { report(["stopped": true]) }
        endSession()
        cleanUp()
        player?.pause()
        player = nil
    }
}

/// Apple's player view controller, as a SwiftUI view.
struct SystemPlayer: UIViewControllerRepresentable {
    let player: AVPlayer
    func makeUIViewController(context: Context) -> AVPlayerViewController {
        let c = AVPlayerViewController()
        c.player = player
        #if os(iOS)
        c.allowsPictureInPicturePlayback = true
        c.canStartPictureInPictureAutomaticallyFromInline = true
        #endif
        return c
    }
    func updateUIViewController(_ c: AVPlayerViewController, context: Context) { if c.player !== player { c.player = player } }
}
