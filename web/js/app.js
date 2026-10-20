// Cellovision web app: signing in, the frame (top bar, menus), and switching pages.
// The Windows, Linux and Android apps show this same app.

import { h, api, state, toast, go, applyTheme, setTheme, localGet, act, sheet } from "./core.js";
import { homePage, shelfPage, itemPage, searchPage, heartsPage, setsPage, setPage, mixtapesPage, mixtapePage, pairPage } from "./pages.js";
import { controlPage } from "./control.js";
import { enableTv } from "./tv.js";
import { watchForErrors, reportSheet } from "./report.js";

watchForErrors();

const app = document.getElementById("app");
applyTheme();
try { if (window.CellovisionApp?.isTV?.() || new URLSearchParams(location.search).get("tv") === "1") enableTv(); } catch { /* not a TV */ }

async function start() {
  try { state.server = await api("GET", "/api/hello"); }
  catch { app.replaceChildren(h("div", { class: "signin" }, h("h1", {}, "Can't reach the server"), h("p", { class: "muted" }, "Check the Cellovision server is running."), h("button", { class: "btn primary", onclick: start }, "Try again"))); return; }
  document.title = state.server.name;
  if (!state.server.setUp) return setupPage();
  try { state.me = await api("GET", "/api/me"); } catch { return signInPage(); }
  shell();
}
window.addEventListener("cv-signed-out", () => { state.me = null; signInPage(); });

// ---- first set-up ------------------------------------------------------------------------------

function setupPage() {
  const server = h("input", { type: "text", value: state.server.name });
  const name = h("input", { type: "text", placeholder: "Your name", autocomplete: "username" });
  const pass = h("input", { type: "password", placeholder: "At least 6 characters", autocomplete: "new-password" });
  const err = h("p", { class: "muted", role: "alert" });
  app.replaceChildren(h("div", { class: "signin" },
    h("img", { class: "logo", src: "icon.svg", alt: "" }), h("h1", {}, "Welcome to Cellovision"),
    h("p", { class: "muted" }, "Your own movies, shows, music and photos, on every screen. First, make your profile; it can run the Control Room."),
    h("form", { onsubmit: async (e) => {
      e.preventDefault(); err.textContent = "";
      try { await api("POST", "/api/setup", { serverName: server.value, name: name.value, password: pass.value, device: navigator.userAgent.slice(0, 60), client: "web" }); await start(); location.hash = "#/control"; }
      catch (x) { err.textContent = x.message; }
    } },
      h("label", { class: "field" }, h("span", {}, "Name this server"), server),
      h("label", { class: "field" }, h("span", {}, "Your name"), name),
      h("label", { class: "field" }, h("span", {}, "Password"), pass), err,
      h("button", { class: "btn primary", type: "submit", style: { width: "100%" } }, "Start"))));
  name.focus();
}

// ---- signing in --------------------------------------------------------------------------------

function signInPage() {
  const profiles = state.server.profiles;
  const box = h("div");
  const pickName = (p) => {
    if (!p.hasPassword) return signIn(p.name, "");
    const pass = h("input", { type: "password", placeholder: "Password", autocomplete: "current-password" });
    const err = h("p", { class: "muted", role: "alert" });
    box.replaceChildren(h("form", { onsubmit: async (e) => { e.preventDefault(); err.textContent = ""; await signIn(p.name, pass.value).catch((x) => { err.textContent = x.message; }); } },
      h("div", { style: { textAlign: "center", marginBottom: "12px" } }, h("div", { class: "avatar", style: { width: "80px", height: "80px", fontSize: "32px", margin: "0 auto 8px", borderRadius: "18px" } }, p.name[0].toUpperCase()), h("strong", {}, p.name)),
      pass, err, h("div", { class: "btns" }, h("button", { class: "btn primary", type: "submit" }, "Sign in"), h("button", { class: "btn", type: "button", onclick: () => draw() }, "Back"))));
    pass.focus();
  };
  const other = () => {
    const name = h("input", { type: "text", placeholder: "Name", autocomplete: "username" }), pass = h("input", { type: "password", placeholder: "Password", autocomplete: "current-password" }), err = h("p", { class: "muted", role: "alert" });
    box.replaceChildren(h("form", { onsubmit: async (e) => { e.preventDefault(); await signIn(name.value, pass.value).catch((x) => { err.textContent = x.message; }); } },
      h("label", { class: "field" }, h("span", {}, "Name"), name), h("label", { class: "field" }, h("span", {}, "Password"), pass), err,
      h("div", { class: "btns" }, h("button", { class: "btn primary", type: "submit" }, "Sign in"), h("button", { class: "btn", type: "button", onclick: () => draw() }, "Back"))));
    name.focus();
  };
  const draw = () => box.replaceChildren(
    h("div", { class: "profiles" }, profiles.map((p) => h("button", { onclick: () => pickName(p) }, h("div", { class: "avatar" }, p.name[0].toUpperCase()), p.name))),
    h("div", { class: "btns", style: { justifyContent: "center" } }, h("button", { class: "btn", onclick: other }, "Someone else"), h("button", { class: "btn", onclick: pairCodeHere }, "Use a Pair Code")));
  draw();
  app.replaceChildren(h("div", { class: "signin" }, h("img", { class: "logo", src: "icon.svg", alt: "" }), h("h1", {}, "Who's watching?"), h("p", { class: "muted" }, state.server.name), box));
  setTimeout(() => app.querySelector(".profiles button")?.focus(), 0);
}

async function signIn(name, password) {
  await api("POST", "/api/signin", { name, password, web: true, device: deviceName(), client: "web" });
  state.me = await api("GET", "/api/me");
  shell();
}
const deviceName = () => { const u = navigator.userAgent; return /Android/.test(u) ? "Android browser" : /iPhone|iPad/.test(u) ? "iPhone browser" : /Windows/.test(u) ? "Windows browser" : /Mac/.test(u) ? "Mac browser" : /Linux/.test(u) ? "Linux browser" : "Browser"; };

/** This screen shows a code; someone signed in approves it on their phone. */
async function pairCodeHere() {
  const { code, secret, expires } = await api("POST", "/api/pair/start", { device: deviceName(), client: "web" });
  let stop = false;
  sheet("Pair Code", (b, close) => {
    b.append(h("p", {}, "On a phone or computer that's signed in, open the menu → Pair Code and type:"), h("div", { style: { textAlign: "center" } }, h("div", { class: "pair-code" }, code)),
      h("p", { class: "muted small" }, `Works for ${Math.round((expires - Date.now()) / 60000)} minutes.`), h("button", { class: "btn", onclick: () => { stop = true; close(); } }, "Cancel"));
  });
  while (!stop && Date.now() < expires) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const r = await api("POST", "/api/pair/check", { code, secret });
      if (r.approved) { await api("POST", "/api/session", { token: r.token }); document.querySelector(".sheet-bg")?.remove(); state.me = await api("GET", "/api/me"); shell(); return; }
    } catch { break; }
  }
}

// ---- the frame -------------------------------------------------------------------------------

let main;
function shell() {
  main = h("main", { id: "main" });
  const links = [["#/home", "Home", "⌂"], ["#/search", "Search", "🔍"], ["#/hearts", "Hearts", "♡"], ["#/mixtapes", "Mixtapes", "🎞"], ["#/sets", "Sets", "🗂"], ...(state.me.admin ? [["#/control", "Control Room", "⚙"]] : [])];
  const avatar = h("button", { class: "avatar", "aria-label": "Your menu", onclick: () => toggleMenu() }, state.me.name[0].toUpperCase());
  const top = h("header", { class: "topbar" },
    h("a", { class: "brand", href: "#/home" }, h("img", { src: "icon.svg", alt: "" }), "Cellovision"),
    h("nav", { class: "nav" }, links.map(([href, label]) => h("a", { href, "data-href": href }, label)), state.me.shelves.map((s) => h("a", { href: `#/shelf/${s.id}`, "data-href": `#/shelf/${s.id}` }, s.name))),
    h("button", { class: "iconbtn", "aria-label": "Search", onclick: () => go("#/search") }, "🔍"), avatar);
  const bottom = h("nav", { class: "bottomnav" }, [["#/home", "Home", "⌂"], ["#/search", "Search", "🔍"], ["#/hearts", "Hearts", "♡"], ["#/mixtapes", "Mixtapes", "🎞"], ...(state.me.admin ? [["#/control", "Control", "⚙"]] : [])]
    .map(([href, label, ic]) => h("a", { href, "data-href": href }, h("span", {}, ic), label)));
  app.replaceChildren(top, main, bottom);
  if (!location.hash || location.hash === "#/") location.hash = "#/home"; else route();
}

function toggleMenu() {
  const old = document.querySelector(".menu");
  if (old) { old.remove(); return; }
  const theme = localGet("theme") || "dark";
  const m = h("div", { class: "menu", role: "menu" },
    h("div", { style: { padding: "8px 12px" } }, h("strong", {}, state.me.name), h("div", { class: "muted small" }, state.server.name)), h("hr"),
    h("a", { href: "#/pair", onclick: () => m.remove() }, "📺 Pair Code (sign in a TV)"),
    h("button", { onclick: () => { m.remove(); devicesSheet(); } }, "💻 My devices"),
    h("button", { onclick: () => { m.remove(); reportSheet(); } }, "🐞 Report a problem"),
    window.CellovisionApp?.updates ? h("button", { onclick: () => { m.remove(); appUpdatesSheet(); } }, "⬆ Updates for this app") : null,
    window.CellovisionApp?.changeServer ? h("button", { onclick: () => { m.remove(); window.CellovisionApp.changeServer(); } }, "🔁 Change server") : null,
    h("hr"),
    h("div", { class: "small muted", style: { padding: "4px 12px" } }, "Theme"),
    h("div", { class: "chips", style: { padding: "4px 10px 8px" } }, [["dark", "Dark"], ["light", "Light"], ["auto", "Auto"]].map(([k, l]) => h("button", { class: `chip${theme === k ? " on" : ""}`, onclick: () => { setTheme(k); m.remove(); } }, l))),
    h("hr"),
    h("button", { onclick: async () => { m.remove(); await api("POST", "/api/signout").catch(() => {}); state.me = null; state.server = await api("GET", "/api/hello"); signInPage(); } }, "↩ Switch profile / sign out"));
  document.body.append(m);
  setTimeout(() => document.addEventListener("click", function off(e) { if (!m.contains(e.target)) { m.remove(); document.removeEventListener("click", off); } }), 0);
}

/** The Windows/Linux/Android app's own updates (it fetches only versions signed by the owner). */
async function appUpdatesSheet() {
  const app = window.CellovisionApp;
  const read = async () => { const s = await app.updates(); return typeof s === "string" ? JSON.parse(s) : s; };
  let s = await read();
  sheet("Updates for this app", (b) => {
    const status = h("p", { class: "muted" });
    const draw = () => { status.textContent = [`This is Cellovision ${s.current || s.version || ""}.`, s.ready ? `Version ${s.ready} is ready to go in.` : s.latest ? `Newest: ${s.latest}.` : "", s.status || "", s.error ? `Last check failed: ${s.error}` : ""].filter(Boolean).join(" "); };
    const sw = h("input", { type: "checkbox", checked: s.auto, onchange: async (e) => { await app.setAutoUpdate(e.target.checked); s = await read(); draw(); } });
    draw();
    b.append(
      h("label", { class: "li", style: { padding: "8px 0" } }, sw, h("div", { class: "grow" }, h("div", { style: { fontWeight: "700" } }, "Update automatically"),
        h("div", { class: "muted small" }, "New versions download in the background and go in when you're not watching. Only versions signed by the owner are accepted."))),
      status,
      h("div", { class: "btns" },
        h("button", { class: "btn", onclick: async (e) => { e.target.disabled = true; const r = await app.checkUpdatesNow(); s = await read(); if (typeof r === "string") s.status = r; draw(); e.target.disabled = false; } }, "Check now"),
        s.ready && app.installUpdate ? h("button", { class: "btn primary", onclick: () => app.installUpdate() }, "Restart to update") : null));
  });
}

async function devicesSheet() {
  const { devices } = await api("GET", "/api/me/devices");
  sheet("My devices", (b, close) => b.append(h("p", { class: "muted" }, "Everywhere you're signed in. Remove one you don't recognise."),
    h("div", { class: "list" }, devices.map((d) => h("div", { class: "li" }, h("div", { class: "grow" }, h("div", { style: { fontWeight: "600" } }, d.device || "Device"), h("div", { class: "muted small" }, `${d.client || ""} · last used ${new Date(d.last_seen).toLocaleString()}`)),
      h("button", { class: "btn small danger", onclick: () => act(async () => { await api("DELETE", "/api/me/devices", { id: d.id }); close(); devicesSheet(); }, "Signed out there") }, "Sign out"))))));
}

// ---- pages -----------------------------------------------------------------------------------

const ROUTES = [
  [/^#\/home$/, () => homePage()],
  [/^#\/shelf\/([\w-]+)(?:\?(.*))?$/, (m) => shelfPage(m[1], m[2])],
  [/^#\/item\/([a-f0-9]{20})$/, (m) => itemPage(m[1])],
  [/^#\/search(?:\?q=(.*))?$/, (m) => searchPage(decodeURIComponent(m[1] || ""))],
  [/^#\/hearts$/, () => heartsPage()],
  [/^#\/sets$/, () => setsPage()],
  [/^#\/set\/([\w-]+)$/, (m) => setPage(m[1])],
  [/^#\/mixtapes$/, () => mixtapesPage()],
  [/^#\/mixtape\/([a-f0-9]+)$/, (m) => mixtapePage(m[1])],
  [/^#\/pair$/, () => pairPage()],
  [/^#\/control$/, () => controlPage()],
];

let routing = 0;
async function route() {
  if (!state.me || !main) return;
  const mine = ++routing;
  const hash = location.hash || "#/home";
  document.querySelectorAll("[data-href]").forEach((a) => a.classList.toggle("on", hash === a.dataset.href || hash.startsWith(a.dataset.href + "?") || (a.dataset.href !== "#/home" && hash.startsWith(a.dataset.href + "/"))));
  const r = ROUTES.find(([re]) => re.test(hash));
  try {
    const el = r ? await r[1](hash.match(r[0])) : h("div", { class: "empty" }, "Page not found.");
    if (mine !== routing) return;
    main.replaceChildren(el);
    window.scrollTo(0, 0);
  } catch (e) {
    if (e.status !== 401 && mine === routing) main.replaceChildren(h("div", { class: "empty" }, e.message));
  }
}
window.addEventListener("hashchange", route);
window.addEventListener("cv-player-closed", () => { if (/^#\/(home|item)/.test(location.hash)) route(); });

start();
