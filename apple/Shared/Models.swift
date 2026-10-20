import Foundation

// What the Cellovision server sends (the same JSON every app reads). Everything optional that the
// server may leave out, so a newer server never breaks an older app.

struct Mark: Codable, Hashable {
    var position: Double = 0
    var played: Bool = false
    var heart: Bool = false
}

struct Item: Codable, Identifiable, Hashable {
    let id: String
    let kind: String
    var shelfId: String?
    var parentId: String?
    var title: String
    var year: Int?
    var overview: String?
    var genres: [String]?
    var age: Int?
    var rating: String?
    var score: Double?
    var duration: Double?
    var seasonNo: Int?
    var episodeNo: Int?
    var trackNo: Int?
    var artist: String?
    var album: String?
    var premiered: String?
    var poster: Bool?
    var backdrop: Bool?
    var mark: Mark?
    var showTitle: String?
    var showId: String?

    var isPlayable: Bool { ["movie", "episode", "video", "track"].contains(kind) }
    var isWide: Bool { ["episode", "video"].contains(kind) }
    var isSquare: Bool { ["album", "artist", "track", "photo", "folder"].contains(kind) }
    var episodeLabel: String? {
        guard let s = seasonNo, let e = episodeNo else { return nil }
        return "S\(s) · E\(e)"
    }
    var resumeAt: Double? {
        guard let m = mark, !m.played, m.position > 30 else { return nil }
        return m.position
    }
    var subtitle: String? {
        switch kind {
        case "episode": return [showTitle, episodeLabel].compactMap { $0 }.joined(separator: " · ")
        case "album", "track": return artist
        default: return year.map(String.init)
        }
    }
}

struct Parent: Codable, Hashable { let id: String; let kind: String; let title: String }

/** The extra things an item's own page carries. */
struct PageExtra: Codable {
    var parents: [Parent]?
    var children: [Item]?
    var seasons: [Item]?
    var next: Item?
    var nextEpisode: Item?
    var similar: [Item]?
}

struct Shelf: Codable, Identifiable, Hashable { let id: String; let name: String; let kind: String; var count: Int? }
struct LatestRow: Codable { let shelf: Shelf; let items: [Item] }
struct Home: Codable { let keepWatching: [Item]; let upNext: [Item]; let shelves: [Shelf]; let latest: [LatestRow] }
struct Browse: Codable { let total: Int; let items: [Item]; let genres: [String]? }
struct Items: Codable { let items: [Item] }

struct ProfileLite: Codable, Identifiable, Hashable { let id: String; let name: String; let hasPassword: Bool }
struct Hello: Codable { let name: String; let version: String?; let setUp: Bool; let profiles: [ProfileLite] }
struct Me: Codable { let id: String; let name: String; let admin: Bool; let shelves: [Shelf] }
struct Token: Codable { let token: String }

struct Plan: Codable {
    let mode: String
    let url: String
    var start: Double?
    var resume: Double?
    var session: String?
    var subtitle: String?
    var duration: Double?
}

struct PairStart: Codable { let code: String; let secret: String; let expires: Double }
struct PairCheck: Codable { let approved: Bool; var token: String? }
struct PairApproved: Codable { let device: String? }
struct ServerError: Codable { let error: String }
