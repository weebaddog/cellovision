// Reading the library for one profile: what they're allowed to see (Shelves they can open, Age
// Limit), how an item is described to the apps, and the home screen rows (Keep Watching, Up Next,
// Latest).

const j = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

/** SQL that limits `i` (items) to what this profile may see. Returns [sql, params]. */
export function visible(profile, alias = "i") {
  const parts = [`${alias}.missing = 0`];
  const params = [];
  if (profile.shelves) { parts.push(`${alias}.shelf_id IN (${profile.shelves.map(() => "?").join(",") || "''"})`); params.push(...profile.shelves); }
  if (profile.max_age !== null && profile.max_age !== undefined) {
    // An episode or season is as old as its show says.
    parts.push(`COALESCE(${alias}.age,
      (SELECT p.age FROM items p WHERE p.id = ${alias}.parent_id),
      (SELECT g.age FROM items p JOIN items g ON g.id = p.parent_id WHERE p.id = ${alias}.parent_id), 0) <= ?`);
    params.push(profile.max_age);
  }
  return [parts.join(" AND "), params];
}

/** An item as the apps see it. */
export function shape(i, mark = null, extra = {}) {
  const streams = j(i.streams, []);
  const v = streams.find((s) => s.type === "video" && !s.cover);
  return {
    id: i.id, kind: i.kind, shelfId: i.shelf_id, parentId: i.parent_id, title: i.title, year: i.year, overview: i.overview,
    genres: j(i.genres, []), age: i.age, rating: i.rating_label, score: i.score, studio: i.studio, premiered: i.premiered,
    duration: i.duration, seasonNo: i.season_no, episodeNo: i.episode_no, trackNo: i.track_no, discNo: i.disc_no, artist: i.artist, album: i.album,
    poster: !!(i.poster || ["photo", "video", "episode", "movie", "album"].includes(i.kind)), backdrop: !!i.backdrop, added: i.added,
    ...(v ? { video: { width: v.width, height: v.height, codec: v.codec, hdr: v.hdr } } : {}),
    mark: mark ? { position: mark.position, played: !!mark.played, plays: mark.plays, heart: !!mark.heart, lastPlayed: mark.last_played } : { position: 0, played: false, plays: 0, heart: false, lastPlayed: null },
    ...extra,
  };
}

/** Audio, subtitle and video tracks, for the player's menus. */
export function tracks(i) {
  const streams = j(i.streams, []);
  const subs = j(i.subs, []);
  return {
    audio: streams.filter((s) => s.type === "audio").map((s) => ({ index: s.index, lang: s.lang, title: s.title, codec: s.codec, channels: s.channels, default: s.default })),
    subtitles: [
      ...streams.filter((s) => s.type === "subtitle").map((s) => ({ key: String(s.index), lang: s.lang, title: s.title, codec: s.codec, forced: s.forced, sdh: s.sdh, text: s.text, embedded: true })),
      ...subs.map((s, n) => ({ key: `f${n}`, lang: s.lang, title: null, codec: s.format, forced: s.forced, sdh: s.sdh, text: true, embedded: false })),
    ],
    container: i.container,
  };
}

export function createLibrary(db) {
  const markOf = (profileId, itemId) => db.get("SELECT * FROM marks WHERE profile_id = ? AND item_id = ?", profileId, itemId);

  /** Several items with their marks. */
  function many(profile, sql, ...params) {
    const rows = db.all(sql, ...params);
    if (!rows.length) return [];
    const marks = new Map(db.all(`SELECT * FROM marks WHERE profile_id = ? AND item_id IN (${rows.map(() => "?").join(",")})`, profile.id, ...rows.map((r) => r.id)).map((m) => [m.item_id, m]));
    return rows.map((r) => shape(r, marks.get(r.id), r.show_title ? { showTitle: r.show_title, showId: r.show_id } : {}));
  }

  const SHOW_JOIN = `LEFT JOIN items se ON se.id = i.parent_id AND i.kind = 'episode' LEFT JOIN items sh ON sh.id = se.parent_id`;

  return {
    many,
    markOf,

    get(profile, id) {
      const [w, p] = visible(profile);
      const i = db.get(`SELECT i.* FROM items i WHERE i.id = ? AND ${w}`, id, ...p);
      return i || null;
    },

    keepWatching(profile, limit = 20) {
      const [w, p] = visible(profile);
      return many(profile, `SELECT i.*, sh.title AS show_title, sh.id AS show_id FROM marks m JOIN items i ON i.id = m.item_id ${SHOW_JOIN}
        WHERE m.profile_id = ? AND m.position > 30 AND m.played = 0 AND i.kind IN ('movie','episode','video') AND (i.duration IS NULL OR m.position < i.duration - 60) AND ${w}
        ORDER BY m.last_played DESC LIMIT ?`, profile.id, ...p, limit);
    },

    /** For each show watched lately: the next episode not yet watched. */
    upNext(profile, limit = 20) {
      const [w, p] = visible(profile);
      const shows = db.all(`SELECT sh.id AS show_id, MAX(m.last_played) AS last FROM marks m JOIN items i ON i.id = m.item_id JOIN items se ON se.id = i.parent_id JOIN items sh ON sh.id = se.parent_id
        WHERE m.profile_id = ? AND i.kind = 'episode' AND (m.played = 1 OR m.position > 0) AND m.last_played > ? GROUP BY sh.id ORDER BY last DESC LIMIT ?`,
        profile.id, Date.now() - 90 * 86400_000, limit);
      const out = [];
      for (const s of shows) {
        // The latest-watched episode, then the first unwatched one after it (skipping Specials).
        const last = db.get(`SELECT i.season_no, i.episode_no FROM marks m JOIN items i ON i.id = m.item_id JOIN items se ON se.id = i.parent_id
          WHERE m.profile_id = ? AND se.parent_id = ? AND i.kind = 'episode' ORDER BY m.last_played DESC LIMIT 1`, profile.id, s.show_id);
        const next = many(profile, `SELECT i.*, sh.title AS show_title, sh.id AS show_id FROM items i ${SHOW_JOIN}
          WHERE sh.id = ? AND i.kind = 'episode' AND i.season_no > 0 AND ${w}
            AND (i.season_no > ? OR (i.season_no = ? AND i.episode_no > ?))
            AND NOT EXISTS (SELECT 1 FROM marks m2 WHERE m2.profile_id = ? AND m2.item_id = i.id AND m2.played = 1)
          ORDER BY i.season_no, i.episode_no LIMIT 1`, s.show_id, ...p, last.season_no, last.season_no, last.episode_no ?? -1, profile.id)[0];
        if (next && !(next.mark.position > 30)) out.push(next);
      }
      return out;
    },

    /** Newest additions on a shelf: movies, shows (by their newest episode), albums, videos. */
    latest(profile, shelf, limit = 16) {
      const [w, p] = visible(profile);
      const top = { movies: "movie", shows: "show", music: "album", photos: "photo", videos: "video" }[shelf.kind];
      if (shelf.kind === "shows") {
        return many(profile, `SELECT i.*, MAX(e.added) AS newest FROM items i JOIN items se ON se.parent_id = i.id JOIN items e ON e.parent_id = se.id
          WHERE i.shelf_id = ? AND i.kind = 'show' AND ${w} GROUP BY i.id ORDER BY newest DESC LIMIT ?`, shelf.id, ...p, limit);
      }
      return many(profile, `SELECT i.* FROM items i WHERE i.shelf_id = ? AND i.kind = ? AND ${w} ORDER BY i.added DESC LIMIT ?`, shelf.id, top, ...p, limit);
    },

    shelves(profile) {
      const all = db.all("SELECT * FROM shelves ORDER BY name");
      return all.filter((s) => !profile.shelves || profile.shelves.includes(s.id)).map((s) => ({ id: s.id, name: s.name, kind: s.kind, scanned: s.scanned,
        count: db.get(`SELECT COUNT(*) AS n FROM items WHERE shelf_id = ? AND missing = 0 AND kind = ?`, s.id, { movies: "movie", shows: "show", music: "album", photos: "photo", videos: "video" }[s.kind]).n }));
    },

    /** Browsing a shelf, with filters. */
    browse(profile, shelf, q) {
      const [w, p] = visible(profile);
      const kind = q.kind || { movies: "movie", shows: "show", music: "album", photos: null, videos: null }[shelf.kind];
      const where = [`i.shelf_id = ?`, w];
      const params = [shelf.id, ...p];
      if (kind) { where.push("i.kind = ?"); params.push(kind); }
      if ((shelf.kind === "photos" || shelf.kind === "videos") && !kind) { where.push(q.parent ? "i.parent_id = ?" : "i.parent_id IS NULL"); if (q.parent) params.push(q.parent); }
      if (q.genre) { where.push("i.genres LIKE ?"); params.push(`%"${q.genre.replace(/["%_]/g, "")}"%`); }
      if (q.year) { where.push("i.year = ?"); params.push(+q.year); }
      if (q.letter) { where.push("i.sort_title LIKE ?"); params.push(`${q.letter.toLowerCase().slice(0, 1)}%`); }
      if (q.heart === "1") { where.push("EXISTS (SELECT 1 FROM marks m WHERE m.profile_id = ? AND m.item_id = i.id AND m.heart = 1)"); params.push(profile.id); }
      if (q.played === "0") { where.push("NOT EXISTS (SELECT 1 FROM marks m WHERE m.profile_id = ? AND m.item_id = i.id AND m.played = 1)"); params.push(profile.id); }
      const order = { added: "i.added DESC", year: "i.year DESC, i.sort_title", score: "i.score DESC NULLS LAST", title: "i.sort_title", taken: "i.sort_title DESC" }[q.sort]
        || (shelf.kind === "photos" ? "i.kind = 'folder' DESC, i.sort_title DESC" : shelf.kind === "videos" ? "i.kind = 'folder' DESC, i.sort_title" : "i.sort_title");
      const limit = Math.min(500, +q.limit || 200), offset = +q.offset || 0;
      const total = db.get(`SELECT COUNT(*) AS n FROM items i WHERE ${where.join(" AND ")}`, ...params).n;
      const items = many(profile, `SELECT i.* FROM items i WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ? OFFSET ?`, ...params, limit, offset);
      const genres = [...new Set(db.all(`SELECT i.genres FROM items i WHERE i.shelf_id = ? AND i.genres IS NOT NULL AND ${w}${kind ? " AND i.kind = ?" : ""}`, shelf.id, ...p, ...(kind ? [kind] : [])).flatMap((r) => j(r.genres, [])))].sort();
      return { total, items, genres };
    },

    children(profile, id) {
      const [w, p] = visible(profile);
      return many(profile, `SELECT i.* FROM items i WHERE i.parent_id = ? AND ${w} ORDER BY i.kind = 'folder' DESC, i.sort_title`, id, ...p);
    },

    /** The episode after this one (for the "next episode" button and autoplay). */
    nextEpisode(profile, ep) {
      if (ep.kind !== "episode") return null;
      const [w, p] = visible(profile);
      const show = db.get("SELECT parent_id FROM items WHERE id = ?", ep.parent_id)?.parent_id;
      return many(profile, `SELECT i.* FROM items i JOIN items se ON se.id = i.parent_id WHERE se.parent_id = ? AND i.kind = 'episode' AND ${w}
        AND (i.season_no > ? OR (i.season_no = ? AND i.episode_no > ?)) ORDER BY i.season_no, i.episode_no LIMIT 1`, show, ...p, ep.season_no, ep.season_no, ep.episode_no ?? -1)[0] || null;
    },

    search(profile, text, limit = 60) {
      const [w, p] = visible(profile);
      const like = `%${String(text).replace(/[%_]/g, "").slice(0, 80)}%`;
      return many(profile, `SELECT i.*, sh.title AS show_title, sh.id AS show_id FROM items i ${SHOW_JOIN}
        WHERE (i.title LIKE ? OR i.artist LIKE ? OR i.album LIKE ?) AND i.kind IN ('movie','show','episode','artist','album','track','video') AND ${w}
        ORDER BY CASE i.kind WHEN 'movie' THEN 0 WHEN 'show' THEN 0 WHEN 'artist' THEN 1 WHEN 'album' THEN 2 ELSE 3 END, i.sort_title LIMIT ?`, like, like, like, ...p, limit);
    },

    setMark(profileId, itemId, m) {
      const old = markOf(profileId, itemId) || { position: 0, played: 0, plays: 0, heart: 0, last_played: null };
      const next = { ...old };
      if ("position" in m) { next.position = Math.max(0, +m.position || 0); next.last_played = Date.now(); }
      if ("played" in m) {
        next.played = m.played ? 1 : 0;
        if (m.played) { next.position = 0; next.plays = (old.plays || 0) + (old.played ? 0 : 1); next.last_played = Date.now(); }
      }
      if ("heart" in m) next.heart = m.heart ? 1 : 0;
      db.run(`INSERT INTO marks (profile_id, item_id, position, played, plays, last_played, heart) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(profile_id, item_id) DO UPDATE SET position = excluded.position, played = excluded.played, plays = excluded.plays, last_played = excluded.last_played, heart = excluded.heart`,
        profileId, itemId, next.position, next.played, next.plays, next.last_played, next.heart);
      return next;
    },
  };
}
