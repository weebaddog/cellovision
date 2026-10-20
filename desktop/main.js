// Cellovision for Windows and Linux.
//   - Watch: opens a Cellovision server's app in its own window (with real full screen and media keys).
//   - Be the server: this computer can run the Cellovision server itself (the same program the
//     project's server folder has, run by this app's own Node), so one install covers both.
// Closing the window keeps the server running in the tray; Quit stops everything.

const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, shell, nativeImage, nativeTheme, dialog, net, session } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const http = require("node:http");
const { spawn } = require("node:child_process");
const ffmpeg = require("./ffmpeg-get.js");
const { signedRelease, newer, saveVerified, downloadUrl, installCommand, SITE } = require("./updates.js");

const ICON = path.join(__dirname, "icon.png");
if (process.env.CELLOVISION_PROFILE && !app.isPackaged) app.setPath("userData", process.env.CELLOVISION_PROFILE); // (testing)
const PORT = 8420, TLS_PORT = 8424;
let win = null, tray = null, quitting = false, server = null, serverState = { running: false, error: null, ffmpeg: null, progress: null };

const configFile = () => path.join(app.getPath("userData"), "config.json");
function loadConfig() { try { return JSON.parse(fs.readFileSync(configFile(), "utf8")); } catch { return { server: "", runServer: false, autostart: false, theme: "dark" }; } }
let config = loadConfig();
function saveConfig() { fs.mkdirSync(path.dirname(configFile()), { recursive: true }); fs.writeFileSync(configFile(), JSON.stringify(config, null, 1)); }
const origin = () => { try { return new URL(config.server).origin; } catch { return null; } };

if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => show());

// ---- the server on this computer -------------------------------------------------------------

/**
 * The key the server encrypts its secrets with (mail App Password, TMDB key), kept locked by the
 * operating system (Windows DPAPI / the Linux keyring, through safeStorage) instead of a plain file.
 */
function serverKey() {
  const { safeStorage } = require("electron");
  if (!safeStorage.isEncryptionAvailable()) return null; // (the server then keeps its own key file)
  const file = path.join(app.getPath("userData"), "server-key.bin");
  try { return safeStorage.decryptString(fs.readFileSync(file)); } catch { /* first time */ }
  // A server that ran before kept its key in a plain file: move that key in here.
  const dataDir = process.env.CELLOVISION_DATA || (process.platform === "win32" ? path.join(process.env.LOCALAPPDATA || os.homedir(), "Cellovision") : path.join(os.homedir(), ".local", "share", "cellovision"));
  const old = path.join(dataDir, "secret.key");
  let key = null;
  try { key = fs.readFileSync(old, "utf8").trim(); } catch { key = require("node:crypto").randomBytes(32).toString("base64"); }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, safeStorage.encryptString(key));
  fs.rmSync(old, { force: true });
  return key;
}

// Packaged: the server and the web app are in resources/. From source: the project's folders.
const serverMain = () => app.isPackaged ? path.join(process.resourcesPath, "server", "src", "main.js") : path.join(__dirname, "..", "server", "src", "main.js");

async function startServer() {
  if (server) return;
  serverState.error = null;
  let ff = ffmpeg.find(path.join(app.getPath("userData"), "ffmpeg"));
  if (!ff) {
    serverState.progress = 0; tell();
    try { ff = await ffmpeg.download(path.join(app.getPath("userData"), "ffmpeg"), (p) => { serverState.progress = p; tell(); }); }
    catch (e) { serverState.progress = null; serverState.error = `Couldn't get FFmpeg: ${e.message}`; tell(); return; }
    serverState.progress = null;
  }
  serverState.ffmpeg = ff;
  const logFile = path.join(app.getPath("userData"), "server.log");
  const log = fs.createWriteStream(logFile, { flags: "a" });
  server = spawn(process.execPath, [serverMain()], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", CELLOVISION_FFMPEG: ff, CELLOVISION_PORT: String(PORT), CELLOVISION_TLS_PORT: String(TLS_PORT), ...(serverKey() ? { CELLOVISION_SECRET_KEY: serverKey() } : {}) },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  server.stdout.pipe(log); server.stderr.pipe(log);
  server.stderr.on("data", (d) => { const s = String(d); if (/EADDRINUSE/.test(s)) serverState.error = `Port ${PORT} is already in use (is another Cellovision server running?).`; });
  server.on("exit", (code) => {
    server = null; serverState.running = false;
    if (code && !quitting) {
      if (!serverState.error) serverState.error = `The server stopped (code ${code}). Details: ${logFile}`;
      const tail = (() => { try { return fs.readFileSync(logFile, "utf8").slice(-4000); } catch { return ""; } })();
      reportProblem("server crashed", `The server on this computer stopped (code ${code})`, tail).catch(() => {});
      // Back on its feet in a few seconds (the report goes once it answers again).
      setTimeout(() => { if (config.runServer && !quitting) startServer().then(() => sendPending()); }, 5000);
    }
    tell(); buildMenu();
  });
  // Running once it answers.
  for (let i = 0; i < 40 && server; i++) { if (await hello(`http://127.0.0.1:${PORT}`, 1000)) { serverState.running = true; break; } await new Promise((r) => setTimeout(r, 250)); }
  tell(); buildMenu();
}
function stopServer() { if (server) { server.kill(); server = null; } serverState.running = false; tell(); buildMenu(); }
function tell() { win?.webContents.send("cellovision:server-state", serverState); }

// ---- automatic updates (only versions signed with the owner's release key: see updates.js) ----------

const UPDATE_NAME = process.platform === "win32" ? "cellovisionWindows" : "cellovisionLinux";
const update = { ready: null, latest: null, checkedAt: 0, error: null, told: "" };
const autoUpdate = () => config.autoUpdate !== false;
const updateStatus = () => ({ auto: autoUpdate(), current: app.getVersion(), latest: update.latest, ready: update.ready?.version || null,
  checkedAt: update.checkedAt, error: update.error, canInstall: app.isPackaged && (process.platform === "win32" || !!process.env.APPIMAGE) });

async function checkUpdates() {
  try {
    const res = await fetch(`${SITE}/release.json`, { cache: "no-store" });
    if (!res.ok) throw new Error(`release list: HTTP ${res.status}`);
    const r = signedRelease(await res.text(), UPDATE_NAME);
    update.checkedAt = Date.now(); update.latest = r?.version || null; update.error = null;
    if (!r || !newer(r.version, app.getVersion()) || update.ready?.version === r.version) return updateStatus();
    if (!updateStatus().canInstall) {
      if (update.told !== r.version) { update.told = r.version; new Notification({ title: "Cellovision update", body: `Cellovision ${r.version} is out: get it from ${SITE}/download/Cellovision.AppImage.`, icon: ICON }).show(); }
      return updateStatus();
    }
    const file = process.platform === "win32" ? path.join(app.getPath("temp"), `Cellovision-Setup-${r.version}.exe`) : `${process.env.APPIMAGE}.new`;
    await saveVerified(await fetch(downloadUrl(r)), file, r);
    update.ready = { version: r.version, file };
    // Never in the middle of watching: when the window is hidden (or on Quit, or "Restart to update").
    if (!win || !win.isVisible()) installUpdate(true);
    else new Notification({ title: "Cellovision update ready", body: `Version ${r.version} goes in when you close the window, or choose "Restart to update" in the tray menu.`, icon: ICON }).show();
  } catch (e) { update.error = e.message; } finally { buildMenu(); }
  return updateStatus();
}

function installUpdate(hidden) {
  const u = update.ready;
  if (!u) return;
  quitting = true;
  stopServer();
  if (process.platform === "win32") {
    const [cmd, args] = installCommand(u.file, process.execPath, hidden);
    spawn(cmd, args, { detached: true, stdio: "ignore", windowsVerbatimArguments: true, windowsHide: true }).unref();
  } else { fs.renameSync(u.file, process.env.APPIMAGE); app.relaunch({ args: hidden ? ["--hidden"] : [] }); }
  app.quit();
}

function setAutoUpdate(on) { config.autoUpdate = !!on; saveConfig(); buildMenu(); if (on) checkUpdates(); return updateStatus(); }
ipcMain.handle("cellovision:updates", () => updateStatus());
ipcMain.handle("cellovision:set-auto-update", (_e, on) => setAutoUpdate(on));
ipcMain.handle("cellovision:check-updates", () => checkUpdates());
ipcMain.on("cellovision:install-update", () => installUpdate(false));

// ---- problem reports (the server emails them to its owner) -----------------------------------------

const pendingFile = () => path.join(app.getPath("userData"), "pending-reports.json");
async function reportProblem(kind, message, detail = "") {
  const r = { source: "desktop", kind, message: String(message).slice(0, 500), detail: String(detail).slice(0, 6000),
    device: `Cellovision desktop · ${process.platform === "win32" ? "Windows" : "Linux"} ${os.release()}`, version: app.getVersion() };
  const pending = (() => { try { return JSON.parse(fs.readFileSync(pendingFile(), "utf8")); } catch { return []; } })();
  if (kind) pending.push(r);
  const left = [];
  for (const p of pending.slice(-20)) {
    try {
      // (Chromium's network, so the pinned certificate is honoured)
      const res = await net.fetch(`${origin()}/api/report`, { method: "POST", headers: { "content-type": "application/json", "x-cellovision": "1" }, body: JSON.stringify(p), signal: AbortSignal.timeout(5000) });
      if (!res.ok && res.status !== 429) left.push(p);
    } catch { left.push(p); } // (server not up: try again next time)
  }
  try { if (left.length) fs.writeFileSync(pendingFile(), JSON.stringify(left)); else fs.rmSync(pendingFile(), { force: true }); } catch { /* full disk */ }
}
async function sendPending() { try { if (fs.existsSync(pendingFile()) && origin()) await reportProblem(null, ""); } catch { /* later */ } }
process.on("uncaughtException", (e) => { reportProblem("app error", e.message, e.stack).catch(() => {}); });
process.on("unhandledRejection", (e) => { reportProblem("app error", e?.message || String(e), e?.stack || "").catch(() => {}); });

// ---- finding servers ---------------------------------------------------------------------------

/**
 * Is there a Cellovision server here? Resolves its /api/hello answer, or null. Over HTTPS the
 * server's own certificate isn't from a public authority, so it's read without that check and its
 * fingerprint comes back as `fingerprint` for the caller to compare with the one it trusts.
 */
function hello(base, timeout = 1500) {
  return new Promise((resolve) => {
    let u; try { u = new URL("/api/hello", base); } catch { return resolve(null); }
    const secure = u.protocol === "https:";
    const mod = secure ? require("node:https") : http;
    const req = mod.get(u, { timeout, headers: { accept: "application/json" }, ...(secure ? { rejectUnauthorized: false, agent: false } : {}) }, (res) => {
      const raw = secure ? res.socket.getPeerCertificate()?.raw : null;
      const fingerprint = raw ? "sha256/" + require("node:crypto").createHash("sha256").update(raw).digest("base64") : null;
      let t = ""; res.setEncoding("utf8"); res.on("data", (d) => { if (t.length < 65536) t += d; });
      res.on("end", () => { try { const j = JSON.parse(t); resolve(typeof j.setUp === "boolean" && Array.isArray(j.profiles) ? { ...j, fingerprint } : null); } catch { resolve(null); } });
    });
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
  });
}
function localNets() {
  const nets = new Set();
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254.")) nets.add(a.address.split(".").slice(0, 3).join("."));
  return [...nets];
}
ipcMain.handle("cellovision:find", async () => {
  const hosts = ["127.0.0.1"];
  for (const n of localNets().slice(0, 4)) for (let i = 1; i < 255; i++) hosts.push(`${n}.${i}`);
  const found = []; let next = 0;
  await Promise.all(Array.from({ length: 96 }, async () => { while (next < hosts.length) { const h = hosts[next++]; const r = await hello(`http://${h}:${PORT}`); if (r) found.push({ url: `http://${h}:${PORT}`, name: r.name, local: h === "127.0.0.1" }); } }));
  return { found: found.filter((f, i) => !(f.local && found.some((g, k) => k !== i && g.name === f.name && !g.local))), nets: localNets() };
});
// ---- HTTPS: trust the server's own certificate once, then only that one ---------------------------

const isLocal = (host) => ["127.0.0.1", "localhost", "[::1]"].includes(host);

/** Ask before trusting a server's certificate the first time (or when it changed). */
async function askTrust(host, fp, changed) {
  const { response } = await dialog.showMessageBox(win?.isVisible() ? win : null, {
    type: changed ? "warning" : "question", title: "Cellovision", buttons: ["Trust this server", "Cancel"], defaultId: changed ? 1 : 0, cancelId: 1,
    message: changed ? `The secure certificate of ${host} has CHANGED.` : `Connect securely to ${host}?`,
    detail: (changed ? "If you didn't reinstall or reset the server, someone on your network may be pretending to be it.\n\n" : "")
      + `Check that this matches the fingerprint in the server's Control Room → Settings → Secure connection:\n\n${fp}`,
  });
  return response === 0;
}

/**
 * The secure address for a server we reached at `base` (plain or secure). Resolves
 * { server, fingerprint } — the HTTPS address with the certificate the person trusted — or, for a
 * server that doesn't offer HTTPS (older ones), its plain address; { error } if not trusted.
 */
async function secureAddress(base, timeout = 6000) {
  const u = new URL(base);
  const h = await hello(u.origin, timeout);
  if (!h) return null;
  let target = u, s = h;
  if (u.protocol === "http:") {
    if (!h.https?.port) return { server: u.origin, fingerprint: null };
    target = new URL(`https://${u.hostname}:${h.https.port}`);
    s = await hello(target.origin, timeout);
    if (!s?.fingerprint) return h.plainHttp !== false ? { server: u.origin, fingerprint: null } : null; // (HTTPS port blocked)
  }
  const known = config.fingerprint && new URL(config.server || "http://x").hostname === target.hostname ? config.fingerprint : null;
  if (!isLocal(target.hostname) && s.fingerprint !== known && !(await askTrust(target.host, s.fingerprint, !!known))) return { error: "Not connected: you didn't trust that server's certificate." };
  return { server: target.origin, fingerprint: s.fingerprint };
}

/** Switch a saved plain-HTTP server over to HTTPS once it offers it (and follow this computer's own server's certificate). */
async function upgradeServer() {
  let u; try { u = new URL(config.server); } catch { return; }
  if (u.protocol === "https:" && !isLocal(u.hostname)) return;
  const r = await secureAddress(isLocal(u.hostname) ? `http://${u.hostname}:${PORT}` : config.server, 3000).catch(() => null);
  if (r?.server && (r.server !== config.server || r.fingerprint !== config.fingerprint)) { config.server = r.server; config.fingerprint = r.fingerprint; saveConfig(); win?.loadURL(config.server).catch(() => {}); }
}

ipcMain.handle("cellovision:connect", async (_e, address) => {
  let a = String(address || "").trim();
  if (!a) return { error: "Type the server's address." };
  if (!/^https?:\/\//i.test(a)) a = `http://${a}`;
  let u; try { u = new URL(a); } catch { return { error: "That doesn't look like an address." }; }
  if (!u.port && u.protocol === "http:") u.port = String(PORT);
  const r = await secureAddress(u.origin);
  if (!r) return { error: `No Cellovision server answered at ${u.host}. Check it's running and on the same network, or use Find servers.` };
  if (r.error) return r;
  config.server = r.server; config.fingerprint = r.fingerprint; saveConfig();
  win.loadURL(config.server).catch(() => {});
  return { ok: true };
});
ipcMain.handle("cellovision:state", () => ({ server: config.server, runServer: !!config.runServer, serverState, theme: config.theme || "dark", isPackaged: app.isPackaged }));
ipcMain.handle("cellovision:be-server", async (_e, on) => {
  config.runServer = !!on; saveConfig();
  if (on) {
    await startServer();
    if (serverState.running) {
      const r = await secureAddress(`http://127.0.0.1:${PORT}`).catch(() => null);
      config.server = r?.server || `http://127.0.0.1:${PORT}`; config.fingerprint = r?.fingerprint || null; saveConfig();
      win.loadURL(config.server).catch(() => {}); if (app.isPackaged) setAutostart(true);
    }
  } else stopServer();
  return serverState;
});
ipcMain.on("cellovision:theme", (_e, mode) => { config.theme = ["dark", "light", "auto"].includes(mode) ? mode : "dark"; saveConfig(); nativeTheme.themeSource = config.theme === "auto" ? "system" : config.theme; buildMenu(); });

// ---- reset a forgotten password (only when the server runs here) -------------------------------

function runReset(name, password) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [serverMain(), "reset-password", name, password], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, windowsHide: true,
    });
    let err = ""; p.stderr.on("data", (d) => { err += d; });
    p.on("exit", (code) => resolve(code === 0 ? null : (err.trim() || `reset failed (code ${code})`)));
    p.on("error", (e) => resolve(e.message));
  });
}
async function resetPasswordFlow() {
  if (!serverState.running) { dialog.showMessageBox(win, { type: "info", title: "Cellovision", message: "This can only reset passwords on a server running on this computer.", detail: "Turn on “Run the server here” first, or reset it on the computer that runs the server." }); return; }
  const info = await hello(`http://127.0.0.1:${PORT}`);
  const names = (info?.profiles || []).map((p) => p.name);
  if (!names.length) { dialog.showMessageBox(win, { type: "info", title: "Cellovision", message: "There are no profiles yet." }); return; }
  const { response } = await dialog.showMessageBox(win, {
    type: "question", title: "Reset a password", message: "Whose password should I reset?",
    detail: "This gives that profile a new password and signs out its devices. Everything else stays.",
    buttons: [...names, "Cancel"], cancelId: names.length,
  });
  if (response >= names.length) return;
  const name = names[response];
  const password = require("node:crypto").randomBytes(9).toString("base64url");
  const err = await runReset(name, password);
  if (err) { dialog.showMessageBox(win, { type: "error", title: "Cellovision", message: `Couldn't reset ${name}'s password.`, detail: err }); return; }
  await dialog.showMessageBox(win, { type: "info", title: "New password for " + name, message: `${name}'s new password:\n\n${password}`, detail: `Sign in with it on any device, then change it in the profile. ${name}'s devices were signed out.` });
}

// ---- the window --------------------------------------------------------------------------------

function show() { if (!win) return createWindow(); if (win.isMinimized()) win.restore(); win.show(); win.focus(); }

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 420, minHeight: 520, icon: ICON, title: "Cellovision", backgroundColor: "#0b0b10", autoHideMenuBar: true,
    show: !process.argv.includes("--hidden"),
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.removeMenu();
  win.on("close", (e) => { if (!quitting && (server || tray)) { e.preventDefault(); win.hide(); } });
  win.on("hide", () => { if (update.ready && autoUpdate()) installUpdate(true); }); // nobody's watching: a good moment
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => {
    if (url.startsWith("file:")) return;
    try { if (new URL(url).origin === origin()) return; } catch { /* bad url */ }
    e.preventDefault(); shell.openExternal(url);
  });
  win.webContents.on("did-fail-load", (_e, code, desc, _url, isMain) => { if (isMain && code !== -3) setup({ error: /CERT/.test(desc) ? `${config.server} answered with a different secure certificate than the one you trusted. If the server was reinstalled, connect again below to check and trust its new one.` : `Couldn't reach ${config.server} (${desc}).` }); });
  // Fullscreen video from the page fills the screen (not just the window).
  win.webContents.on("enter-html-full-screen", () => win.setFullScreen(true));
  win.webContents.on("leave-html-full-screen", () => win.setFullScreen(false));
  if (config.server) win.loadURL(config.server).catch(() => {}); else setup({});
}
function setup(query) { win.loadFile(path.join(__dirname, "setup.html"), { query }).catch(() => {}); }

function buildMenu() {
  if (!tray) return;
  const theme = config.theme || "dark";
  tray.setToolTip(serverState.running ? "Cellovision (server running)" : "Cellovision");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open Cellovision", click: show },
    { type: "separator" },
    { label: serverState.running ? `Server running on this computer (port ${PORT})` : "This computer isn't the server", enabled: false },
    serverState.running ? { label: "Open the Control Room", click: () => { show(); win.loadURL(`${isLocal(new URL(config.server || "http://x").hostname) ? config.server : `http://127.0.0.1:${PORT}`}/#/control`).catch(() => {}); } } : null,
    { label: "Change server…", click: () => { show(); setup({}); } },
    serverState.running ? { label: "Reset a forgotten password…", click: resetPasswordFlow } : null,
    { type: "separator" },
    { label: "Theme", submenu: [["dark", "Dark"], ["light", "Light"], ["auto", "Auto"]].map(([k, l]) => ({ label: l, type: "radio", checked: theme === k, click: () => { config.theme = k; saveConfig(); nativeTheme.themeSource = k === "auto" ? "system" : k; win?.webContents.executeJavaScript(`window.CellovisionSetTheme && window.CellovisionSetTheme(${JSON.stringify(k)})`).catch(() => {}); buildMenu(); } })) },
    { label: "Start when I sign in", type: "checkbox", checked: !!config.autostart, click: (i) => setAutostart(i.checked) },
    { label: "Update automatically", type: "checkbox", checked: autoUpdate(), click: (i) => setAutoUpdate(i.checked) },
    update.ready ? { label: `Restart to update (${update.ready.version})`, click: () => installUpdate(false) }
      : { label: "Check for updates", click: async () => {
        const s = await checkUpdates();
        if (!s.ready) dialog.showMessageBox({ type: "info", title: "Cellovision", message: s.error ? `Couldn't check for updates: ${s.error}` : s.latest && newer(s.latest, s.current) ? `Cellovision ${s.latest} is out.` : `Cellovision ${s.current} is the newest version.` });
      } },
    { type: "separator" },
    { label: serverState.running ? "Quit (stops the server)" : "Quit", click: () => { quitting = true; app.quit(); } },
  ].filter(Boolean)));
}

function setAutostart(on) {
  config.autostart = !!on; saveConfig();
  if (process.platform === "linux") {
    const dir = path.join(app.getPath("home"), ".config", "autostart"), file = path.join(dir, "cellovision.desktop");
    if (on) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, `[Desktop Entry]\nType=Application\nName=Cellovision\nExec="${process.env.APPIMAGE || process.execPath}" --hidden\nIcon=cellovision\nX-GNOME-Autostart-enabled=true\n`); }
    else fs.rmSync(file, { force: true });
  } else app.setLoginItemSettings({ openAtLogin: !!on, args: ["--hidden"] });
  buildMenu();
}

app.whenReady().then(async () => {
  if (process.platform === "win32") app.setAppUserModelId("com.cellovision.desktop");
  nativeTheme.themeSource = config.theme === "auto" ? "system" : config.theme || "dark";
  // The chosen server's own certificate is accepted only if it's exactly the one that was trusted;
  // everything else gets Chromium's normal checks.
  session.defaultSession.setCertificateVerifyProc((req, done) => {
    let host = null; try { host = new URL(config.server).hostname; } catch { /* none yet */ }
    done(host && config.fingerprint && req.hostname === host.replace(/^\[|\]$/g, "") && req.certificate.fingerprint === config.fingerprint ? 0 : -3);
  });
  tray =new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.on("click", show);
  buildMenu();
  createWindow();
  if (config.runServer) {
    await startServer();
    // The window may have tried the local server before it was up.
    if (serverState.running && config.server?.includes("127.0.0.1")) win.loadURL(config.server).catch(() => {});
  }
  upgradeServer();
  setTimeout(() => sendPending(), 10_000);
  // Updates: a minute after starting, then every 6 hours, while the switch is on.
  const maybeUpdate = () => { if (autoUpdate() && app.isPackaged) checkUpdates(); };
  setTimeout(maybeUpdate, 60_000);
  setInterval(maybeUpdate, 6 * 3600_000);
});
app.on("window-all-closed", () => { if (!server && !tray) app.quit(); });
app.on("before-quit", () => { quitting = true; stopServer(); });
