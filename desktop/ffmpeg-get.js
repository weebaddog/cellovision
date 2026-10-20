// Getting FFmpeg for a computer that runs the Cellovision server (watch-only computers never need it).
// The official BtbN builds (github.com/BtbN/FFmpeg-Builds, GPL) are downloaded once and checked
// against the checksum list published with them before anything is unpacked.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");

const BASE = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest";
// (Windows: the "shared" build, whose two programs share their DLLs in bin\. Linux: the static build,
// which needs no libraries beside it.)
const NAME = { win32: "ffmpeg-master-latest-win64-gpl-shared.zip", linux: "ffmpeg-master-latest-linux64-gpl.tar.xz" }[process.platform];
const exe = process.platform === "win32" ? ".exe" : "";

/** A folder with ffmpeg + ffprobe that work, or null. */
function find(dir) {
  const candidates = [path.join(dir, "bin"), "C:\\MyReverseProjects\\toolchain\\ffmpeg\\bin", "/usr/bin", "/usr/local/bin"];
  for (const d of candidates) if (fs.existsSync(path.join(d, `ffmpeg${exe}`)) && fs.existsSync(path.join(d, `ffprobe${exe}`))) return d;
  return null;
}

async function download(dir, onProgress = () => {}) {
  if (!NAME) throw new Error("No FFmpeg download for this system: install ffmpeg with your package manager.");
  fs.mkdirSync(dir, { recursive: true });
  const sums = await (await fetch(`${BASE}/checksums.sha256`)).text();
  const want = sums.split("\n").find((l) => l.trim().endsWith(NAME))?.split(/\s+/)[0];
  if (!/^[0-9a-f]{64}$/.test(want || "")) throw new Error("Couldn't get FFmpeg's checksum list.");
  const res = await fetch(`${BASE}/${NAME}`);
  if (!res.ok) throw new Error(`FFmpeg download: HTTP ${res.status}`);
  const total = +res.headers.get("content-length") || 0;
  const file = path.join(dir, NAME);
  const out = fs.createWriteStream(file);
  const hash = crypto.createHash("sha256");
  let got = 0;
  for await (const chunk of res.body) {
    hash.update(chunk); got += chunk.length; onProgress(total ? got / total : 0);
    if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
  }
  await new Promise((r) => out.end(r));
  if (hash.digest("hex") !== want) { fs.rmSync(file, { force: true }); throw new Error("The FFmpeg download didn't match its checksum, so it wasn't used."); }
  const tmp = path.join(dir, "unpack");
  fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp);
  await new Promise((ok, bad) => {
    // Windows 10+ and Linux both ship a tar that opens these.
    execFile("tar", ["-xf", file, "-C", tmp], { windowsHide: true, maxBuffer: 1 << 20 }, (e) => (e ? bad(e) : ok()));
  });
  const top = fs.readdirSync(tmp).find((n) => fs.existsSync(path.join(tmp, n, "bin")));
  if (!top) throw new Error("FFmpeg's package didn't have the expected files.");
  fs.rmSync(path.join(dir, "bin"), { recursive: true, force: true });
  fs.renameSync(path.join(tmp, top, "bin"), path.join(dir, "bin"));
  fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(file, { force: true });
  return path.join(dir, "bin");
}

module.exports = { find, download };
