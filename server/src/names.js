// Reading titles, years, seasons and episodes out of file and folder names, the way people
// actually name them: "Movie Name (2019).mkv", "Movie.Name.2019.1080p.BluRay.x264.mkv",
// "Show/Season 02/Show - S02E05 - Title.mkv", "show.2x05.mkv", "Show/S01/E03.mkv".

import path from "node:path";

export const VIDEO = new Set([".mkv", ".mp4", ".m4v", ".avi", ".mov", ".wmv", ".webm", ".ts", ".m2ts", ".mpg", ".mpeg", ".flv", ".3gp", ".ogv"]);
export const AUDIO = new Set([".mp3", ".flac", ".m4a", ".aac", ".ogg", ".opus", ".wav", ".wma", ".alac", ".aiff", ".ape", ".mka"]);
export const PHOTO = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".heif", ".bmp", ".tif", ".tiff", ".avif"]);
export const SUBS = new Set([".srt", ".vtt", ".ass", ".ssa", ".sub"]);

// Release-name noise that's never part of a title.
const JUNK = /\b(2160p|1080p|1080i|720p|576p|480p|4k|uhd|hdr10\+?|hdr|dv|dolby\s?vision|sdr|bluray|blu-ray|bdrip|brrip|webrip|web-dl|webdl|web|hdtv|dvdrip|dvd|remux|x264|x265|h\.?264|h\.?265|hevc|avc|xvid|divx|aac\d?(\.\d)?|ac3|eac3|ddp?\d?(\.\d)?|dts(-hd)?|truehd|atmos|flac|10bit|8bit|proper|repack|extended|unrated|uncut|remastered|imax|limited|multi|subbed|dubbed|internal)\b.*$/i;

export function tidy(s) {
  return s.replace(/[._]+/g, " ").replace(/\s*\[[^\]]*\]\s*/g, " ").replace(/\s+/g, " ").trim();
}

/** "Movie.Name.2019.1080p.mkv" → { title: "Movie Name", year: 2019 }. Works on file or folder names. */
export function parseMovie(name) {
  let base = name.replace(/\.[a-z0-9]{2,4}$/i, "");
  let year = null;
  const paren = base.match(/^(.*?)[\s._]*[\(\[](\d{4})[\)\]]/);
  if (paren && +paren[2] > 1880 && +paren[2] < 2100) { year = +paren[2]; base = paren[1]; }
  else {
    // A year followed by release noise ("Name.2019.1080p"), not a title that IS a year ("1917").
    const m = base.match(/^(.+?)[\s._-]+((?:19|20)\d{2})(?:[\s._-]|$)/);
    if (m && m[1].length > 0) { year = +m[2]; base = m[1]; }
  }
  base = tidy(base).replace(JUNK, "").replace(/[\s-]+$/, "").trim();
  return { title: base || tidy(name), year };
}

/**
 * An episode file → { season, episode, episodeEnd, title } or null. `folder` (the season folder's
 * name) gives the season when the file only says "E03" or "03".
 */
export function parseEpisode(file, folder = "") {
  const base = file.replace(/\.[a-z0-9]{2,4}$/i, "");
  let m = base.match(/[Ss](\d{1,3})[\s._-]*[Ee](\d{1,4})(?:[\s._-]*[Ee-](\d{1,4}))?/);
  if (!m) m = base.match(/\b(\d{1,2})[xX](\d{1,3})(?:[xX-](\d{1,3}))?\b/);
  if (!m && !seasonOf(folder)) m = base.match(EPISODE_3); // "Show - 101 - Title" (season 1, episode 01)
  let season, episode, episodeEnd;
  if (m) { season = +m[1]; episode = +m[2]; episodeEnd = m[3] ? +m[3] : null; }
  else {
    const fs = seasonOf(folder);
    const e = base.match(/(?:^|[\s._-])(?:[Ee]p?|[Ee]pisode)[\s._-]*(\d{1,4})\b/) || base.match(/^(\d{1,3})(?:[\s._-]|$)/);
    if (fs === null || !e) return null;
    season = fs; episode = +e[1]; episodeEnd = null;
  }
  const after = m ? base.slice(base.indexOf(m[0]) + m[0].length) : "";
  const title = tidy(after.replace(/^[\s._-]+/, "")).replace(JUNK, "").replace(/^-\s*/, "").replace(/[\s([-]+$/, "").trim() || null;
  return { season, episode, episodeEnd, title };
}

const EPISODE_3 = /(?<=^|\s-\s)([1-9])(\d{2})(?=\s-\s|$)/;

/** The show's name at the front of an episode file's name ("The Show - S01E02 - Title" → "The Show"), or null. */
export function showNameOf(file) {
  const base = file.replace(/\.[a-z0-9]{2,4}$/i, "");
  const m = base.match(/[Ss]\d{1,3}[\s._-]*[Ee]\d{1,4}/) || base.match(/\b\d{1,2}[xX]\d{1,3}\b/) || base.match(EPISODE_3);
  if (!m || m.index === 0) return null;
  const name = tidy(base.slice(0, m.index)).replace(/[\s-]+$/, "").trim();
  return name || null;
}

/** "Season 2", "S02", "Series 2", "Specials" → 2 / 0; anything else → null. */
export function seasonOf(folder) {
  if (/^specials?$/i.test(folder.trim())) return 0;
  const m = folder.match(/^(?:season|series|staffel|saison|temporada|s)[\s._-]*(\d{1,3})$/i);
  return m ? +m[1] : null;
}

/** A show's folder name → { title, year } ("Show Name (2010)"). */
export const parseShow = (folder) => parseMovie(folder);

export function sortTitle(title) {
  return title.toLowerCase().replace(/^(the|a|an)\s+/, "").replace(/[^a-z0-9 ]/g, "").trim() || title.toLowerCase();
}

/** "movie.en.forced.srt" next to "movie.mkv" → { lang: "en", forced: true, sdh: false }. */
export function subtitleInfo(subFile, videoFile) {
  const v = path.parse(videoFile).name.toLowerCase();
  const s = path.parse(subFile).name.toLowerCase();
  if (!s.startsWith(v)) return null;
  const tags = s.slice(v.length).split(/[._\s-]+/).filter(Boolean);
  return { lang: tags.find((t) => /^[a-z]{2,3}$/.test(t) && !["sdh", "cc"].includes(t)) || null, forced: tags.includes("forced"), sdh: tags.includes("sdh") || tags.includes("cc") };
}

export const ext = (f) => path.extname(f).toLowerCase();
