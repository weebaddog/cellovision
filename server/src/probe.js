// FFmpeg: finding it, and asking ffprobe what's inside a file (video size and codec, audio and
// subtitle tracks with their languages, music tags, embedded cover art).

import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** ffmpeg/ffprobe: CELLOVISION_FFMPEG (a folder), the bundled toolchain copy, or whatever is on PATH. */
export function findFfmpeg() {
  const exe = process.platform === "win32" ? ".exe" : "";
  const dirs = [process.env.CELLOVISION_FFMPEG, "C:\\MyReverseProjects\\toolchain\\ffmpeg\\bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"].filter(Boolean);
  for (const d of dirs) {
    const f = path.join(d, `ffmpeg${exe}`), p = path.join(d, `ffprobe${exe}`);
    if (fs.existsSync(f) && fs.existsSync(p)) return { ffmpeg: f, ffprobe: p };
  }
  return { ffmpeg: `ffmpeg${exe}`, ffprobe: `ffprobe${exe}` };
}

export const FF = findFfmpeg();

export function run(bin, args, { timeout = 120_000, maxBuffer = 64 << 20, encoding = "utf8" } = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer, encoding, windowsHide: true }, (err, stdout, stderr) => {
      if (err) { err.message = `${path.basename(bin)}: ${String(stderr || err.message).trim().split("\n").slice(-3).join(" ")}`; reject(err); }
      else resolve(stdout);
    });
  });
}

const num = (v) => (v === undefined || v === null || v === "" || isNaN(+v) ? null : +v);
function fps(r) { if (!r || r === "0/0") return null; const [a, b] = r.split("/").map(Number); return b ? Math.round((a / b) * 1000) / 1000 : a; }

/** What's in a media file. */
export async function probe(file) {
  const out = await run(FF.ffprobe, ["-v", "error", "-show_format", "-show_streams", "-of", "json", file], { timeout: 60_000 });
  const j = JSON.parse(out);
  const fmt = j.format || {};
  const tags = Object.fromEntries(Object.entries(fmt.tags || {}).map(([k, v]) => [k.toLowerCase(), v]));
  const streams = (j.streams || []).map((s) => {
    const t = Object.fromEntries(Object.entries(s.tags || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const base = { index: s.index, type: s.codec_type, codec: s.codec_name, lang: t.language && t.language !== "und" ? t.language : null, title: t.title || null,
      default: !!s.disposition?.default, forced: !!s.disposition?.forced };
    if (s.codec_type === "video") {
      return { ...base, cover: !!s.disposition?.attached_pic, width: s.width, height: s.height, fps: fps(s.avg_frame_rate || s.r_frame_rate),
        profile: s.profile || null, level: s.level ?? null, pixfmt: s.pix_fmt || null, bitrate: num(s.bit_rate),
        hdr: ["smpte2084", "arib-std-b67"].includes(s.color_transfer) ? (s.color_transfer === "smpte2084" ? "hdr10" : "hlg") : null };
    }
    if (s.codec_type === "audio") return { ...base, channels: s.channels, layout: s.channel_layout || null, rate: num(s.sample_rate), bitrate: num(s.bit_rate) };
    if (s.codec_type === "subtitle") return { ...base, text: !["hdmv_pgs_subtitle", "dvd_subtitle", "dvb_subtitle", "xsub"].includes(s.codec_name), sdh: !!s.disposition?.hearing_impaired };
    return null;
  }).filter(Boolean);
  return {
    container: fmt.format_name || null,
    duration: num(fmt.duration),
    bitrate: num(fmt.bit_rate),
    size: num(fmt.size),
    tags: {
      title: tags.title || null, artist: tags.artist || null, albumArtist: tags.album_artist || tags["album artist"] || null, album: tags.album || null,
      track: num(String(tags.track || "").split("/")[0]), disc: num(String(tags.disc || "").split("/")[0]),
      date: tags.date || tags.year || null, genre: tags.genre || null, comment: tags.comment || tags.description || null,
    },
    streams,
  };
}

/** A still from a video (or embedded cover art from music) as a JPEG file. */
export async function grabImage(src, out, { at = null, width = 480, cover = false } = {}) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const args = ["-v", "error", "-y"];
  if (at !== null && !cover) args.push("-ss", String(at));
  args.push("-i", src);
  if (cover) args.push("-an", "-map", "0:v:0", "-frames:v", "1");
  else args.push("-frames:v", "1");
  args.push("-vf", `scale='min(${width},iw)':-2`, "-q:v", "4", out);
  await run(FF.ffmpeg, args, { timeout: 60_000 });
  return out;
}

export { spawn };
