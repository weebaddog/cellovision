import SwiftUI

// ---- cards and rows ------------------------------------------------------------------------------

#if os(tvOS)
private let cardWidth: CGFloat = 250
private let wideWidth: CGFloat = 420
#else
private let cardWidth: CGFloat = 130
private let wideWidth: CGFloat = 240
#endif

struct Card: View {
    @Environment(AppState.self) private var state
    let item: Item
    var list: [Item] = []

    private var width: CGFloat { item.isWide ? wideWidth : cardWidth }
    private var height: CGFloat { item.isWide ? width * 9 / 16 : item.isSquare ? width : width * 1.5 }

    var body: some View {
        Group {
            if item.isPlayable || item.kind == "photo" {
                Button { tap() } label: { face }
            } else {
                NavigationLink(value: item) { face }
            }
        }
        #if os(tvOS)
        .buttonStyle(.card)
        #else
        .buttonStyle(.plain)
        #endif
    }

    private func tap() {
        if item.kind == "track" {
            let tracks = list.filter { $0.kind == "track" }
            let ids = tracks.map(\.id)
            let at = ids.firstIndex(of: item.id) ?? 0
            state.play(item.id, from: 0, queue: Array(ids.dropFirst(at + 1)))
        } else if item.kind == "photo" {
            state.play(item.id)
        } else {
            state.play(item.id)
        }
    }

    private var face: some View {
        VStack(alignment: .leading, spacing: 6) {
            ZStack(alignment: .bottomLeading) {
                AsyncImage(url: state.api.image(item.id, "poster", width: Int(width * 2))) { img in
                    img.resizable().scaledToFill()
                } placeholder: {
                    ZStack { Color.gray.opacity(0.18); Text(item.title).font(.caption.bold()).multilineTextAlignment(.center).padding(8).foregroundStyle(.secondary) }
                }
                .frame(width: width, height: height)
                .clipped()
                if let r = item.resumeAt, let d = item.duration, d > 0 {
                    GeometryReader { g in
                        VStack { Spacer(); ZStack(alignment: .leading) { Rectangle().fill(.black.opacity(0.5)); Rectangle().fill(.tint).frame(width: g.size.width * min(1, r / d)) }.frame(height: 4) }
                    }
                }
                if item.mark?.played == true && ["movie", "episode", "video"].contains(item.kind) {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(.green).padding(6).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
                }
            }
            .frame(width: width, height: height)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            Text(item.title).font(.subheadline.bold()).lineLimit(1).frame(width: width, alignment: .leading)
            if let s = item.subtitle, !s.isEmpty { Text(s).font(.caption).foregroundStyle(.secondary).lineLimit(1).frame(width: width, alignment: .leading) }
        }
    }
}

struct Row: View {
    let title: String
    let items: [Item]
    var body: some View {
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Text(title).font(.title3.bold()).padding(.horizontal)
                ScrollView(.horizontal, showsIndicators: false) {
                    LazyHStack(alignment: .top, spacing: 16) { ForEach(items) { Card(item: $0, list: items) } }.padding(.horizontal)
                    #if os(tvOS)
                    .padding(.vertical, 30)
                    #endif
                }
            }
        }
    }
}

extension View {
    /// Where tapping a show, season, album… goes.
    func itemDestinations() -> some View {
        navigationDestination(for: Item.self) { ItemView(item: $0) }
            .navigationDestination(for: Shelf.self) { ShelfView(shelf: $0) }
    }
}

// ---- Home ---------------------------------------------------------------------------------------

struct HomeView: View {
    @Environment(AppState.self) private var state
    @State private var home: Home?
    @State private var error = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                if let home {
                    if !home.shelves.isEmpty {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 14) {
                                ForEach(home.shelves) { s in
                                    NavigationLink(value: s) {
                                        VStack(alignment: .leading) { Text(s.name).font(.headline); Text("\(s.count ?? 0)").font(.caption).foregroundStyle(.secondary) }
                                            .padding().frame(minWidth: 150, alignment: .leading)
                                            .background(LinearGradient(colors: [Color(red: 0.4, green: 0.3, blue: 0.85), Color(red: 0.15, green: 0.5, blue: 0.75)], startPoint: .topLeading, endPoint: .bottomTrailing), in: RoundedRectangle(cornerRadius: 14))
                                    }
                                    #if os(tvOS)
                                    .buttonStyle(.card)
                                    #else
                                    .buttonStyle(.plain)
                                    #endif
                                }
                            }.padding(.horizontal)
                        }
                    }
                    Row(title: "Keep Watching", items: home.keepWatching)
                    Row(title: "Up Next", items: home.upNext)
                    ForEach(home.latest, id: \.shelf.id) { r in Row(title: "New in \(r.shelf.name)", items: r.items) }
                    if home.shelves.isEmpty { Text("Nothing here yet. Add shelves in the Control Room (on the server's web page).").foregroundStyle(.secondary).padding() }
                } else if !error.isEmpty {
                    Text(error).foregroundStyle(.secondary).padding()
                } else { ProgressView().frame(maxWidth: .infinity).padding(60) }
            }
            .padding(.vertical)
        }
        .navigationTitle(state.hello?.name ?? "Cellovision")
        .itemDestinations()
        .task { await load() }
        .refreshable { await load() }
        .onChange(of: state.playing == nil) { _, done in if done { Task { await load() } } }
    }

    private func load() async {
        do { home = try await state.api.get("/api/home") } catch { self.error = error.localizedDescription }
    }
}

// ---- a Shelf ------------------------------------------------------------------------------------

struct ShelfView: View {
    @Environment(AppState.self) private var state
    let shelf: Shelf
    var parent: Item? = nil
    @State private var items: [Item] = []

    var body: some View {
        ScrollView {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: cardWidth + 10), spacing: 16)], spacing: 22) {
                ForEach(items) { Card(item: $0, list: items) }
            }
            .padding()
        }
        .navigationTitle(parent?.title ?? shelf.name)
        .task {
            var path = "/api/browse?shelf=\(shelf.id)&limit=500"
            if let p = parent { path += "&parent=\(p.id)" }
            items = (try? await state.api.get(path, as: Browse.self).items) ?? []
        }
    }
}

// ---- an item ------------------------------------------------------------------------------------

struct ItemView: View {
    @Environment(AppState.self) private var state
    let item: Item
    @State private var full: Item?
    @State private var extra: PageExtra?
    @State private var season: Item?
    @State private var episodes: [Item] = []

    var body: some View {
        let i = full ?? item
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                ZStack(alignment: .bottomLeading) {
                    AsyncImage(url: state.api.image(i.showId ?? i.id, "backdrop", width: 1280)) { $0.resizable().scaledToFill() } placeholder: { Color.clear }
                        .frame(height: 260).frame(maxWidth: .infinity).clipped().opacity(0.55)
                    HStack(alignment: .bottom, spacing: 18) {
                        AsyncImage(url: state.api.image(i.id, "poster", width: 400)) { $0.resizable().scaledToFill() } placeholder: { Color.gray.opacity(0.2) }
                            .frame(width: i.isWide ? 220 : 130, height: i.isWide ? 124 : i.isSquare ? 130 : 195).clipShape(RoundedRectangle(cornerRadius: 10))
                        VStack(alignment: .leading, spacing: 6) {
                            if let ps = extra?.parents, !ps.isEmpty { Text(ps.map(\.title).joined(separator: " › ")).font(.footnote.bold()).foregroundStyle(.secondary) }
                            Text(i.kind == "episode" ? "\(i.episodeLabel ?? "") · \(i.title)" : i.title).font(.title.bold())
                            Text(facts(i)).font(.footnote).foregroundStyle(.secondary)
                        }
                    }.padding()
                }
                HStack(spacing: 12) {
                    if i.isPlayable {
                        if let r = i.resumeAt { Button("Resume \(clock(r))") { state.play(i.id) }.buttonStyle(.borderedProminent) }
                        Button(i.resumeAt != nil ? "From the start" : "Play") { state.play(i.id, from: 0) }.buttonStyle(.borderedProminent)
                    }
                    if i.kind == "show", let n = extra?.next { Button("Play \(n.episodeLabel ?? "")") { state.play(n.id) }.buttonStyle(.borderedProminent) }
                    if i.kind == "album", let tracks = extra?.children, let first = tracks.first { Button("Play album") { state.play(first.id, from: 0, queue: tracks.dropFirst().map(\.id)) }.buttonStyle(.borderedProminent) }
                    Button { Task { await mark(["heart": !(i.mark?.heart ?? false)]) } } label: { Image(systemName: i.mark?.heart == true ? "heart.fill" : "heart") }
                    if ["movie", "episode", "video", "show", "season"].contains(i.kind) {
                        Button { Task { await mark(["played": !(i.mark?.played ?? false)]) } } label: { Image(systemName: i.mark?.played == true ? "checkmark.circle.fill" : "checkmark.circle") }
                    }
                }.padding(.horizontal)
                if let o = i.overview { Text(o).padding(.horizontal).frame(maxWidth: 900, alignment: .leading) }

                if i.kind == "show", let seasons = extra?.seasons, !seasons.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack { ForEach(seasons) { s in Button(s.title) { Task { await open(s) } }.buttonStyle(.bordered).tint(season?.id == s.id ? .accentColor : .gray) } }.padding(.horizontal)
                    }
                    episodeList(episodes)
                } else if i.kind == "season" || i.kind == "album" {
                    episodeList(extra?.children ?? [])
                } else if let kids = extra?.children, !kids.isEmpty {
                    Row(title: i.kind == "artist" ? "Albums" : "Inside", items: kids)
                }
                if let n = extra?.nextEpisode { Row(title: "Next episode", items: [n]) }
                if let s = extra?.similar, !s.isEmpty { Row(title: "More like this", items: s) }
            }
        }
        .navigationTitle(i.title)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .task { await load() }
        .onChange(of: state.playing == nil) { _, done in if done { Task { await load() } } }
    }

    private func episodeList(_ list: [Item]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(list) { e in
                Button {
                    if e.kind == "track" { let ids = list.map(\.id); state.play(e.id, from: 0, queue: Array(ids.drop { $0 != e.id }.dropFirst())) } else { state.play(e.id) }
                } label: {
                    HStack(spacing: 14) {
                        if e.kind == "episode" {
                            AsyncImage(url: state.api.image(e.id, "poster", width: 400)) { $0.resizable().scaledToFill() } placeholder: { Color.gray.opacity(0.2) }
                                .frame(width: 160, height: 90).clipShape(RoundedRectangle(cornerRadius: 8))
                        } else { Text("\(e.trackNo ?? 0)").foregroundStyle(.secondary).frame(width: 30) }
                        VStack(alignment: .leading, spacing: 4) {
                            Text(e.kind == "episode" ? "\(e.episodeNo ?? 0). \(e.title)" : e.title).bold().lineLimit(1)
                            if let o = e.overview { Text(o).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
                        }
                        Spacer()
                        if e.mark?.played == true { Image(systemName: "checkmark.circle.fill").foregroundStyle(.green) }
                        if let d = e.duration { Text(clock(d)).font(.caption).foregroundStyle(.secondary) }
                    }
                    .padding(.vertical, 8).padding(.horizontal)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func load() async {
        guard let (i, x) = try? await state.api.page(item.id) else { return }
        full = i; extra = x
        if i.kind == "show", let seasons = x.seasons, !seasons.isEmpty {
            let pick = seasons.first { $0.id == x.next?.parentId } ?? season ?? seasons[0]
            await open(pick)
        }
    }
    private func open(_ s: Item) async {
        season = s
        if let (_, x) = try? await state.api.page(s.id) { episodes = x.children ?? [] }
    }
    private func mark(_ body: [String: Any]) async {
        var b = body; b["id"] = item.id
        await state.api.fire("POST", "/api/mark", b)
        await load()
    }
    private func facts(_ i: Item) -> String {
        [i.year.map(String.init), i.rating, i.duration.map { d in d >= 3600 ? "\(Int(d) / 3600)h \(Int(d) % 3600 / 60)m" : "\(Int(d) / 60)m" }, i.score.map { String(format: "★ %.1f", $0) }, i.genres?.joined(separator: ", ")]
            .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: "  ·  ")
    }
}

func clock(_ s: Double) -> String {
    let t = Int(s), h = t / 3600, m = t % 3600 / 60, sec = t % 60
    return h > 0 ? String(format: "%d:%02d:%02d", h, m, sec) : String(format: "%d:%02d", m, sec)
}

// ---- Search and Hearts --------------------------------------------------------------------------

struct SearchView: View {
    @Environment(AppState.self) private var state
    @State private var text = ""
    @State private var results: [Item] = []

    var body: some View {
        ScrollView {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: cardWidth + 10), spacing: 16)], spacing: 22) { ForEach(results) { Card(item: $0, list: results) } }.padding()
            if results.isEmpty && text.count >= 2 { Text("Nothing called “\(text)”.").foregroundStyle(.secondary) }
        }
        .navigationTitle("Search")
        .searchable(text: $text)
        .itemDestinations()
        .task(id: text) {
            guard text.count >= 2 else { results = []; return }
            try? await Task.sleep(for: .milliseconds(300))
            results = (try? await state.api.get("/api/search?q=\(text.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "")", as: Items.self).items) ?? []
        }
    }
}

struct HeartsView: View {
    @Environment(AppState.self) private var state
    @State private var items: [Item] = []
    var body: some View {
        ScrollView {
            if items.isEmpty { Text("Heart anything you love and it'll be here.").foregroundStyle(.secondary).padding(40) }
            LazyVGrid(columns: [GridItem(.adaptive(minimum: cardWidth + 10), spacing: 16)], spacing: 22) { ForEach(items) { Card(item: $0, list: items) } }.padding()
        }
        .navigationTitle("Hearts")
        .itemDestinations()
        .task { items = (try? await state.api.get("/api/hearts", as: Items.self).items) ?? [] }
    }
}
