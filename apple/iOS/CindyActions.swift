import Foundation

/// What Cindy (the user's assistant on their PC) can do in Cellovision on the iPhone while she's switched on
/// (Settings > Cindy). Everything goes through the Cellovision server with this app's sign-in, like the app.
enum CindyActions {
    @MainActor static func install(_ state: AppState) {
        Cindy.shared.configure(id: "cellovision", name: "Cellovision", actions: all(state))
    }

    @MainActor private static func signedIn(_ state: AppState) throws {
        if state.server == nil || state.token == nil { throw CindyError("Cellovision isn't signed in on this iPhone") }
    }

    private static func line(_ i: Item) -> String {
        var parts = [i.title]
        if let s = i.subtitle, !s.isEmpty { parts.append(s) }
        parts.append(i.kind)
        if let m = i.mark, !m.played, m.position > 30 { parts.append("stopped at \(Int(m.position / 60)) min") }
        return parts.joined(separator: " · ") + "  [id \(i.id)]"
    }

    @MainActor private static func search(_ state: AppState, _ q: String) async throws -> [Item] {
        let query = q.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
        return try await state.api.get("/api/search?q=\(query)", as: Items.self).items
    }

    /// The thing to play for a search: a movie/episode/song itself, or a show's next episode.
    @MainActor private static func playable(_ state: AppState, _ item: Item) async throws -> Item? {
        if item.isPlayable { return item }
        let (_, extra) = try await state.api.page(item.id)
        return extra.nextEpisode ?? extra.next ?? extra.children?.first { $0.isPlayable }
    }

    @MainActor static func all(_ state: AppState) -> [Cindy.Action] {
        [
            Cindy.Action(name: "search", desc: "Search the Cellovision library (movies, shows, music, videos)",
                         params: ["query": "title or words"]) { a in
                try signedIn(state)
                let items = try await search(state, a.text("query"))
                return items.prefix(20).map(line).joined(separator: "\n").ifEmpty("Nothing matches \(a.text("query"))")
            },
            Cindy.Action(name: "keep_watching", desc: "What the user was in the middle of, and what's up next") { _ in
                try signedIn(state)
                let home: Home = try await state.api.get("/api/home")
                let keep = home.keepWatching.prefix(10).map(line).joined(separator: "\n")
                let next = home.upNext.prefix(10).map(line).joined(separator: "\n")
                return "Keep watching:\n\(keep.ifEmpty("(nothing)"))\nUp next:\n\(next.ifEmpty("(nothing)"))"
            },
            Cindy.Action(name: "hearts", desc: "The user's hearted (favorite) items") { _ in
                try signedIn(state)
                return try await state.api.get("/api/hearts", as: Items.self).items.prefix(30).map(line)
                    .joined(separator: "\n").ifEmpty("No hearts yet")
            },
            Cindy.Action(name: "play", desc: "Play something on this iPhone (a show plays its next episode; resumes where they stopped)",
                         params: ["what": "a title to search for, or an item id from search"]) { a in
                try signedIn(state)
                let what = a.text("what")
                var item: Item?
                if what.range(of: #"^[A-Za-z0-9_-]{6,}$"#, options: .regularExpression) != nil {
                    item = try? await state.api.page(what).0
                }
                if item == nil { item = try await search(state, what).first }
                guard let found = item else { throw CindyError("Nothing matches \(what)") }
                guard let target = try await playable(state, found) else { throw CindyError("\(found.title) has nothing to play") }
                state.play(target.id, from: target.resumeAt)
                return "Playing \(target.title)\(target.subtitle.map { " (\($0))" } ?? "") on the iPhone"
            },
            Cindy.Action(name: "now_playing", desc: "What's playing on this iPhone") { _ in
                guard let p = state.playing else { return "Nothing is playing" }
                let item = try? await state.api.page(p.itemId).0
                return "Playing \(item?.title ?? p.itemId)"
            },
            Cindy.Action(name: "stop", desc: "Stop what's playing on this iPhone") { _ in
                guard state.playing != nil else { return "Nothing was playing" }
                state.playing = nil
                return "Stopped"
            },
        ]
    }
}

private extension String {
    func ifEmpty(_ fallback: String) -> String { isEmpty ? fallback : self }
}
