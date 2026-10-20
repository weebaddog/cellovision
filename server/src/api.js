// The HTTP API every Cellovision app uses (web, Windows, Linux, Android, iPhone, Apple TV), and the
// web app's files. Signed-in requests carry the token as `Authorization: Bearer …`, the `cv` cookie
// (web app), or `?t=` on media addresses (players that can't add headers).

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { shape, tracks } from "./library.js";
import { decide, sendFile, mimeOf } from "./stream.js";

const fail = (status, message) => Object.assign(new Error(message), { status });
const SHELF_KINDS = ["movies", "shows", "music", "photos", "videos"];
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".webmanifest": "application/manifest+json", ".ico": "image/x-icon" };
const j = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

export function createApi({ db, auth, lib, scanner, streamer, images, reports, webDir, version, log = console.log, tls = null }) {
  const nowPlaying = new Map(); // token hash → { profile, device, item, position, paused, at, mode }
  const reportsFrom = new Map(); // ip → [times] (problem reports: at most 30 an hour from one address)

  // ---- plumbing ------------------------------------------------------------------------------

  function tokenOf(req, url) {
    const h = String(req.headers.authorization || "");
    if (h.startsWith("Bearer ")) return h.slice(7);
    const c = String(req.headers.cookie || "").match(/(?:^|;\s*)cv=([A-Za-z0-9_-]{20,})/);
    if (c) return c[1];
    if (/^\/api\/(file|hls|subs|img)\//.test(url.pathname)) return url.searchParams.get("t");
    return null;
  }
  async function body(req) {
    const chunks = []; let n = 0;
    for await (const c of req) { n += c.length; if (n > 1 << 20) throw fail(413, "Too big"); chunks.push(c); }
    if (!n) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw fail(400, "Bad JSON"); }
  }
  function json(res, status, data, headers = {}) {
    const text = JSON.stringify(data);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
    res.end(text);
  }
  const cookie = (token, req) => `cv=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${400 * 86400}${req?.socket?.encrypted ? "; Secure" : ""}`;
  const admin = (me) => { if (!me.admin) throw fail(403, "Only the server's admins can do that"); };
  const shelfFor = (me, id) => { const s = db.get("SELECT * FROM shelves WHERE id = ?", id); if (!s || (me.shelves && !me.shelves.includes(s.id))) throw fail(404, "No such shelf"); return s; };
  const itemFor = (me, id) => { const i = lib.get(me, id); if (!i) throw fail(404, "Not found (or not for this profile)"); return i; };

  /** An item with everything its page needs. */
  function itemPage(me, i) {
    const out = lib.many(me, "SELECT * FROM items WHERE id = ?", i.id)[0];
    const parents = [];
    for (let p = i.parent_id && db.get("SELECT * FROM items WHERE id = ?", i.parent_id); p; p = p.parent_id && db.get("SELECT * FROM items WHERE id = ?", p.parent_id)) parents.unshift({ id: p.id, kind: p.kind, title: p.title });
    out.parents = parents;
    if (["movie", "episode", "video", "track"].includes(i.kind)) out.tracks = tracks(i);
    if (["show", "season", "artist", "album", "folder"].includes(i.kind)) out.children = lib.children(me, i.id);
    if (i.kind === "show") {
      out.seasons = out.children;
      const next = lib.upNext(me, 50).find((e) => e.showId === i.id);
      out.next = next || lib.many(me, `SELECT i.* FROM items i JOIN items se ON se.id = i.parent_id WHERE se.parent_id = ? AND i.kind = 'episode' AND i.season_no > 0 AND i.missing = 0 ORDER BY i.season_no, i.episode_no LIMIT 1`, i.id)[0] || null;
    }
    if (i.kind === "episode") out.nextEpisode = lib.nextEpisode(me, i);
    if (i.kind === "artist") out.tracksCount = db.get("SELECT COUNT(*) AS n FROM items t JOIN items a ON a.id = t.parent_id WHERE a.parent_id = ? AND t.missing = 0", i.id).n;
    out.sets = db.all("SELECT s.id, s.name FROM set_items si JOIN sets s ON s.id = si.set_id WHERE si.item_id = ?", i.id);
    if (i.kind === "movie" && i.genres) {
      const g = j(i.genres, [])[0];
      if (g) out.similar = lib.many(me, `SELECT i.* FROM items i WHERE i.kind = 'movie' AND i.id != ? AND i.missing = 0 AND i.genres LIKE ? ORDER BY RANDOM() LIMIT 12`, i.id, `%"${g.replace(/["%_]/g, "")}"%`)
        .filter((x) => lib.get(me, x.id));
    }
    return out;
  }

  /** Marks a show, season, album or folder's playable things, or one item. */
  function markAll(me, i, m) {
    const kids = { show: `SELECT e.id FROM items e JOIN items se ON se.id = e.parent_id WHERE se.parent_id = ? AND e.kind = 'episode'`,
      season: `SELECT id FROM items WHERE parent_id = ? AND kind = 'episode'`, album: `SELECT id FROM items WHERE parent_id = ? AND kind = 'track'` }[i.kind];
    if (kids && "played" in m) db.tx(() => { for (const r of db.all(kids, i.id)) lib.setMark(me.id, r.id, { played: m.played }); });
    return lib.setMark(me.id, i.id, m);
  }

  // ---- routes --------------------------------------------------------------------------------

  const open = {
    "GET /api/hello": () => ({ name: db.setting("serverName", `${os.hostname()} Cellovision`), version, setUp: auth.count() > 0,
      // HTTPS: where, and the certificate's fingerprint (apps trust it once, then accept only it).
      https: tls?.port() ? { port: tls.port(), fingerprint: tls.fingerprint } : null, plainHttp: db.setting("plainHttp", true),
      profiles: auth.profiles().map((p) => ({ id: p.id, name: p.name, hasPassword: !!p.has_password })) }),
    "POST /api/setup": async (req, res) => {
      if (auth.count() > 0) throw fail(409, "Already set up");
      const b = await body(req);
      if (String(b.password || "").length < 6) throw fail(400, "Pick a password of at least 6 characters for the admin profile");
      const id = auth.create({ name: b.name || "Admin", password: b.password, admin: true });
      if (b.serverName) db.setSetting("serverName", String(b.serverName).slice(0, 60));
      const token = auth.signIn(b.name || "Admin", b.password, b.device, b.client, req.socket.remoteAddress);
      db.log("profile", `Server set up; admin profile ${b.name || "Admin"} made.`, id);
      return [{ token }, { "set-cookie": cookie(token, req) }];
    },
    "POST /api/signin": async (req) => {
      const b = await body(req);
      const token = auth.signIn(b.name, b.password, b.device, b.client, req.socket.remoteAddress);
      return [{ token }, b.web ? { "set-cookie": cookie(token, req) } : {}];
    },
    /** The web app signed in another way (Pair Code): keep that sign-in as its cookie. */
    "POST /api/session": async (req) => {
      const b = await body(req);
      if (!auth.who(String(b.token || ""))) throw fail(401, "Sign in");
      return [{ ok: true }, { "set-cookie": cookie(String(b.token), req) }];
    },
    /** A problem from any app (also before signing in: a crash can happen on the way). */
    "POST /api/report": async (req) => {
      const ip = req.socket.remoteAddress || "";
      const list = (reportsFrom.get(ip) || []).filter((t) => Date.now() - t < 3600_000);
      if (list.length >= 30) throw fail(429, "Too many reports; thanks, we have plenty");
      list.push(Date.now()); reportsFrom.set(ip, list);
      const b = await body(req);
      const t = tokenOf(req, new URL(req.url, "http://x"));
      const me = t && auth.who(t);
      reports.add({ ...b, profile: me?.name || null }, b.kind === "user");
      return { ok: true };
    },
    "POST /api/pair/start": async (req) => { const b = await body(req); return auth.pairStart(String(b.device || "TV").slice(0, 60), String(b.client || "").slice(0, 40)); },
    "POST /api/pair/check": async (req) => { const b = await body(req); return auth.pairCheck(String(b.code || ""), String(b.secret || "")); },
  };

  const routes = {
    "POST /api/signout": (req, res, me, url, token) => { auth.signOut(token); return [{ ok: true }, { "set-cookie": "cv=; Path=/; Max-Age=0" }]; },
    "GET /api/me": (req, res, me) => ({ id: me.id, name: me.name, admin: me.admin, maxAge: me.max_age, shelves: lib.shelves(me) }),
    "GET /api/me/devices": (req, res, me) => ({ devices: auth.devices(me.id) }),
    "DELETE /api/me/devices": async (req, res, me) => { auth.forgetDevice(me.id, (await body(req)).id); return { ok: true }; },
    "POST /api/pair/approve": async (req, res, me) => { const r = auth.pairApprove((await body(req)).code, me.id); db.log("pair", `${me.name} signed in "${r.device}" with a Pair Code.`, me.id); return r; },

    "GET /api/home": (req, res, me) => {
      const shelves = lib.shelves(me);
      return { keepWatching: lib.keepWatching(me), upNext: lib.upNext(me), shelves,
        latest: shelves.map((s) => ({ shelf: s, items: lib.latest(me, db.get("SELECT * FROM shelves WHERE id = ?", s.id)) })).filter((r) => r.items.length) };
    },
    "GET /api/shelves": (req, res, me) => ({ shelves: lib.shelves(me) }),
    // A media-only token for this device to open pictures/files/streams by URL (not the account token).
    "GET /api/media-token": (req, res, me) => ({ token: auth.mediaToken(me.token_hash) }),
    "GET /api/browse": (req, res, me, url) => lib.browse(me, shelfFor(me, url.searchParams.get("shelf")), Object.fromEntries(url.searchParams)),
    "GET /api/item": (req, res, me, url) => itemPage(me, itemFor(me, url.searchParams.get("id"))),
    "GET /api/search": (req, res, me, url) => ({ items: lib.search(me, url.searchParams.get("q") || "") }),
    "GET /api/hearts": (req, res, me) => ({ items: lib.many(me, `SELECT i.* FROM marks m JOIN items i ON i.id = m.item_id WHERE m.profile_id = ? AND m.heart = 1 AND i.missing = 0 ORDER BY m.last_played DESC NULLS LAST`, me.id).filter((x) => lib.get(me, x.id)) }),
    "POST /api/mark": async (req, res, me) => { const b = await body(req); const i = itemFor(me, b.id); return { mark: markAll(me, i, b) }; },

    // Playback
    "POST /api/play": async (req, res, me, url, token) => {
      const b = await body(req);
      const i = itemFor(me, b.id);
      if (!i.path) throw fail(400, "Nothing to play here");
      const item = { ...i, streams: j(i.streams, []), subs: j(i.subs, []) };
      if (i.kind === "photo") return { mode: "direct", url: `/api/file/${i.id}` };
      const plan = decide(item, b.caps || {}, { audio: b.audio, sub: b.sub === null || b.sub === undefined ? null : isNaN(+b.sub) ? b.sub : +b.sub, burn: !!b.burn });
      const force = b.force === "convert" || b.force === "remux" ? b.force : null;
      if (force && !(force === "remux" && plan.mode === "convert")) plan.mode = force;
      const mark = lib.markOf(me.id, i.id);
      const resume = b.start !== undefined ? +b.start : mark && !mark.played && mark.position > 30 ? mark.position : 0;
      const subKey = b.sub === null || b.sub === undefined || plan.burn ? null : String(b.sub);
      const base = { mode: plan.mode, reasons: plan.reasons, resume, tracks: tracks(i), duration: i.duration };
      if (plan.mode === "direct") return { ...base, url: `/api/file/${i.id}`, start: 0, subtitle: subKey ? `/api/subs/${i.id}/${subKey}.vtt` : null };
      const start = Math.max(0, Math.floor(b.hlsStart ?? resume));
      const s = await streamer.startHls(item, plan, { start, maxHeight: b.caps?.maxHeight || null, owner: me.token_hash });
      return { ...base, url: `/api/hls/${s.id}/index.m3u8`, session: s.id, start, encoder: s.encoder, subtitle: subKey ? `/api/subs/${i.id}/${subKey}.vtt?from=${start}` : null };
    },
    "POST /api/playing": async (req, res, me, url, token) => {
      const b = await body(req);
      const key = crypto.createHash("sha256").update(token).digest("hex");
      if (b.stopped) nowPlaying.delete(key);
      const i = lib.get(me, b.id);
      if (!i) return { ok: false };
      if (!b.stopped) nowPlaying.set(key, { profile: me.name, device: me.device || me.client || "a device", item: { id: i.id, title: i.title, kind: i.kind }, position: +b.position || 0, paused: !!b.paused, mode: b.mode || null, at: Date.now() });
      // Watched once 90% through (or the last 3 minutes of a film).
      const pos = +b.position || 0;
      const done = i.duration && (pos >= i.duration * 0.9 || (i.duration > 1800 && i.duration - pos < 180));
      if (done) lib.setMark(me.id, i.id, { played: true });
      else if (pos > 0) lib.setMark(me.id, i.id, { position: pos });
      return { ok: true, played: !!done };
    },
    "DELETE /api/hls": async (req, res, me) => { streamer.stop((await body(req)).session); return { ok: true }; },

    // Sets (shared groups of items) and Mixtapes (each profile's own lists)
    "GET /api/sets": (req, res, me) => ({ sets: db.all("SELECT s.*, (SELECT COUNT(*) FROM set_items si WHERE si.set_id = s.id) AS count, (SELECT si.item_id FROM set_items si WHERE si.set_id = s.id ORDER BY pos LIMIT 1) AS cover FROM sets s ORDER BY name") }),
    "GET /api/set": (req, res, me, url) => {
      const s = db.get("SELECT * FROM sets WHERE id = ?", url.searchParams.get("id"));
      if (!s) throw fail(404, "No such set");
      return { ...s, items: lib.many(me, "SELECT i.* FROM set_items si JOIN items i ON i.id = si.item_id WHERE si.set_id = ? AND i.missing = 0 ORDER BY i.year, si.pos", s.id).filter((x) => lib.get(me, x.id)) };
    },
    "POST /api/sets": async (req, res, me) => { admin(me); const b = await body(req); const id = crypto.randomBytes(6).toString("hex"); db.run("INSERT INTO sets (id, name, overview, created) VALUES (?, ?, ?, ?)", id, String(b.name || "New set").slice(0, 80), b.overview || null, Date.now()); return { id }; },
    "POST /api/set/items": async (req, res, me) => {
      admin(me); const b = await body(req);
      if (b.remove) db.run("DELETE FROM set_items WHERE set_id = ? AND item_id = ?", b.set, b.item);
      else db.run("INSERT OR IGNORE INTO set_items (set_id, item_id, pos) VALUES (?, ?, (SELECT COALESCE(MAX(pos),0)+1 FROM set_items WHERE set_id = ?))", b.set, itemFor(me, b.item).id, b.set);
      return { ok: true };
    },
    "DELETE /api/sets": async (req, res, me) => { admin(me); db.run("DELETE FROM sets WHERE id = ?", (await body(req)).id); return { ok: true }; },

    "GET /api/mixtapes": (req, res, me) => ({ mixtapes: db.all("SELECT m.*, (SELECT COUNT(*) FROM mixtape_items x WHERE x.mixtape_id = m.id) AS count FROM mixtapes m WHERE profile_id = ? ORDER BY name", me.id) }),
    "GET /api/mixtape": (req, res, me, url) => {
      const m = db.get("SELECT * FROM mixtapes WHERE id = ? AND profile_id = ?", url.searchParams.get("id"), me.id);
      if (!m) throw fail(404, "No such mixtape");
      return { ...m, items: lib.many(me, "SELECT i.* FROM mixtape_items x JOIN items i ON i.id = x.item_id WHERE x.mixtape_id = ? AND i.missing = 0 ORDER BY x.pos", m.id) };
    },
    "POST /api/mixtapes": async (req, res, me) => { const b = await body(req); const id = crypto.randomBytes(6).toString("hex"); db.run("INSERT INTO mixtapes (id, profile_id, name, created) VALUES (?, ?, ?, ?)", id, me.id, String(b.name || "New mixtape").slice(0, 80), Date.now()); return { id }; },
    "POST /api/mixtape/items": async (req, res, me) => {
      const b = await body(req);
      if (!db.get("SELECT 1 FROM mixtapes WHERE id = ? AND profile_id = ?", b.mixtape, me.id)) throw fail(404, "No such mixtape");
      if (b.remove) db.run("DELETE FROM mixtape_items WHERE mixtape_id = ? AND item_id = ?", b.mixtape, b.item);
      else {
        // An album or show adds all its tracks/episodes.
        const i = itemFor(me, b.item);
        const ids = i.kind === "album" ? db.all("SELECT id FROM items WHERE parent_id = ? AND missing = 0 ORDER BY sort_title", i.id).map((r) => r.id) : [i.id];
        db.tx(() => { for (const id of ids) db.run("INSERT INTO mixtape_items (mixtape_id, item_id, pos) VALUES (?, ?, (SELECT COALESCE(MAX(pos),0)+1 FROM mixtape_items WHERE mixtape_id = ?))", b.mixtape, id, b.mixtape); });
      }
      return { ok: true };
    },
    "DELETE /api/mixtapes": async (req, res, me) => { db.run("DELETE FROM mixtapes WHERE id = ? AND profile_id = ?", (await body(req)).id, me.id); return { ok: true }; },

    // ---- Control Room (admins) -----------------------------------------------------------------
    "GET /api/control": (req, res, me) => {
      admin(me);
      for (const [k, v] of nowPlaying) if (Date.now() - v.at > 120_000) nowPlaying.delete(k);
      return {
        version, serverName: db.setting("serverName", `${os.hostname()} Cellovision`), dataDir: db.dataDir,
        scanning: scanner.progress(), playing: [...nowPlaying.values()], conversions: streamer.list(),
        shelves: db.all("SELECT s.*, (SELECT COUNT(*) FROM items i WHERE i.shelf_id = s.id AND i.missing = 0) AS items FROM shelves s ORDER BY name").map((s) => ({ ...s, paths: j(s.paths, []) })),
        profiles: auth.profiles().map((p) => ({ ...p, admin: !!p.admin, shelves: j(p.shelves), hasPassword: !!p.has_password })),
        activity: db.all("SELECT * FROM activity ORDER BY id DESC LIMIT 60"),
        settings: { tmdbKey: db.setting("tmdbKey") ? "set" : "", encoder: db.setting("encoder", "auto"), scanEvery: db.setting("scanEvery", 6), plainHttp: db.setting("plainHttp", true) },
        https: tls?.port() ? { port: tls.port(), fingerprint: tls.fingerprint } : null,
      };
    },
    "POST /api/control/shelves": async (req, res, me) => {
      admin(me); const b = await body(req);
      if (!SHELF_KINDS.includes(b.kind)) throw fail(400, "Pick what's on the shelf");
      const paths = (b.paths || []).map((p) => path.resolve(String(p))).filter(Boolean);
      if (!paths.length) throw fail(400, "Add at least one folder");
      for (const p of paths) if (!fs.existsSync(p)) throw fail(400, `Can't find ${p}`);
      const id = crypto.randomBytes(6).toString("hex");
      db.run("INSERT INTO shelves (id, name, kind, paths, created) VALUES (?, ?, ?, ?, ?)", id, String(b.name || b.kind).slice(0, 60), b.kind, JSON.stringify(paths), Date.now());
      db.log("shelf", `${me.name} added the shelf ${b.name}.`, me.id);
      scanner.scan(id).catch((e) => log(`[scan] ${e.message}`));
      return { id };
    },
    "PUT /api/control/shelves": async (req, res, me) => {
      admin(me); const b = await body(req);
      const s = db.get("SELECT * FROM shelves WHERE id = ?", b.id);
      if (!s) throw fail(404, "No such shelf");
      if (b.paths) for (const p of b.paths) if (!fs.existsSync(p)) throw fail(400, `Can't find ${p}`);
      db.run("UPDATE shelves SET name = COALESCE(?, name), paths = COALESCE(?, paths) WHERE id = ?", b.name ? String(b.name).slice(0, 60) : null, b.paths ? JSON.stringify(b.paths.map((p) => path.resolve(p))) : null, s.id);
      if (b.paths) scanner.scan(s.id).catch(() => {});
      return { ok: true };
    },
    "DELETE /api/control/shelves": async (req, res, me) => { admin(me); const b = await body(req); db.run("DELETE FROM shelves WHERE id = ?", b.id); db.log("shelf", `${me.name} removed a shelf.`, me.id); return { ok: true }; },
    "POST /api/control/scan": async (req, res, me) => { admin(me); const b = await body(req); scanner.scan(b.id || null).catch((e) => log(`[scan] ${e.message}`)); return { ok: true }; },
    "POST /api/control/profiles": async (req, res, me) => {
      admin(me); const b = await body(req);
      const id = auth.create({ name: b.name, password: b.password || null, admin: !!b.admin, maxAge: b.maxAge ?? null, shelves: b.shelves || null });
      db.log("profile", `${me.name} made the profile ${b.name}.`, me.id);
      return { id };
    },
    "PUT /api/control/profiles": async (req, res, me) => {
      admin(me); const b = await body(req);
      const p = db.get("SELECT * FROM profiles WHERE id = ?", b.id);
      if (!p) throw fail(404, "No such profile");
      if ("admin" in b && !b.admin && p.admin && db.get("SELECT COUNT(*) AS n FROM profiles WHERE admin = 1").n <= 1) throw fail(400, "Keep at least one admin");
      const { hashPassword } = await import("./auth.js");
      db.run(`UPDATE profiles SET name = COALESCE(?, name), admin = COALESCE(?, admin), max_age = CASE WHEN ? THEN ? ELSE max_age END,
        shelves = CASE WHEN ? THEN ? ELSE shelves END, pass_hash = CASE WHEN ? THEN ? ELSE pass_hash END WHERE id = ?`,
        b.name ? String(b.name).slice(0, 40) : null, "admin" in b ? (b.admin ? 1 : 0) : null,
        "maxAge" in b ? 1 : 0, b.maxAge ?? null, "shelves" in b ? 1 : 0, b.shelves ? JSON.stringify(b.shelves) : null,
        "password" in b ? 1 : 0, b.password ? hashPassword(b.password) : null, p.id);
      if ("password" in b) db.run("DELETE FROM sessions WHERE profile_id = ? AND profile_id != ?", p.id, me.id);
      return { ok: true };
    },
    "DELETE /api/control/profiles": async (req, res, me) => {
      admin(me); const b = await body(req);
      if (b.id === me.id) throw fail(400, "You can't delete the profile you're using");
      db.run("DELETE FROM profiles WHERE id = ?", b.id);
      return { ok: true };
    },
    "PUT /api/control/settings": async (req, res, me) => {
      admin(me); const b = await body(req);
      if (typeof b.serverName === "string") db.setSetting("serverName", b.serverName.slice(0, 60) || os.hostname());
      if (typeof b.tmdbKey === "string") db.setSetting("tmdbKey", b.tmdbKey.trim() || null);
      if (typeof b.encoder === "string") db.setSetting("encoder", ["auto", "libx264", "h264_amf", "h264_nvenc", "h264_qsv", "h264_videotoolbox", "h264_vaapi"].includes(b.encoder) ? b.encoder : "auto");
      if (b.scanEvery !== undefined) db.setSetting("scanEvery", Math.max(0, Math.min(168, +b.scanEvery || 0)));
      if ("plainHttp" in b) db.setSetting("plainHttp", !!b.plainHttp);
      return { ok: true };
    },
    // Problem reports: the list, and where they're emailed.
    "GET /api/control/reports": (req, res, me) => { admin(me); return { reports: reports.list(), mail: reports.settings() }; },
    "PUT /api/control/reports": async (req, res, me) => { admin(me); reports.save(await body(req)); return { mail: reports.settings() }; },
    "POST /api/control/reports/test": async (req, res, me) => {
      admin(me);
      try { await reports.test(); } catch (e) { throw fail(e.status || 400, e.message); }
      return { ok: true };
    },
    /** Folders on this computer, to pick media folders from. */
    "GET /api/control/folders": (req, res, me, url) => {
      admin(me);
      const at = url.searchParams.get("path");
      if (!at) {
        if (process.platform === "win32") return { path: "", folders: "CDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((d) => `${d}:\\`).filter((d) => fs.existsSync(d)) };
        return { path: "/", folders: fs.readdirSync("/", { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => `/${d.name}`) };
      }
      const full = path.resolve(at);
      let list;
      try { list = fs.readdirSync(full, { withFileTypes: true }); } catch { throw fail(404, "Can't open that folder"); }
      return { path: full, parent: path.dirname(full) !== full ? path.dirname(full) : "", folders: list.filter((d) => d.isDirectory() && !d.name.startsWith(".") && !d.name.startsWith("$")).map((d) => path.join(full, d.name)).sort() };
    },
  };

  // ---- media (signed in; may use ?t=) ----------------------------------------------------------

  async function media(req, res, me, url) {
    let m;
    if ((m = url.pathname.match(/^\/api\/file\/([a-f0-9]{20})$/))) {
      const i = itemFor(me, m[1]);
      return sendFile(req, res, i.path, { "cache-control": "private, max-age=3600" });
    }
    if ((m = url.pathname.match(/^\/api\/hls\/([A-Za-z0-9_-]+)\/(index\.m3u8|init\.mp4|s\d{5}\.(?:ts|m4s))$/))) {
      const s = streamer.get(m[1]);
      if (!s || s.owner !== me.token_hash) throw fail(404, "That playback ended");
      const file = await streamer.hlsFile(m[1], m[2]);
      if (!file) throw fail(404, "Not ready");
      if (m[2] === "index.m3u8") {
        // Segment addresses carry a media-only token (players fetch them without our headers; a
        // URL must never carry the account token — it would end up in history and caches).
        const t = encodeURIComponent(auth.mediaToken(me.token_hash));
        const text = fs.readFileSync(file, "utf8").replace(/^(s\d{5}\.(?:ts|m4s))$/gm, `$1?t=${t}`).replace(/URI="init\.mp4"/, `URI="init.mp4?t=${t}"`);
        res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl", "cache-control": "no-store" });
        return res.end(text);
      }
      return sendFile(req, res, file, { "cache-control": "private, max-age=3600" });
    }
    if ((m = url.pathname.match(/^\/api\/subs\/([a-f0-9]{20})\/(\d+|f\d+)\.vtt$/))) {
      const i = itemFor(me, m[1]);
      const out = await streamer.subtitle({ ...i, streams: j(i.streams, []), subs: j(i.subs, []) }, m[2], +url.searchParams.get("from") || 0);
      if (!out) throw fail(404, "No such subtitles");
      return sendFile(req, res, out, { "content-type": "text/vtt; charset=utf-8" });
    }
    if ((m = url.pathname.match(/^\/api\/img\/([a-f0-9]{20}|set-[\w-]+)\/(poster|backdrop)$/))) {
      let id = m[1];
      if (id.startsWith("set-")) { id = db.get("SELECT item_id FROM set_items WHERE set_id = ? ORDER BY pos LIMIT 1", id.slice(4))?.item_id; if (!id) throw fail(404, "No picture"); }
      const i = itemFor(me, id);
      const file = await images.forItem(db, i, m[2], +url.searchParams.get("w") || 480);
      if (!file) throw fail(404, "No picture");
      return sendFile(req, res, file, { "cache-control": "private, max-age=86400", "content-type": "image/jpeg" });
    }
    return false;
  }

  // ---- the web app ---------------------------------------------------------------------------

  function serveWeb(req, res, url) {
    let rel = decodeURIComponent(url.pathname);
    if (rel === "/" || !path.extname(rel)) rel = "/index.html"; // (the app routes itself)
    const file = path.join(webDir, rel);
    if (!file.startsWith(webDir + path.sep)) { res.writeHead(404); return res.end(); }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404, { "content-type": "text/plain" }); return res.end("Not found"); }
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] || mimeOf(file), "cache-control": rel.startsWith("/vendor/") ? "public, max-age=604800" : "no-cache" });
      res.end(buf);
    });
  }

  return async function handle(req, res) {
    const url = new URL(req.url, "http://cellovision");
    // Plain HTTP switched off: only "who are you?" answers there; everything else is HTTPS.
    if (!req.socket.encrypted && tls?.port() && !db.setting("plainHttp", true) && url.pathname !== "/api/hello") {
      if (!url.pathname.startsWith("/api/")) { res.writeHead(301, { location: `https://${String(req.headers.host || "localhost").replace(/:\d+$/, "")}:${tls.port()}${req.url}` }); return res.end(); }
      return json(res, 403, { error: "This server only takes HTTPS: update the app, or switch plain HTTP back on in the Control Room" });
    }
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    if (!url.pathname.startsWith("/api/")) {
      res.setHeader("content-security-policy", "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; worker-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'");
      return serveWeb(req, res, url);
    }
    try {
      const key = `${req.method} ${url.pathname}`;
      if (open[key]) {
        const r = await open[key](req, res);
        return Array.isArray(r) ? json(res, 200, r[0], r[1]) : json(res, 200, r);
      }
      const token = tokenOf(req, url);
      let me = token && auth.who(token);
      // Media addresses may also be opened with a media-only token (never account routes).
      if (!me && token && (req.method === "GET" || req.method === "HEAD") && /^\/api\/(file|hls|subs|img)\//.test(url.pathname)) me = auth.whoMedia(token);
      if (!me) throw fail(401, "Sign in");
      me.token = token;
      // Cookie sign-in (the web app) also needs this header on changes, so other sites can't send them.
      if (req.method !== "GET" && !String(req.headers.authorization || "").startsWith("Bearer ") && req.headers["x-cellovision"] !== "1") throw fail(403, "Missing header");
      if (req.method === "GET" || req.method === "HEAD") { const done = await media(req, res, me, url); if (done !== false) return; }
      const route = routes[key];
      if (!route) throw fail(404, "No such thing");
      const r = await route(req, res, me, url, token);
      return Array.isArray(r) ? json(res, 200, r[0], r[1]) : json(res, 200, r);
    } catch (e) {
      if (!e.status) {
        log(`[api] ${req.method} ${url.pathname}: ${e.stack || e.message}`);
        reports?.add({ source: "server", kind: "server error", message: `${req.method} ${url.pathname}: ${e.message}`, detail: e.stack, version });
      }
      if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : "Something went wrong on the server" });
      else res.end();
    }
  };
}
