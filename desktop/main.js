// Cellovision for Windows and Linux.
//   - Watch: opens a Cellovision server's app in its own window (with real full screen and media keys).
//   - Be the server: this computer can run the Cellovision server itself (the same program the
//     project's server folder has, run by this app's own Node), so one install covers both.
// Closing the window keeps the server running in the tray; Quit stops everything.

const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage, nativeTheme, dialog } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const http = require("node:http");
const { spawn } = require("node:child_process");
const ffmpeg = require("./ffmpeg-get.js");

const ICON = path.join(__dirname, "icon.png");
if (process.env.CELLOVISION_PROFILE && !app.isPackaged) app.setPath("userData", process.env.CELLOVISION_PROFILE); // (testing)
const PORT = 8420;
let win = null, tray = null, quitting = false, server = null, serverState = { running: false, error: null, ffmpeg: null, progress: null };

const configFile = () => path.join(app.getPath("userData"), "config.json");
function loadConfig() { try { return JSON.parse(fs.readFileSync(configFile(), "utf8")); } catch { return { server: "", runServer: false, autostart: false, theme: "dark" }; } }
let config = loadConfig();
function saveConfig() { fs.mkdirSync(path.dirname(configFile()), { recursive: true }); fs.writeFileSync(configFile(), JSON.stringify(config, null, 1)); }
const origin = () => { try { return new URL(config.server).origin; } catch { return null; } };

if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => show());

// ---- the server on this computer -------------------------------------------------------------

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
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", CELLOVISION_FFMPEG: ff, CELLOVISION_PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  server.stdout.pipe(log); server.stderr.pipe(log);
  server.stderr.on("data", (d) => { const s = String(d); if (/EADDRINUSE/.test(s)) serverState.error = `Port ${PORT} is already in use (is another Cellovision server running?).`; });
  server.on("exit", (code) => { server = null; serverState.running = false; if (code && !quitting && !serverState.error) serverState.error = `The server stopped (code ${code}). Details: ${logFile}`; tell(); buildMenu(); });
  // Running once it answers.
  for (let i = 0; i < 40 && server; i++) { if (await hello(`http://127.0.0.1:${PORT}`, 1000)) { serverState.running = true; break; } await new Promise((r) => setTimeout(r, 250)); }
  tell(); buildMenu();
}
function stopServer() { if (server) { server.kill(); server = null; } serverState.running = false; tell(); buildMenu(); }
function tell() { win?.webContents.send("cellovision:server-state", serverState); }

// ---- finding servers ---------------------------------------------------------------------------

/** Is there a Cellovision server here? Resolves its /api/hello answer, or null. */
function hello(base, timeout = 1500) {
  return new Promise((resolve) => {
    let u; try { u = new URL("/api/hello", base); } catch { return resolve(null); }
    const mod = u.protocol === "https:" ? require("node:https") : http;
    const req = mod.get(u, { timeout, headers: { accept: "application/json" } }, (res) => {
      let t = ""; res.setEncoding("utf8"); res.on("data", (d) => { if (t.length < 65536) t += d; });
      res.on("end", () => { try { const j = JSON.parse(t); resolve(typeof j.setUp === "boolean" && Array.isArray(j.profiles) ? j : null); } catch { resolve(null); } });
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
ipcMain.handle("cellovision:connect", async (_e, address) => {
  let a = String(address || "").trim();
  if (!a) return { error: "Type the server's address." };
  if (!/^https?:\/\//i.test(a)) a = `http://${a}`;
  let u; try { u = new URL(a); } catch { return { error: "That doesn't look like an address." }; }
  if (!u.port && u.protocol === "http:") u.port = String(PORT);
  if (!(await hello(u.origin, 6000))) return { error: `No Cellovision server answered at ${u.host}. Check it's running and on the same network, or use Find servers.` };
  config.server = u.origin; saveConfig();
  win.loadURL(config.server).catch(() => {});
  return { ok: true };
});
ipcMain.handle("cellovision:state", () => ({ server: config.server, runServer: !!config.runServer, serverState, theme: config.theme || "dark", isPackaged: app.isPackaged }));
ipcMain.handle("cellovision:be-server", async (_e, on) => {
  config.runServer = !!on; saveConfig();
  if (on) {
    await startServer();
    if (serverState.running) { config.server = `http://127.0.0.1:${PORT}`; saveConfig(); win.loadURL(config.server).catch(() => {}); if (app.isPackaged) setAutostart(true); }
  } else stopServer();
  return serverState;
});
ipcMain.on("cellovision:theme", (_e, mode) => { config.theme = ["dark", "light", "auto"].includes(mode) ? mode : "dark"; saveConfig(); nativeTheme.themeSource = config.theme === "auto" ? "system" : config.theme; buildMenu(); });

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
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => {
    if (url.startsWith("file:")) return;
    try { if (new URL(url).origin === origin()) return; } catch { /* bad url */ }
    e.preventDefault(); shell.openExternal(url);
  });
  win.webContents.on("did-fail-load", (_e, code, desc, _url, isMain) => { if (isMain && code !== -3) setup({ error: `Couldn't reach ${config.server} (${desc}).` }); });
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
    serverState.running ? { label: "Open the Control Room", click: () => { show(); win.loadURL(`http://127.0.0.1:${PORT}/#/control`).catch(() => {}); } } : null,
    { label: "Change server…", click: () => { show(); setup({}); } },
    { type: "separator" },
    { label: "Theme", submenu: [["dark", "Dark"], ["light", "Light"], ["auto", "Auto"]].map(([k, l]) => ({ label: l, type: "radio", checked: theme === k, click: () => { config.theme = k; saveConfig(); nativeTheme.themeSource = k === "auto" ? "system" : k; win?.webContents.executeJavaScript(`window.CellovisionSetTheme && window.CellovisionSetTheme(${JSON.stringify(k)})`).catch(() => {}); buildMenu(); } })) },
    { label: "Start when I sign in", type: "checkbox", checked: !!config.autostart, click: (i) => setAutostart(i.checked) },
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
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.on("click", show);
  buildMenu();
  createWindow();
  if (config.runServer) {
    await startServer();
    // The window may have tried the local server before it was up.
    if (serverState.running && config.server?.includes("127.0.0.1")) win.loadURL(config.server).catch(() => {});
  }
});
app.on("window-all-closed", () => { if (!server && !tray) app.quit(); });
app.on("before-quit", () => { quitting = true; stopServer(); });
