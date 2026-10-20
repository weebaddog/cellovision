// Details: plot, age rating, genres, cast-free basics, posters and backdrops.
//   1. Files next to the media (Kodi-style .nfo, poster.jpg, fanart.jpg…) always win.
//   2. TMDB (themoviedb.org), only if the owner pasted their own free API key in the Control Room.

import fs from "node:fs";
import path from "node:path";

/** "PG-13" / "TV-MA" / "FSK 12" → the youngest age it's meant for (Age Limits compare against this). */
export function ageOf(label) {
  if (!label) return null;
  const l = String(label).toUpperCase().replace(/^(US|GB|UK|DE|FR|CA|AU)[:\s-]*/, "").trim();
  const table = { G: 0, "TV-Y": 0, "TV-G": 0, U: 0, PG: 8, "TV-Y7": 7, "TV-Y7-FV": 7, "TV-PG": 10, "PG-13": 13, "12": 12, "12A": 12, "TV-14": 14, "15": 15, R: 17, "TV-MA": 17, "16": 16, "NC-17": 18, "18": 18, R18: 18, X: 18, "FSK 0": 0, "FSK 6": 6, "FSK 12": 12, "FSK 16": 16, "FSK 18": 18 };
  if (l in table) return table[l];
  const n = l.match(/(\d{1,2})/);
  return n ? +n[1] : null;
}

// ---- .nfo files (the common XML format other media tools write) ----------------------------------

const unxml = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&").trim();
function tag(xml, name) { const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i")); return m ? unxml(m[1]) : null; }
function tags(xml, name) { return [...xml.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "gi"))].map((m) => unxml(m[1])).filter(Boolean); }

export function readNfo(file) {
  let xml;
  try { xml = fs.readFileSync(file, "utf8"); } catch { return null; }
  const tmdb = xml.match(/<uniqueid[^>]*type="tmdb"[^>]*>(\d+)<\/uniqueid>/i)?.[1] || tag(xml, "tmdbid");
  const rating = tag(xml, "mpaa");
  const score = Number(xml.match(/<rating[^>]*>[\s\S]*?<value>([\d.]+)<\/value>/i)?.[1] || tag(xml, "rating")) || null;
  return {
    title: tag(xml, "title"), overview: tag(xml, "plot") || tag(xml, "outline"), year: Number(tag(xml, "year")) || null,
    rating_label: rating ? rating.replace(/^Rated\s+/i, "") : null, score, genres: tags(xml, "genre"), studio: tag(xml, "studio"),
    premiered: tag(xml, "premiered") || tag(xml, "aired"), tmdb_id: tmdb || null,
    season_no: Number(tag(xml, "season")) || null, episode_no: Number(tag(xml, "episode")) || null,
  };
}

/** The .nfo for a movie/episode file, or for a show folder. */
export function nfoFor(p, kind) {
  const candidates = kind === "show" ? [path.join(p, "tvshow.nfo")]
    : [p.replace(/\.[^.]+$/, ".nfo"), ...(kind === "movie" ? [path.join(path.dirname(p), "movie.nfo")] : [])];
  for (const c of candidates) { const r = readNfo(c); if (r) return r; }
  return null;
}

/** Artwork sitting next to the media. */
export function localArt(p, kind) {
  const dir = kind === "show" || kind === "album" || kind === "artist" ? p : path.dirname(p);
  const stem = kind === "show" || kind === "album" || kind === "artist" ? null : path.parse(p).name;
  let names;
  try { names = fs.readdirSync(dir); } catch { return {}; }
  const lower = new Map(names.map((n) => [n.toLowerCase(), n]));
  const find = (list) => { for (const n of list) for (const e of [".jpg", ".jpeg", ".png", ".webp"]) { const f = lower.get(n + e); if (f) return path.join(dir, f); } return null; };
  const own = (s) => (stem ? [`${stem.toLowerCase()}-${s}`, `${stem.toLowerCase()}.${s}`] : []);
  const single = kind === "movie" && names.filter((n) => /\.(mkv|mp4|m4v|avi|mov|webm|ts|wmv)$/i.test(n)).length <= 1;
  return {
    poster: find([...own("poster"), ...own("thumb"), ...(kind === "episode" ? [] : single || kind !== "movie" ? ["poster", "folder", "cover", "front"] : [])]),
    backdrop: find([...own("fanart"), ...own("backdrop"), ...(kind === "episode" ? [] : single || kind !== "movie" ? ["fanart", "backdrop", "background"] : [])]),
  };
}

// ---- TMDB (optional) ---------------------------------------------------------------------------

const TMDB = "https://api.themoviedb.org/3";
const IMG = "https://image.tmdb.org/t/p";

export function createTmdb({ key, artDir, fetchImpl = fetch, language = "en-US" }) {
  if (!key) return null;
  // A v4 "read access token" (long, starts eyJ) goes in a header; a v3 key goes in the address.
  const bearer = key.startsWith("eyJ");
  let last = 0;
  async function get(p, params = {}) {
    const wait = 30 - (Date.now() - last); if (wait > 0) await new Promise((r) => setTimeout(r, wait)); // ~30 req/s max
    last = Date.now();
    const q = new URLSearchParams({ language, ...params, ...(bearer ? {} : { api_key: key }) });
    const r = await fetchImpl(`${TMDB}${p}?${q}`, { headers: bearer ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(15_000) });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`TMDB ${r.status}`);
    return r.json();
  }
  async function image(pathPart, size, name) {
    if (!pathPart) return null;
    const out = path.join(artDir, name);
    if (fs.existsSync(out)) return out;
    const r = await fetchImpl(`${IMG}/${size}${pathPart}`, { signal: AbortSignal.timeout(30_000) });
    if (!r.ok) return null;
    fs.mkdirSync(artDir, { recursive: true });
    fs.writeFileSync(out, Buffer.from(await r.arrayBuffer()));
    return out;
  }
  const usCert = (list) => list?.find((c) => c.iso_3166_1 === "US");

  return {
    async movie({ title, year, tmdb_id }, itemId) {
      let id = tmdb_id;
      if (!id) {
        const s = await get("/search/movie", { query: title, ...(year ? { year } : {}) });
        id = s?.results?.[0]?.id;
        if (!id && year) id = (await get("/search/movie", { query: title }))?.results?.[0]?.id;
      }
      if (!id) return null;
      const d = await get(`/movie/${id}`, { append_to_response: "release_dates" });
      if (!d) return null;
      const cert = usCert(d.release_dates?.results)?.release_dates?.find((x) => x.certification)?.certification || null;
      return {
        tmdb_id: String(d.id), title: d.title, overview: d.overview || null, year: d.release_date ? +d.release_date.slice(0, 4) : year,
        premiered: d.release_date || null, genres: d.genres?.map((g) => g.name) || [], score: d.vote_average || null, rating_label: cert,
        studio: d.production_companies?.[0]?.name || null, collection: d.belongs_to_collection ? { id: d.belongs_to_collection.id, name: d.belongs_to_collection.name } : null,
        poster: await image(d.poster_path, "w500", `${itemId}-poster.jpg`), backdrop: await image(d.backdrop_path, "w1280", `${itemId}-backdrop.jpg`),
      };
    },
    async show({ title, year, tmdb_id }, itemId) {
      let id = tmdb_id;
      if (!id) id = (await get("/search/tv", { query: title, ...(year ? { first_air_date_year: year } : {}) }))?.results?.[0]?.id || (await get("/search/tv", { query: title }))?.results?.[0]?.id;
      if (!id) return null;
      const d = await get(`/tv/${id}`, { append_to_response: "content_ratings" });
      if (!d) return null;
      return {
        tmdb_id: String(d.id), title: d.name, overview: d.overview || null, year: d.first_air_date ? +d.first_air_date.slice(0, 4) : year,
        premiered: d.first_air_date || null, genres: d.genres?.map((g) => g.name) || [], score: d.vote_average || null,
        rating_label: usCert(d.content_ratings?.results)?.rating || null, studio: d.networks?.[0]?.name || null,
        poster: await image(d.poster_path, "w500", `${itemId}-poster.jpg`), backdrop: await image(d.backdrop_path, "w1280", `${itemId}-backdrop.jpg`),
      };
    },
    /** All episodes of one season: episode number → details. */
    async season(showTmdbId, seasonNo, seasonItemId) {
      const d = await get(`/tv/${showTmdbId}/season/${seasonNo}`);
      if (!d) return null;
      const eps = new Map();
      for (const e of d.episodes || []) eps.set(e.episode_number, { title: e.name, overview: e.overview || null, premiered: e.air_date || null, score: e.vote_average || null, still: e.still_path });
      return { overview: d.overview || null, poster: await image(d.poster_path, "w500", `${seasonItemId}-poster.jpg`), eps, image };
    },
  };
}
