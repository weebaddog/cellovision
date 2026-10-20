// The scanner: walks a shelf's folders and keeps the database in step with what's on disk.
//   movies → movie            shows → show › season › episode       music → artist › album › track
//   photos → folder › photo   videos (home videos) → folder › video
// Files that vanish are marked missing (not deleted) so a drive that's unplugged for a while
// doesn't wipe everyone's Keep Watching; they're removed for good after 30 days.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { VIDEO, AUDIO, PHOTO, SUBS, ext, parseMovie, parseEpisode, parseShow, seasonOf, showNameOf, sortTitle, subtitleInfo, tidy } from "./names.js";
import { probe } from "./probe.js";
import { nfoFor, localArt, ageOf } from "./meta.js";

export const idOf = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 20);
const SKIP_DIR = /^(\.|@eadir$|#recycle$|\$recycle\.bin$|system volume information$|extras?$|featurettes$|behind the scenes$|deleted scenes$|trailers?$|samples?$|lost\+found$)/i;
const MISSING_FOR = 30 * 86400_000;

/** Every file under `root` (skipping system and extras folders), as { file, dir, rel }. */
function walk(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIR.test(e.name)) stack.push(full); }
      else if (e.isFile() && !e.name.startsWith(".") && !/(^|[\s._-])sample\.[a-z0-9]+$/i.test(e.name)) out.push(full);
    }
  }
  return out.sort();
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}

export function createScanner({ db, artDir, tmdb = () => null, log = console.log }) {
  let busy = null;                // a scan is running
  let queue = Promise.resolve();  // the last scan asked for
  const progress = { shelf: null, done: 0, total: 0, started: 0 };

  /** Inserts or updates an item. Fields that are null keep what was there (so Details aren't lost). */
  function upsert(f) {
    const now = Date.now();
    const cols = ["id", "shelf_id", "kind", "parent_id", "title", "sort_title", "year", "path", "size", "mtime", "duration", "overview", "age", "rating_label", "score", "genres", "studio",
      "season_no", "episode_no", "track_no", "disc_no", "artist", "album", "tmdb_id", "poster", "backdrop", "streams", "container", "subs", "premiered", "seen_scan"];
    const row = Object.fromEntries(cols.map((c) => [c, f[c] === undefined ? null : f[c]]));
    if (row.genres && typeof row.genres !== "string") row.genres = JSON.stringify(row.genres);
    if (row.streams && typeof row.streams !== "string") row.streams = JSON.stringify(row.streams);
    if (row.subs && typeof row.subs !== "string") row.subs = JSON.stringify(row.subs);
    row.sort_title ||= sortTitle(row.title || "");
    const keep = cols.filter((c) => !["id"].includes(c));
    db.run(`INSERT INTO items (${cols.join(",")}, added, missing) VALUES (${cols.map(() => "?").join(",")}, ?, 0)
      ON CONFLICT(id) DO UPDATE SET ${keep.map((c) => (["title", "sort_title", "kind", "shelf_id", "parent_id", "seen_scan", "path"].includes(c) ? `${c} = excluded.${c}` : `${c} = COALESCE(excluded.${c}, ${c})`)).join(", ")}, missing = 0`,
      ...cols.map((c) => row[c]), f.added || now);
  }

  const existing = (id) => db.get("SELECT id, size, mtime, streams, tmdb_id, overview, poster FROM items WHERE id = ?", id);

  /** Sidecar subtitles next to a video file. */
  function sidecars(file, siblings) {
    return siblings.filter((s) => SUBS.has(ext(s)) && s !== file).map((s) => { const i = subtitleInfo(s, file); return i && { file: s, format: ext(s).slice(1), ...i }; }).filter(Boolean);
  }

  async function probeIfChanged(id, file, st) {
    const old = existing(id);
    if (old && old.size === st.size && old.mtime === Math.floor(st.mtimeMs) && old.streams) return { old, info: null };
    try { return { old, info: await probe(file) }; } catch (e) { log(`[scan] can't read ${file}: ${e.message}`); return { old, info: { streams: [], duration: null, tags: {} } }; }
  }

  const fromNfo = (n) => n ? { title: n.title || undefined, overview: n.overview, year: n.year, rating_label: n.rating_label, age: ageOf(n.rating_label), score: n.score, genres: n.genres?.length ? n.genres : null, studio: n.studio, premiered: n.premiered, tmdb_id: n.tmdb_id } : {};
  const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && !(Array.isArray(v) && !v.length)));

  // ---- shelf kinds -----------------------------------------------------------------------------

  async function scanMovies(shelf, files, scan, tick) {
    const tm = tmdb();
    const videos = files.filter((f) => VIDEO.has(ext(f)));
    await pool(videos, 4, async (file) => {
      const st = fs.statSync(file), id = idOf(`${shelf.id}:${file}`);
      const dir = path.basename(path.dirname(file));
      const fromFolder = parseMovie(dir), fromFile = parseMovie(path.basename(file));
      // A movie in its own folder is named by the folder ("Heat (1995)/heat.1080p.mkv").
      const named = fromFolder.year && (!fromFile.year || fromFile.year === fromFolder.year) ? fromFolder : fromFile;
      const { old, info } = await probeIfChanged(id, file, st);
      const siblings = fs.readdirSync(path.dirname(file)).map((n) => path.join(path.dirname(file), n));
      const nfo = fromNfo(nfoFor(file, "movie")), art = localArt(file, "movie");
      let details = {};
      if (tm && (!old?.tmdb_id || !old?.overview)) {
        try { details = (await tm.movie({ ...named, tmdb_id: nfo.tmdb_id }, id)) || {}; } catch (e) { log(`[details] ${named.title}: ${e.message}`); }
      }
      upsert(clean({ id, shelf_id: shelf.id, kind: "movie", parent_id: null, path: file, size: st.size, mtime: Math.floor(st.mtimeMs), seen_scan: scan,
        title: named.title, year: named.year, ...(info ? { duration: info.duration, streams: info.streams, container: info.container } : {}), subs: sidecars(file, siblings),
        ...clean({ ...details, age: ageOf(details.rating_label), collection: undefined }), ...nfo, poster: art.poster || details.poster, backdrop: art.backdrop || details.backdrop }));
      if (details.collection) addToSet(`tmdb-${details.collection.id}`, details.collection.name, id);
      tick();
    });
  }

  function addToSet(setId, name, itemId) {
    db.run("INSERT OR IGNORE INTO sets (id, name, created) VALUES (?, ?, ?)", setId, name, Date.now());
    const pos = db.get("SELECT COALESCE(MAX(pos), 0) + 1 AS p FROM set_items WHERE set_id = ?", setId).p;
    db.run("INSERT OR IGNORE INTO set_items (set_id, item_id, pos) VALUES (?, ?, ?)", setId, itemId, pos);
  }

  // A show's bonus-material folder: its episodes go with Specials.
  const EXTRAS = /^(featurettes?|extras?|bonus( features)?|behind the scenes|deleted scenes)$/i;

  async function scanShows(shelf, files, scan, tick, roots) {
    const tm = tmdb();
    const videos = files.filter((f) => VIDEO.has(ext(f)));
    // The show: the first folder under the shelf's root. Episodes lying straight in a root are
    // either that folder's own show (the shelf points at the show) or, when their names say
    // different shows ("Name - S01E02…"), one show per name.
    const shows = new Map(); // key → { dir, title, eps }
    const add = (key, dir, title, f) => (shows.get(key) || shows.set(key, { dir, title, eps: [] }).get(key)).eps.push(f);
    const loose = new Map();
    for (const f of videos) {
      const root = roots.find((r) => f.startsWith(r + path.sep));
      if (!root) continue;
      const rel = path.relative(root, f).split(path.sep);
      if (rel.length > 1 && (seasonOf(rel[0]) !== null || EXTRAS.test(rel[0]))) add(root, root, null, f); // (the shelf points at one show's folder)
      else if (rel.length > 1) { const d = path.join(root, rel[0]); add(d, d, null, f); }
      else (loose.get(root) || loose.set(root, []).get(root)).push(f);
    }
    for (const [root, files] of loose) {
      const byName = new Map();
      for (const f of files) { const n = showNameOf(path.basename(f)); const k = n ? sortTitle(n) : ""; (byName.get(k) || byName.set(k, { title: n, files: [] }).get(k)).files.push(f); }
      const named = [...byName.keys()].filter(Boolean);
      if (named.length <= 1) for (const f of files) add(root, root, named.length ? byName.get(named[0]).title : null, f);
      else for (const [k, g] of byName) for (const f of g.files) add(k ? `${root}#${k}` : root, root, k ? g.title : null, f);
    }
    for (const [key, { dir, title, eps }] of shows) {
      const showId = idOf(`${shelf.id}:${key}`);
      const ownDir = key === dir; // (a real folder for this show: its .nfo and pictures)
      const named = parseShow(title || path.basename(dir));
      const nfo = ownDir ? fromNfo(nfoFor(dir, "show")) : {}, art = ownDir ? localArt(dir, "show") : {};
      const old = existing(showId);
      let details = {};
      if (tm && (!old?.tmdb_id || !old?.overview)) { try { details = (await tm.show({ ...named, tmdb_id: nfo.tmdb_id }, showId)) || {}; } catch (e) { log(`[details] ${named.title}: ${e.message}`); } }
      const showTmdb = nfo.tmdb_id || details.tmdb_id || old?.tmdb_id;
      upsert(clean({ id: showId, shelf_id: shelf.id, kind: "show", path: dir, seen_scan: scan, title: named.title, year: named.year,
        ...clean({ ...details, age: ageOf(details.rating_label) }), ...nfo, poster: art.poster || details.poster, backdrop: art.backdrop || details.backdrop }));
      const seasons = new Map();
      await pool(eps, 4, async (file) => {
        const st = fs.statSync(file);
        const p = parseEpisode(path.basename(file), path.basename(path.dirname(file)));
        const seasonNo = p?.season ?? seasonOf(path.basename(path.dirname(file))) ?? (EXTRAS.test(path.basename(path.dirname(file))) ? 0 : 1);
        const seasonId = idOf(`${showId}:season:${seasonNo}`);
        if (!seasons.has(seasonNo)) {
          seasons.set(seasonNo, seasonId);
          const sDir = path.dirname(file) !== dir ? path.dirname(file) : null;
          const sArt = sDir ? localArt(sDir, "show") : {};
          const showArt = localArt(dir, "show");
          const own = (() => { try { return fs.readdirSync(dir).find((n) => new RegExp(`^season[\\s._-]*0?${seasonNo}[\\s._-]*-?poster\\.(jpe?g|png|webp)$`, "i").test(n) || (seasonNo === 0 && /^season-specials-poster\./i.test(n))); } catch { return null; } })();
          upsert({ id: seasonId, shelf_id: shelf.id, kind: "season", parent_id: showId, title: seasonNo === 0 ? "Specials" : `Season ${seasonNo}`, season_no: seasonNo, seen_scan: scan,
            poster: own ? path.join(dir, own) : sArt.poster || null, sort_title: String(seasonNo).padStart(4, "0") });
          void showArt;
        }
        const id = idOf(`${shelf.id}:${file}`);
        const { info } = await probeIfChanged(id, file, st);
        const siblings = fs.readdirSync(path.dirname(file)).map((n) => path.join(path.dirname(file), n));
        const nfo2 = fromNfo(nfoFor(file, "episode")), art2 = localArt(file, "episode");
        const ep = p?.episode ?? null;
        upsert(clean({ id, shelf_id: shelf.id, kind: "episode", parent_id: seasonId, path: file, size: st.size, mtime: Math.floor(st.mtimeMs), seen_scan: scan,
          title: p?.title || (ep !== null ? `Episode ${ep}` : tidy(path.parse(file).name)), season_no: seasonNo, episode_no: ep,
          sort_title: `${String(seasonNo).padStart(4, "0")}-${String(ep ?? 9999).padStart(5, "0")}`,
          ...(info ? { duration: info.duration, streams: info.streams, container: info.container } : {}), subs: sidecars(file, siblings), ...nfo2, poster: art2.poster }));
        tick();
      });
      // Episode details from TMDB, a season at a time.
      if (tm && showTmdb) {
        for (const [no, sid] of seasons) {
          try {
            const s = await tm.season(showTmdb, no, sid);
            if (!s) continue;
            if (s.overview || s.poster) db.run("UPDATE items SET overview = COALESCE(overview, ?), poster = COALESCE(poster, ?) WHERE id = ?", s.overview, s.poster, sid);
            for (const e of db.all("SELECT id, episode_no, title, overview, poster FROM items WHERE parent_id = ? AND kind = 'episode'", sid)) {
              const d = s.eps.get(e.episode_no);
              if (!d) continue;
              const still = !e.poster && d.still ? await s.image(d.still, "w300", `${e.id}-still.jpg`) : null;
              db.run(`UPDATE items SET title = CASE WHEN title LIKE 'Episode %' THEN ? ELSE title END, overview = COALESCE(overview, ?), premiered = COALESCE(premiered, ?), score = COALESCE(score, ?), poster = COALESCE(poster, ?) WHERE id = ?`,
                d.title || e.title, d.overview, d.premiered, d.score, still, e.id);
            }
          } catch (e) { log(`[details] ${named.title} season ${no}: ${e.message}`); }
        }
      }
    }
  }

  async function scanMusic(shelf, files, scan, tick) {
    const tracks = files.filter((f) => AUDIO.has(ext(f)));
    const albums = new Map();
    await pool(tracks, 4, async (file) => {
      const st = fs.statSync(file), id = idOf(`${shelf.id}:${file}`);
      const { info } = await probeIfChanged(id, file, st);
      const dir = path.dirname(file);
      if (!info) {
        // Unchanged since the last scan: keep what its tags said then.
        const row = db.get("SELECT parent_id FROM items WHERE id = ?", id);
        const al = row && db.get("SELECT id, title, artist, parent_id, year, genres FROM items WHERE id = ?", row.parent_id);
        if (al) {
          db.run("UPDATE items SET seen_scan = ?, missing = 0 WHERE id = ?", scan, id);
          if (!albums.has(al.id)) albums.set(al.id, { artistId: al.parent_id, artistName: al.artist, albumName: al.title, dir, year: al.year, genre: JSON.parse(al.genres || "[]")[0] || null, cover: null });
          tick();
          return;
        }
      }
      const t = info?.tags || {};
      const old = null;
      // Tags first, then Artist/Album/track folders.
      const albumName = t.album || old?.album || path.basename(dir);
      const artistName = t.albumArtist || t.artist || old?.artist || path.basename(path.dirname(dir)) || "Unknown artist";
      const artistId = idOf(`${shelf.id}:artist:${artistName.toLowerCase()}`);
      const albumId = idOf(`${shelf.id}:album:${artistName.toLowerCase()}:${albumName.toLowerCase()}`);
      if (!albums.has(albumId)) albums.set(albumId, { artistId, artistName, albumName, dir, year: parseInt(t.date) || null, genre: t.genre, cover: info?.streams?.some((s) => s.cover) ? file : null });
      upsert(clean({ id, shelf_id: shelf.id, kind: "track", parent_id: albumId, path: file, size: st.size, mtime: Math.floor(st.mtimeMs), seen_scan: scan,
        title: t.title || tidy(path.parse(file).name.replace(/^\d{1,3}[\s._-]+/, "")), artist: t.artist || artistName, album: albumName,
        track_no: t.track || parseInt(path.basename(file)) || null, disc_no: t.disc, year: parseInt(t.date) || null, genres: t.genre ? [t.genre] : null,
        sort_title: `${String(t.disc || 1).padStart(2, "0")}-${String(t.track || parseInt(path.basename(file)) || 999).padStart(4, "0")}`,
        ...(info ? { duration: info.duration, streams: info.streams, container: info.container } : {}) }));
      tick();
    });
    const artists = new Set();
    for (const [albumId, a] of albums) {
      if (!artists.has(a.artistId)) {
        artists.add(a.artistId);
        upsert({ id: a.artistId, shelf_id: shelf.id, kind: "artist", title: a.artistName, seen_scan: scan, poster: localArt(path.dirname(a.dir), "artist").poster });
      }
      const art = localArt(a.dir, "album");
      let poster = art.poster;
      if (!poster && a.cover) {
        const out = path.join(artDir, `${albumId}-cover.jpg`);
        if (!fs.existsSync(out)) { try { const { grabImage } = await import("./probe.js"); await grabImage(a.cover, out, { cover: true, width: 600 }); } catch { /* no usable cover */ } }
        if (fs.existsSync(out)) poster = out;
      }
      upsert(clean({ id: albumId, shelf_id: shelf.id, kind: "album", parent_id: a.artistId, title: a.albumName, artist: a.artistName, year: a.year, genres: a.genre ? [a.genre] : null, seen_scan: scan, poster }));
    }
  }

  /** Photos and home videos: kept in their folders. */
  async function scanFolders(shelf, files, scan, tick, roots) {
    const want = shelf.kind === "photos" ? (f) => PHOTO.has(ext(f)) || VIDEO.has(ext(f)) : (f) => VIDEO.has(ext(f));
    const folderId = (dir, root) => (dir === root ? null : idOf(`${shelf.id}:${dir}`));
    const made = new Set();
    const ensureFolder = (dir, root) => {
      if (dir === root || made.has(dir)) return;
      made.add(dir);
      ensureFolder(path.dirname(dir), root);
      upsert({ id: folderId(dir, root), shelf_id: shelf.id, kind: "folder", parent_id: folderId(path.dirname(dir), root), path: dir, title: path.basename(dir), seen_scan: scan, sort_title: path.basename(dir).toLowerCase() });
    };
    await pool(files.filter(want), 4, async (file) => {
      const root = roots.find((r) => file.startsWith(r + path.sep));
      const dir = path.dirname(file);
      ensureFolder(dir, root);
      const st = fs.statSync(file), id = idOf(`${shelf.id}:${file}`);
      const isVideo = VIDEO.has(ext(file));
      const { info } = isVideo ? await probeIfChanged(id, file, st) : { info: null };
      upsert(clean({ id, shelf_id: shelf.id, kind: isVideo ? "video" : "photo", parent_id: folderId(dir, root), path: file, size: st.size, mtime: Math.floor(st.mtimeMs), seen_scan: scan,
        title: isVideo ? tidy(path.parse(file).name) : path.basename(file), sort_title: `${String(Math.floor(st.mtimeMs)).padStart(15, "0")}`,
        premiered: new Date(st.mtimeMs).toISOString().slice(0, 10), ...(info ? { duration: info.duration, streams: info.streams, container: info.container } : {}) }));
      tick();
    });
  }

  // ---- a whole shelf -------------------------------------------------------------------------

  async function scanShelf(shelf) {
    const roots = JSON.parse(shelf.paths).map((p) => path.resolve(p));
    const present = roots.filter((r) => fs.existsSync(r));
    const scan = Date.now();
    const files = present.flatMap(walk);
    progress.shelf = shelf.name; progress.done = 0; progress.total = files.length; progress.started = scan;
    const tick = () => { progress.done++; };
    if (shelf.kind === "movies") await scanMovies(shelf, files, scan, tick);
    else if (shelf.kind === "shows") await scanShows(shelf, files, scan, tick, present);
    else if (shelf.kind === "music") await scanMusic(shelf, files, scan, tick);
    else await scanFolders(shelf, files, scan, tick, present);

    // Gone from disk: missing (only under folders that are actually there; an unplugged drive isn't "deleted").
    const gone = db.all("SELECT id, path, kind FROM items WHERE shelf_id = ? AND (seen_scan IS NULL OR seen_scan < ?) AND missing = 0", shelf.id, scan)
      .filter((i) => !i.path || present.some((r) => i.path.startsWith(r)));
    db.tx(() => {
      for (const i of gone) db.run("UPDATE items SET missing = 1, seen_scan = COALESCE(seen_scan, 0) WHERE id = ?", i.id);
      db.run("DELETE FROM items WHERE shelf_id = ? AND missing = 1 AND seen_scan < ?", shelf.id, scan - MISSING_FOR);
      db.run("UPDATE shelves SET scanned = ? WHERE id = ?", scan, shelf.id);
    });
    const count = db.get("SELECT COUNT(*) AS n FROM items WHERE shelf_id = ? AND missing = 0", shelf.id).n;
    db.log("scan", `Scanned ${shelf.name}: ${count} items${gone.length ? `, ${gone.length} gone` : ""}${present.length < roots.length ? ` (${roots.length - present.length} folder(s) not reachable)` : ""}.`);
    return { count, gone: gone.length, unreachable: roots.length - present.length };
  }

  return {
    progress: () => (busy ? { ...progress } : null),
    /** Scans one shelf (id) or all of them; one scan at a time (a second request waits for the first). */
    scan(shelfId = null) {
      // Queued behind whatever is running (never two at once: a scan marks what the other hasn't seen as gone).
      const prev = queue;
      const mine = (async () => {
        await prev.catch(() => {});
        const shelves = shelfId ? db.all("SELECT * FROM shelves WHERE id = ?", shelfId) : db.all("SELECT * FROM shelves");
        busy = true;
        try { const out = {}; for (const s of shelves) out[s.id] = await scanShelf(s); return out; } finally { busy = queue === mine ? null : busy; }
      })();
      queue = mine;
      return mine;
    },
  };
}
