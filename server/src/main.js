// Cellovision server: starts everything.
//   CELLOVISION_DATA   where the database, artwork and caches live
//                      (default: %LOCALAPPDATA%\Cellovision on Windows, ~/.local/share/cellovision elsewhere)
//   CELLOVISION_PORT   default 8420 (plain HTTP: discovery, and the iPhone/Apple TV apps)
//   CELLOVISION_TLS_PORT default 8424 (HTTPS with the server's own certificate: everything else)
//   CELLOVISION_FFMPEG a folder holding ffmpeg and ffprobe (otherwise found automatically)

import http from "node:http";
import https from "node:https";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "./db.js";
import { createAuth } from "./auth.js";
import { createLibrary } from "./library.js";
import { createScanner } from "./scan.js";
import { createStreamer } from "./stream.js";
import { createImages } from "./images.js";
import { createTmdb } from "./meta.js";
import { createApi } from "./api.js";
import { FF } from "./probe.js";
import { createReports } from "./reports.js";
import { loadCertificate } from "./tls.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "server", "package.json"), "utf8")).version;

export function defaultDataDir() {
  if (process.env.CELLOVISION_DATA) return process.env.CELLOVISION_DATA;
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA || os.homedir(), "Cellovision");
  return path.join(os.homedir(), ".local", "share", "cellovision");
}

export async function createServer({ dataDir = defaultDataDir(), fetchImpl = fetch, log = console.log } = {}) {
  const db = openDb(dataDir);
  db.dataDir = dataDir;
  const cacheDir = path.join(dataDir, "cache");
  const artDir = path.join(dataDir, "art");
  const auth = createAuth(db);
  const lib = createLibrary(db);
  const tmdb = () => createTmdb({ key: db.setting("tmdbKey"), artDir, fetchImpl });
  const scanner = createScanner({ db, artDir, tmdb, log });
  const reports = createReports({ db, version: VERSION, log });
  const streamer = createStreamer({ cacheDir, log, encoderSetting: () => db.setting("encoder", "auto"), onFail: (title, why) => reports.add({ source: "server", kind: "conversion failed", message: `${title}: ${why}`, version: VERSION }) });
  const images = createImages({ cacheDir });
  const tlsPort = Number(process.env.CELLOVISION_TLS_PORT || 8424); // (not 8443: CelloCloud uses that)
  let securePort = tlsPort; // (the one actually listened on)
  const tls = loadCertificate(dataDir);
  const handle = createApi({ db, auth, lib, scanner, streamer, images, reports, webDir: path.join(ROOT, "web"), version: VERSION, log, tls: { fingerprint: tls.fingerprint, port: () => securePort } });
  const server = http.createServer(handle);
  const secure = https.createServer({ cert: tls.cert, key: tls.key }, handle);
  for (const s of [server, secure]) { s.keepAliveTimeout = 65_000; s.requestTimeout = 0; } // (long streams)

  // Chores: rescan every few hours (Control Room → "Rescan every").
  let lastScan = Date.now();
  const chores = setInterval(() => {
    const every = db.setting("scanEvery", 6);
    if (every > 0 && Date.now() - lastScan > every * 3600_000) { lastScan = Date.now(); scanner.scan().catch((e) => log(`[scan] ${e.message}`)); }
  }, 60_000);
  chores.unref();

  return {
    db, auth, lib, scanner, streamer, reports, server, secure, fingerprint: tls.fingerprint,
    async listen(port = Number(process.env.CELLOVISION_PORT || 8420), host = "0.0.0.0", httpsPort = tlsPort) {
      await new Promise((ok, bad) => server.once("error", bad).listen(port, host, ok));
      // A busy HTTPS port (another program has it) leaves the server on plain HTTP rather than not starting.
      try { await new Promise((ok, bad) => secure.once("error", bad).listen(httpsPort, host, ok)); securePort = secure.address().port; }
      catch (e) { securePort = null; log(`[cellovision] HTTPS port ${httpsPort} is busy (${e.code || e.message}): plain HTTP only. Set CELLOVISION_TLS_PORT to another port.`); }
      log(`[cellovision] ${VERSION} on port ${port} (http)${securePort ? ` and ${securePort} (https, ${tls.fingerprint})` : ""} · data in ${dataDir} · ffmpeg ${FF.ffmpeg}`);
    },
    close() { clearInterval(chores); streamer.stopAll(); for (const s of [server, secure]) { s.close(); s.closeAllConnections?.(); } db.close(); },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.removeAllListeners("warning").on("warning", (w) => { if (w.name !== "ExperimentalWarning") console.warn(w); });
  const s = await createServer();
  await s.listen();
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { s.close(); process.exit(0); });
}
