// Playing things: Fit to Device.
//   direct  - the device plays the file as it is (sent in byte ranges, so seeking is instant).
//   remux   - the video is fine but the box around it (or the audio) isn't: FFmpeg repackages it into
//             HLS without re-encoding the picture (fast).
//   convert - the picture itself has to be re-encoded (codec, size, HDR, burned-in subtitles):
//             FFmpeg makes HLS live, on the graphics chip when it can.
// HLS sessions start at a time (`start`); jumping far ahead starts a new one there. Idle ones stop.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { FF, run } from "./probe.js";

const SEG = 4;                    // seconds per HLS segment
const IDLE_MS = 90_000;           // a session nobody asked anything of for this long is stopped
const MIME = { ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska", ".avi": "video/x-msvideo",
  ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".flac": "audio/flac", ".ogg": "audio/ogg", ".opus": "audio/ogg", ".wav": "audio/wav",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".ts": "video/mp2t", ".m4s": "video/iso.segment", ".m3u8": "application/vnd.apple.mpegurl" };
export const mimeOf = (f) => MIME[path.extname(f).toLowerCase()] || "application/octet-stream";

/** Sends a file, honouring Range requests. */
export function sendFile(req, res, file, extraHeaders = {}) {
  let st;
  try { st = fs.statSync(file); } catch { res.writeHead(404); return res.end(); }
  const type = mimeOf(file);
  const m = String(req.headers.range || "").match(/^bytes=(\d*)-(\d*)$/);
  const base = { "content-type": type, "accept-ranges": "bytes", ...extraHeaders };
  if (m && (m[1] || m[2])) {
    let start = m[1] ? +m[1] : st.size - +m[2];
    let end = m[1] && m[2] ? Math.min(+m[2], st.size - 1) : st.size - 1;
    if (start >= st.size || start > end) { res.writeHead(416, { "content-range": `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { ...base, "content-range": `bytes ${start}-${end}/${st.size}`, "content-length": end - start + 1 });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { ...base, "content-length": st.size });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).pipe(res);
  }
}

// ---- deciding --------------------------------------------------------------------------------

const DIRECT_CONTAINERS = { mp4: ["mov,mp4,m4a,3gp,3g2,mj2"], webm: ["matroska,webm"], mkv: ["matroska,webm"], mp3: ["mp3"], flac: ["flac"], ogg: ["ogg"], m4a: ["mov,mp4,m4a,3gp,3g2,mj2"], wav: ["wav"] };

/**
 * What to do for this device. caps: { video:["h264","hevc",…], audio:["aac",…], containers:["mp4","webm",…],
 * maxHeight, hdr:bool }. choice: { audio: stream index, sub: stream index | "f<n>" | null, burn: bool }.
 */
export function decide(item, caps = {}, choice = {}) {
  const streams = item.streams || [];
  const video = streams.find((s) => s.type === "video" && !s.cover);
  const audios = streams.filter((s) => s.type === "audio");
  const audio = audios.find((s) => s.index === choice.audio) || audios.find((s) => s.default) || audios[0] || null;
  const subStream = typeof choice.sub === "number" ? streams.find((s) => s.index === choice.sub && s.type === "subtitle") : null;
  const containers = new Set(caps.containers || ["mp4"]);
  const vOk = !video || (caps.video || ["h264"]).includes(video.codec);
  const aOk = !audio || (caps.audio || ["aac", "mp3"]).includes(audio.codec);
  const fmt = item.container || "";
  const boxOk = [...containers].some((c) => (DIRECT_CONTAINERS[c] || []).includes(fmt));
  const sizeOk = !video || !caps.maxHeight || video.height <= caps.maxHeight;
  const hdrOk = !video?.hdr || caps.hdr;
  const burn = !!subStream && (!subStream.text || choice.burn);
  // Only the first audio track can be heard when a browser plays a file directly.
  const audioIsFirst = !audio || audio === audios[0];
  const reasons = [];
  if (!vOk) reasons.push(`video ${video.codec}`);
  if (!aOk) reasons.push(`audio ${audio.codec}`);
  if (!boxOk) reasons.push(`container ${fmt}`);
  if (!sizeOk) reasons.push(`${video.height}p is too big`);
  if (!hdrOk) reasons.push("HDR");
  if (burn) reasons.push("subtitles burned in");
  if (!audioIsFirst) reasons.push("another audio track");
  let mode = "direct";
  if (!vOk || !sizeOk || !hdrOk || burn) mode = "convert";
  else if (!aOk || !boxOk || !audioIsFirst) mode = "remux";
  return { mode, reasons, audio: audio?.index ?? null, sub: subStream?.index ?? null, burn, video, audioStream: audio };
}

// ---- the encoder -----------------------------------------------------------------------------

let encoderChoice = null;
/** The fastest H.264 encoder that actually works on this machine (hardware first). */
export async function pickEncoder(setting = "auto") {
  if (setting && setting !== "auto") return setting;
  if (encoderChoice) return encoderChoice;
  for (const enc of ["h264_nvenc", "h264_amf", "h264_qsv", "h264_videotoolbox", "h264_vaapi"]) {
    try {
      const extra = enc === "h264_vaapi" ? ["-vaapi_device", "/dev/dri/renderD128", "-vf", "format=nv12,hwupload"] : [];
      await run(FF.ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-t", "0.5", ...extra, "-c:v", enc, "-f", "null", "-"], { timeout: 20_000 });
      return (encoderChoice = enc);
    } catch { /* not this one */ }
  }
  return (encoderChoice = "libx264");
}

function videoArgs(enc, height) {
  const kbps = height >= 2000 ? 16000 : height >= 1000 ? 8000 : height >= 700 ? 4500 : 2000;
  const rate = ["-b:v", `${kbps}k`, "-maxrate", `${Math.round(kbps * 1.5)}k`, "-bufsize", `${kbps * 2}k`];
  switch (enc) {
    case "libx264": return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-maxrate", `${Math.round(kbps * 1.5)}k`, "-bufsize", `${kbps * 2}k`, "-profile:v", "high", "-pix_fmt", "yuv420p"];
    case "h264_amf": return ["-c:v", "h264_amf", "-quality", "speed", "-rc", "vbr_peak", ...rate, "-profile:v", "high", "-pix_fmt", "yuv420p"];
    case "h264_nvenc": return ["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", ...rate, "-profile:v", "high", "-pix_fmt", "yuv420p"];
    case "h264_qsv": return ["-c:v", "h264_qsv", "-preset", "veryfast", ...rate, "-profile:v", "high"];
    default: return ["-c:v", enc, ...rate];
  }
}

const esc = (p) => p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");

export function createStreamer({ cacheDir, log = console.log, encoderSetting = () => "auto" }) {
  const sessions = new Map();
  const hlsDir = path.join(cacheDir, "hls");
  fs.rmSync(hlsDir, { recursive: true, force: true });

  function stop(id) {
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    try { s.proc.kill("SIGKILL"); } catch { /* gone */ }
    setTimeout(() => fs.rmSync(s.dir, { recursive: true, force: true }), 500);
  }
  setInterval(() => { for (const [id, s] of sessions) if (Date.now() - s.touched > IDLE_MS) stop(id); }, 15_000).unref();

  /** Starts an HLS session for item at `start` seconds. */
  async function startHls(item, plan, { start = 0, maxHeight = null, owner = null } = {}) {
    // One session per viewer per item: a new one (e.g. after a big jump) replaces the old.
    for (const [id, s] of sessions) if (s.owner === owner && s.itemId === item.id) stop(id);
    const id = crypto.randomBytes(9).toString("base64url");
    const dir = path.join(hlsDir, id);
    fs.mkdirSync(dir, { recursive: true });
    const v = plan.video;
    const convert = plan.mode === "convert";
    const enc = convert ? await pickEncoder(encoderSetting()) : null;
    const args = ["-hide_banner", "-v", "error", "-nostdin"];
    if (start > 0) args.push("-ss", String(start));
    args.push("-i", item.path);
    if (v) args.push("-map", `0:${v.index}`);
    if (plan.audio !== null) args.push("-map", `0:${plan.audio}`);
    if (convert && v) {
      const filters = [];
      const targetH = Math.min(v.height || 1080, maxHeight || 99999);
      if (v.hdr) filters.push("zscale=t=linear:npl=100", "format=gbrpf32le", "zscale=p=bt709", "tonemap=tonemap=hable:desat=0", "zscale=t=bt709:m=bt709:r=tv", "format=yuv420p");
      if (plan.burn && plan.sub !== null) {
        const subPos = (item.streams || []).filter((s) => s.type === "subtitle").findIndex((s) => s.index === plan.sub);
        const sub = (item.streams || []).find((s) => s.index === plan.sub);
        if (sub?.text) filters.push(`setpts=PTS+${start}/TB`, `subtitles='${esc(item.path)}':si=${subPos}`, `setpts=PTS-STARTPTS`);
        else args.splice(args.indexOf("-map"), 2, "-filter_complex", `[0:${v.index}][0:${plan.sub}]overlay[vv]`, "-map", "[vv]");
      }
      if ((v.height || 0) > targetH) filters.push(`scale=-2:${targetH}`);
      if (!v.hdr && enc === "libx264") filters.push("format=yuv420p");
      if (filters.length && !args.includes("-filter_complex")) args.push("-vf", filters.join(","));
      args.push(...videoArgs(enc, targetH), "-force_key_frames", `expr:gte(t,n_forced*${SEG})`, "-g", String(Math.round((v.fps || 30) * SEG)));
    } else if (v) args.push("-c:v", "copy", ...(v.codec === "hevc" ? ["-tag:v", "hvc1"] : []));
    // H.264 travels in MPEG-TS segments (every player has them); other video (HEVC, AV1, VP9) only
    // works in fragmented-MP4 segments.
    const fmp4 = !!v && !convert && v.codec !== "h264";
    if (plan.audio !== null) {
      const a = plan.audioStream;
      args.push(...(a && ["aac", "mp3"].includes(a.codec) && !convert ? ["-c:a", "copy"] : ["-c:a", "aac", "-ac", String(Math.min(a?.channels || 2, 6)), "-b:a", (a?.channels || 2) > 2 ? "384k" : "192k"]));
    }
    args.push("-sn", "-dn", "-max_muxing_queue_size", "4096", "-f", "hls", "-hls_time", String(SEG), "-hls_playlist_type", "event", "-hls_list_size", "0",
      "-hls_flags", "independent_segments+temp_file",
      ...(fmp4 ? ["-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4", "-hls_segment_filename", "s%05d.m4s"]
        : ["-hls_segment_type", "mpegts", "-hls_segment_filename", "s%05d.ts"]),
      "index.m3u8");
    const proc = spawn(FF.ffmpeg, args, { cwd: dir, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] }); // (in its folder: fMP4's init.mp4 lands beside the playlist)
    let err = "";
    proc.stderr.on("data", (d) => { err = (err + d).slice(-2000); });
    const s = { id, itemId: item.id, owner, dir, proc, start, mode: plan.mode, encoder: enc, touched: Date.now(), done: false, failed: null, title: item.title, startedAt: Date.now() };
    proc.on("exit", (code) => { s.done = true; if (code && code !== 255 && sessions.has(id)) { s.failed = err.trim().split("\n").pop() || `ffmpeg exit ${code}`; log(`[play] ${item.title}: ${s.failed}`); } });
    sessions.set(id, s);
    return s;
  }

  /** Waits for an HLS file to appear (the playlist needs its first segment). */
  async function hlsFile(id, name) {
    const s = sessions.get(id);
    if (!s || !/^(index\.m3u8|init\.mp4|s\d{5}\.(ts|m4s))$/.test(name)) return null;
    s.touched = Date.now();
    const file = path.join(s.dir, name);
    const ready = () => (name === "index.m3u8" ? fs.existsSync(file) && fs.readFileSync(file, "utf8").includes("#EXTINF") : fs.existsSync(file));
    for (let i = 0; i < 300 && !ready(); i++) {
      if (s.failed) throw Object.assign(new Error(`Can't convert this: ${s.failed}`), { status: 500 });
      if (s.done && !ready()) return null;
      await new Promise((r) => setTimeout(r, 100));
    }
    return ready() ? file : null;
  }

  /** A subtitle track as WebVTT (cached). key: stream index, or "f<n>" for the n-th file beside the video. from: seconds already skipped. */
  async function subtitle(item, key, from = 0) {
    const out = path.join(cacheDir, "subs", `${item.id}-${key}-${Math.floor(from)}.vtt`);
    if (fs.existsSync(out)) return out;
    fs.mkdirSync(path.dirname(out), { recursive: true });
    let input, map;
    if (String(key).startsWith("f")) {
      const side = (item.subs || [])[+String(key).slice(1)];
      if (!side) return null;
      input = side.file; map = "0:s:0";
    } else {
      const s = (item.streams || []).find((x) => x.index === +key && x.type === "subtitle" && x.text);
      if (!s) return null;
      input = item.path; map = `0:${s.index}`;
    }
    await run(FF.ffmpeg, ["-v", "error", "-y", ...(from > 0 ? ["-ss", String(from)] : []), "-i", input, "-map", map, "-f", "webvtt", out], { timeout: 120_000 });
    return out;
  }

  return {
    startHls, hlsFile, stop, subtitle,
    get: (id) => sessions.get(id) || null,
    list: () => [...sessions.values()].map((s) => ({ id: s.id, itemId: s.itemId, owner: s.owner, mode: s.mode, encoder: s.encoder, title: s.title, start: s.start, startedAt: s.startedAt, failed: s.failed })),
    stopAll() { for (const id of [...sessions.keys()]) stop(id); },
  };
}
