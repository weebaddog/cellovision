// Everything Cellovision knows, in one SQLite file (Node's built-in node:sqlite, no packages).
// Media files themselves are never copied: the database only points at them.

import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  // Profiles (people). admin = may use the Control Room. max_age = Age Limit (null = none).
  `CREATE TABLE IF NOT EXISTS profiles (
     id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, pass_hash TEXT, admin INTEGER NOT NULL DEFAULT 0,
     max_age INTEGER, shelves TEXT, created INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sessions (
     token_hash TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
     device TEXT, client TEXT, created INTEGER NOT NULL, last_seen INTEGER NOT NULL)`,
  // Shelves (what Jellyfin-style servers call libraries). kind: movies | shows | music | photos | videos
  `CREATE TABLE IF NOT EXISTS shelves (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, paths TEXT NOT NULL, created INTEGER NOT NULL, scanned INTEGER)`,
  // Everything on a shelf. kind: movie | show | season | episode | artist | album | track | photo | video | folder
  `CREATE TABLE IF NOT EXISTS items (
     id TEXT PRIMARY KEY, shelf_id TEXT NOT NULL REFERENCES shelves(id) ON DELETE CASCADE, kind TEXT NOT NULL,
     parent_id TEXT, title TEXT NOT NULL, sort_title TEXT, year INTEGER, path TEXT, size INTEGER, mtime INTEGER,
     duration REAL, overview TEXT, age INTEGER, rating_label TEXT, score REAL, genres TEXT, studio TEXT,
     season_no INTEGER, episode_no INTEGER, track_no INTEGER, disc_no INTEGER, artist TEXT, album TEXT,
     tmdb_id TEXT, poster TEXT, backdrop TEXT, streams TEXT, container TEXT, subs TEXT, added INTEGER NOT NULL, premiered TEXT,
     seen_scan INTEGER, missing INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS items_parent ON items(parent_id)`,
  `CREATE INDEX IF NOT EXISTS items_shelf_kind ON items(shelf_id, kind)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS items_path ON items(path) WHERE path IS NOT NULL`,
  // Per-profile: where you stopped, watched, Hearts.
  `CREATE TABLE IF NOT EXISTS marks (
     profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE, item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
     position REAL NOT NULL DEFAULT 0, played INTEGER NOT NULL DEFAULT 0, plays INTEGER NOT NULL DEFAULT 0,
     last_played INTEGER, heart INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (profile_id, item_id))`,
  // Sets (hand-made or automatic groups) and Mixtapes (a profile's ordered lists).
  `CREATE TABLE IF NOT EXISTS sets (id TEXT PRIMARY KEY, name TEXT NOT NULL, overview TEXT, poster TEXT, created INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS set_items (set_id TEXT NOT NULL REFERENCES sets(id) ON DELETE CASCADE, item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE, pos INTEGER NOT NULL, PRIMARY KEY (set_id, item_id))`,
  `CREATE TABLE IF NOT EXISTS mixtapes (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE, name TEXT NOT NULL, created INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS mixtape_items (mixtape_id TEXT NOT NULL REFERENCES mixtapes(id) ON DELETE CASCADE, item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE, pos INTEGER NOT NULL)`,
  // What happened (Control Room).
  `CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, profile_id TEXT, kind TEXT NOT NULL, text TEXT NOT NULL)`,
];

export function openDb(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "cellovision.db"));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  for (const s of SCHEMA) db.exec(s);

  const cache = new Map();
  const stmt = (sql) => { let s = cache.get(sql); if (!s) { s = db.prepare(sql); cache.set(sql, s); } return s; };

  const api = {
    raw: db,
    all: (sql, ...p) => stmt(sql).all(...p),
    get: (sql, ...p) => stmt(sql).get(...p),
    run: (sql, ...p) => stmt(sql).run(...p),
    tx(fn) {
      db.exec("BEGIN");
      try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; }
    },
    setting(key, fallback = null) {
      const r = stmt("SELECT value FROM settings WHERE key = ?").get(key);
      return r ? JSON.parse(r.value) : fallback;
    },
    setSetting(key, value) {
      stmt("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value));
    },
    log(kind, text, profileId = null) {
      stmt("INSERT INTO activity (at, profile_id, kind, text) VALUES (?, ?, ?, ?)").run(Date.now(), profileId, kind, text);
      stmt("DELETE FROM activity WHERE id < (SELECT MAX(id) - 2000 FROM activity)").run();
    },
    close: () => db.close(),
  };
  return api;
}
