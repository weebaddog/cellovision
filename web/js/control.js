// The Control Room: what's playing, shelves, profiles, settings and what happened. Admins only.

import { h, api, act, sheet, confirmBox, go, fmtTime } from "./core.js";
import { cloudSection } from "./cloud.js";

const KINDS = [["movies", "🎬 Movies"], ["shows", "📺 Shows"], ["music", "🎵 Music"], ["photos", "🖼 Photos"], ["videos", "📹 Home videos"]];
const AGES = [[null, "No limit"], [0, "Everyone (G, TV-Y, TV-G)"], [7, "7 and up (TV-Y7)"], [10, "10 and up (PG, TV-PG)"], [13, "13 and up (PG-13)"], [14, "14 and up (TV-14)"], [16, "16 and up"], [17, "17 and up (R, TV-MA)"]];
let refresh = null;

export async function controlPage() {
  clearInterval(refresh);
  const c = await api("GET", "/api/control");
  const root = h("div", {},
    h("h1", {}, "Control Room"),
    h("p", { class: "muted" }, `${c.serverName} · Cellovision ${c.version} · data in ${c.dataDir}`),
    nowBlock(c),
    c.cloud ? h("section", { class: "row" }, h("h2", {}, "CelloCloud account"),
      cloudSection(c.cloud, (r) => { if (r.locked) window.dispatchEvent(new CustomEvent("cv-locked", { detail: r })); })) : null,
    shelvesBlock(c),
    profilesBlock(c),
    settingsBlock(c),
    await reportsBlock(),
    h("h2", {}, "What happened"),
    h("div", { class: "list" }, c.activity.length ? c.activity.map((a) => h("div", { class: "li" }, h("span", { class: "muted small", style: { width: "150px", flex: "none" } }, new Date(a.at).toLocaleString()), h("div", { class: "grow" }, h("div", {}, a.text)))) : h("div", { class: "empty" }, "Nothing yet.")));
  // Keep "now" fresh while the page is open.
  refresh = setInterval(async () => {
    if (!document.body.contains(root)) { clearInterval(refresh); return; }
    try { const n = await api("GET", "/api/control"); root.querySelector(".now")?.replaceWith(nowBlock(n)); } catch { /* signed out */ }
  }, 5000);
  return root;
}

function nowBlock(c) {
  const playing = c.playing.map((p) => h("div", { class: "li" }, h("span", {}, p.paused ? "⏸" : "▶"),
    h("div", { class: "grow" }, h("div", { style: { fontWeight: "700" } }, p.item.title), h("div", { class: "muted small" }, `${p.profile} on ${p.device} · ${fmtTime(p.position)}${p.mode ? ` · ${p.mode}` : ""}`))));
  const conv = c.conversions.map((s) => h("div", { class: "li" }, h("span", {}, "⚙"), h("div", { class: "grow" }, h("div", {}, s.title), h("div", { class: "muted small" }, `${s.mode === "convert" ? `Converting with ${s.encoder}` : "Repackaging"} from ${fmtTime(s.start)}${s.failed ? ` · failed: ${s.failed}` : ""}`))));
  return h("div", { class: "now" },
    c.scanning ? h("div", { class: "panel" }, h("strong", {}, `Scanning ${c.scanning.shelf}…`), h("div", { class: "muted small" }, `${c.scanning.done} of ${c.scanning.total} files`),
      h("div", { class: "meter", style: { marginTop: "8px" } }, h("i", { style: { width: `${c.scanning.total ? (c.scanning.done / c.scanning.total) * 100 : 0}%` } }))) : null,
    h("h2", {}, "Watching now"),
    h("div", { class: "list", style: { marginBottom: "18px" } }, playing.length || conv.length ? [...playing, ...conv] : h("div", { class: "empty", style: { padding: "18px" } }, "Nobody's watching right now.")));
}

// ---- Shelves --------------------------------------------------------------------------------

function shelvesBlock(c) {
  return h("section", { class: "row" },
    h("h2", {}, "Shelves"),
    h("div", { class: "list" },
      c.shelves.map((s) => h("div", { class: "li" },
        h("span", { style: { fontSize: "22px" } }, KINDS.find((k) => k[0] === s.kind)?.[1].split(" ")[0]),
        h("div", { class: "grow" }, h("div", { style: { fontWeight: "700" } }, s.name), h("div", { class: "muted small" }, `${s.items} items · ${s.paths.join(" · ")}`),
          h("div", { class: "muted small" }, s.scanned ? `Scanned ${new Date(s.scanned).toLocaleString()}` : "Not scanned yet")),
        h("button", { class: "btn small", onclick: () => act(() => api("POST", "/api/control/scan", { id: s.id }), "Scanning…") }, "Rescan"),
        h("button", { class: "btn small", onclick: () => editShelf(s) }, "Edit"))),
      !c.shelves.length ? h("div", { class: "empty", style: { padding: "18px" } }, "No shelves yet. Add the folders where your movies, shows, music or photos are.") : null),
    h("div", { class: "btns" }, h("button", { class: "btn primary", onclick: () => editShelf(null) }, "+ Add a shelf"),
      c.shelves.length ? h("button", { class: "btn", onclick: () => act(() => api("POST", "/api/control/scan", {}), "Scanning everything…") }, "Rescan all") : null));
}

function editShelf(s) {
  sheet(s ? `Edit ${s.name}` : "Add a shelf", (b, close) => {
    const paths = [...(s?.paths || [])];
    let kind = s?.kind || "movies";
    const name = h("input", { type: "text", value: s?.name || "", placeholder: "e.g. Movies, Kids' shows, Family photos" });
    const kindRow = h("div", { class: "chips" });
    const drawKinds = () => kindRow.replaceChildren(...KINDS.map(([k, l]) => h("button", { class: `chip${kind === k ? " on" : ""}`, disabled: !!s, onclick: () => { kind = k; drawKinds(); if (!name.value) name.placeholder = l.slice(3); } }, l)));
    drawKinds();
    const list = h("div", { class: "list" });
    const drawPaths = () => list.replaceChildren(...(paths.length ? paths.map((p, n) => h("div", { class: "li" }, h("div", { class: "grow" }, h("div", {}, p)), h("button", { class: "iconbtn", "aria-label": "Remove folder", onclick: () => { paths.splice(n, 1); drawPaths(); } }, "✕")))
      : [h("div", { class: "empty", style: { padding: "14px" } }, "No folders yet.")]));
    drawPaths();
    b.append(
      h("label", { class: "field" }, h("span", {}, "What's on it"), kindRow),
      h("label", { class: "field" }, h("span", {}, "Name"), name),
      h("div", { class: "field" }, h("span", { style: { fontWeight: "600", fontSize: "13px" } }, "Folders"), list,
        h("div", { class: "btns" }, h("button", { class: "btn", onclick: () => pickFolder((p) => { if (!paths.includes(p)) paths.push(p); drawPaths(); }) }, "+ Add a folder"))),
      h("p", { class: "muted small" }, kind === "shows" ? "Each show in its own folder, with “Season 1”, “Season 2”… folders inside (or names like S01E02)." : kind === "movies" ? "Files like “Heat (1995).mkv”, or each film in a folder named “Heat (1995)”." : kind === "music" ? "Read from the songs' tags; otherwise Artist / Album / 01 Song.mp3 folders." : "Kept in your folders as they are."),
      h("div", { class: "btns" },
        h("button", { class: "btn primary", onclick: () => act(async () => {
          if (s) await api("PUT", "/api/control/shelves", { id: s.id, name: name.value || s.name, paths });
          else await api("POST", "/api/control/shelves", { name: name.value || KINDS.find((k) => k[0] === kind)[1].slice(3), kind, paths });
          close(); go("#/control");
        }, s ? "Saved; rescanning" : "Shelf added; scanning now") }, s ? "Save" : "Add shelf"),
        s ? h("button", { class: "btn danger", onclick: () => confirmBox(`Remove ${s.name}?`, "Your files aren't touched; the shelf just leaves Cellovision (with everyone's progress on it).", "Remove", async () => { await act(() => api("DELETE", "/api/control/shelves", { id: s.id }), "Removed"); close(); go("#/control"); }) }, "Remove shelf") : null));
  });
}

/** A folder picker that browses the server computer's drives. */
function pickFolder(done) {
  sheet("Pick a folder", (b, close) => {
    const where = h("div", { class: "muted small", style: { margin: "4px 0 10px", wordBreak: "break-all" } });
    const list = h("div", { class: "list", style: { maxHeight: "50vh", overflow: "auto" } });
    let current = "";
    const open = async (p) => {
      const r = await act(() => api("GET", `/api/control/folders${p ? `?path=${encodeURIComponent(p)}` : ""}`));
      if (!r) return;
      current = r.path;
      where.textContent = r.path || "This computer";
      list.replaceChildren(
        ...(r.path ? [h("div", { class: "li click", onclick: () => open(r.parent || "") }, h("span", {}, "⬆"), h("div", { class: "grow" }, h("div", {}, "Up")))] : []),
        ...r.folders.map((f) => h("div", { class: "li click", onclick: () => open(f) }, h("span", {}, "📁"), h("div", { class: "grow" }, h("div", {}, f.split(/[\\/]/).filter(Boolean).pop() || f)))),
        ...(r.folders.length ? [] : [h("div", { class: "empty", style: { padding: "14px" } }, "No folders inside.")]));
    };
    b.append(where, list, h("div", { class: "btns" }, h("button", { class: "btn primary", onclick: () => { if (current) { done(current); close(); } } }, "Use this folder")));
    open("");
  });
}

// ---- Profiles --------------------------------------------------------------------------------

function profilesBlock(c) {
  return h("section", { class: "row" },
    h("h2", {}, "Profiles"),
    h("div", { class: "list" }, c.profiles.map((p) => h("div", { class: "li click", onclick: () => editProfile(p, c) },
      h("div", { class: "avatar" }, p.name.slice(0, 1).toUpperCase()),
      h("div", { class: "grow" }, h("div", { style: { fontWeight: "700" } }, p.name),
        h("div", { class: "muted small" }, [p.admin ? "Admin" : null, p.max_age !== null ? `Age Limit: ${AGES.find((a) => a[0] === p.max_age)?.[1] || p.max_age}` : null, p.shelves ? `${p.shelves.length} shelves` : "All shelves", p.hasPassword ? "Password" : "No password"].filter(Boolean).join(" · ")))))),
    h("div", { class: "btns" }, h("button", { class: "btn primary", onclick: () => editProfile(null, c) }, "+ Add a profile")));
}

function editProfile(p, c) {
  sheet(p ? p.name : "New profile", (b, close) => {
    const name = h("input", { type: "text", value: p?.name || "" });
    const pass = h("input", { type: "password", placeholder: p ? (p.hasPassword ? "Leave empty to keep it" : "None set") : "Optional for family members", autocomplete: "new-password" });
    let clearPass = false;
    const age = h("select", {}, AGES.map(([v, l]) => h("option", { value: v === null ? "" : String(v), selected: (p?.max_age ?? null) === v }, l)));
    const isAdmin = h("input", { type: "checkbox", checked: p?.admin });
    let allShelves = !p?.shelves;
    const chosen = new Set(p?.shelves || c.shelves.map((s) => s.id));
    const shelfBox = h("div");
    const drawShelves = () => shelfBox.replaceChildren(
      h("label", { class: "li" }, h("input", { type: "checkbox", checked: allShelves, onchange: (e) => { allShelves = e.target.checked; drawShelves(); } }), h("div", { class: "grow" }, h("div", {}, "All shelves (including new ones)"))),
      ...(allShelves ? [] : c.shelves.map((s) => h("label", { class: "li" }, h("input", { type: "checkbox", checked: chosen.has(s.id), onchange: (e) => { if (e.target.checked) chosen.add(s.id); else chosen.delete(s.id); } }), h("div", { class: "grow" }, h("div", {}, s.name))))));
    drawShelves();
    b.append(
      h("label", { class: "field" }, h("span", {}, "Name"), name),
      h("label", { class: "field" }, h("span", {}, "Password"), pass),
      p?.hasPassword ? h("label", { class: "li" }, h("input", { type: "checkbox", onchange: (e) => { clearPass = e.target.checked; } }), h("div", { class: "grow" }, h("div", {}, "Remove the password"))) : null,
      h("label", { class: "field" }, h("span", {}, "Age Limit"), age),
      h("div", { class: "field" }, h("span", { style: { fontWeight: "600", fontSize: "13px" } }, "Shelves this profile sees"), h("div", { class: "list" }, shelfBox)),
      h("label", { class: "li", style: { padding: "10px 0" } }, isAdmin, h("div", { class: "grow" }, h("div", {}, "Admin (can open the Control Room)"))),
      h("div", { class: "btns" },
        h("button", { class: "btn primary", onclick: () => act(async () => {
          const body = { name: name.value, admin: isAdmin.checked, maxAge: age.value === "" ? null : +age.value, shelves: allShelves ? null : [...chosen] };
          if (pass.value) body.password = pass.value; else if (clearPass) body.password = null;
          if (p) await api("PUT", "/api/control/profiles", { id: p.id, ...body }); else await api("POST", "/api/control/profiles", body);
          close(); go("#/control");
        }, "Saved") }, "Save"),
        p ? h("button", { class: "btn danger", onclick: () => confirmBox(`Delete ${p.name}?`, "Their Keep Watching, Hearts and Mixtapes go too.", "Delete", async () => { await act(() => api("DELETE", "/api/control/profiles", { id: p.id }), "Deleted"); close(); go("#/control"); }) }, "Delete") : null));
  });
}

// ---- Problem reports ------------------------------------------------------------------------------

async function reportsBlock() {
  const r = await api("GET", "/api/control/reports");
  const m = r.mail;
  const to = h("input", { type: "text", value: m.to, placeholder: "you@gmail.com", autocomplete: "email" });
  const user = h("input", { type: "text", value: m.user, placeholder: "the Gmail account that sends them (can be the same)", autocomplete: "off" });
  const pass = h("input", { type: "password", placeholder: m.hasPass ? "Saved (type a new one to replace it)" : "16-letter App Password from Google", autocomplete: "new-password" });
  const host = h("input", { type: "text", value: m.host }), port = h("input", { type: "number", value: String(m.port) });
  const off = h("input", { type: "checkbox", checked: m.off });
  const save = () => api("PUT", "/api/control/reports", { to: to.value, user: user.value, host: host.value, port: +port.value, off: off.checked, ...(pass.value ? { pass: pass.value } : {}) });
  return h("section", { class: "row" }, h("h2", {}, "Problem reports"),
    h("div", { class: "panel" },
      h("p", { class: "muted" }, "Crashes, errors and failed playback from every Cellovision app (and anything people send with “Report a problem”) are emailed to you. The same problem again is counted, not repeated."),
      h("label", { class: "field" }, h("span", {}, "Send them to"), to),
      h("label", { class: "field" }, h("span", {}, "Send from (Gmail account)"), user),
      h("label", { class: "field" }, h("span", {}, "App Password for that account"), pass,
        h("div", { class: "muted small", style: { marginTop: "4px" } }, "Google won't take your normal password here. Make an App Password: myaccount.google.com → Security → 2-Step Verification (turn on) → App passwords → name it “Cellovision” → copy the 16 letters here. You can delete it there any time.")),
      h("details", {}, h("summary", { class: "muted small" }, "Not Gmail?"), h("div", { class: "toolbar" }, h("label", { class: "field", style: { flex: "1" } }, h("span", {}, "Mail server"), host), h("label", { class: "field", style: { width: "110px" } }, h("span", {}, "Port (SSL)"), port))),
      h("label", { class: "li", style: { padding: "8px 0" } }, off, h("div", { class: "grow" }, h("div", {}, "Pause the emails (reports are still kept here)"))),
      m.lastError ? h("p", { style: { color: "var(--bad)" } }, `Last email failed: ${m.lastError.message}`) : null,
      h("div", { class: "btns" },
        h("button", { class: "btn primary", onclick: () => act(async () => { await save(); go("#/control"); }, "Saved") }, "Save"),
        h("button", { class: "btn", onclick: () => act(async () => { await save(); await api("POST", "/api/control/reports/test"); }, "Test email sent: check your inbox") }, "Send a test email"))),
    r.reports.length ? h("div", { class: "list" }, r.reports.slice(0, 30).map((x) => h("div", { class: "li" },
      h("span", {}, x.kind === "user" ? "🗣" : "🐞"),
      h("div", { class: "grow" }, h("div", { style: { fontWeight: "600", whiteSpace: "normal" } }, x.message),
        h("div", { class: "muted small" }, `${x.source} · ${x.kind}${x.count > 1 ? ` · ${x.count} times` : ""} · ${new Date(x.last).toLocaleString()}${x.device ? ` · ${x.device}` : ""}${x.sent ? " · emailed" : ""}`)))))
      : h("p", { class: "muted" }, "No problems reported yet."));
}

// ---- Settings --------------------------------------------------------------------------------

function settingsBlock(c) {
  const serverName = h("input", { type: "text", value: c.serverName });
  const tmdb = h("input", { type: "password", placeholder: c.settings.tmdbKey ? "A key is saved (type a new one to replace it)" : "Paste your TMDB API key or read-access token", autocomplete: "off" });
  const enc = h("select", {}, [["auto", "Automatic (graphics chip if it works)"], ["h264_amf", "AMD graphics (AMF)"], ["h264_nvenc", "NVIDIA graphics (NVENC)"], ["h264_qsv", "Intel graphics (Quick Sync)"], ["libx264", "Processor only (x264)"]]
    .map(([v, l]) => h("option", { value: v, selected: c.settings.encoder === v }, l)));
  const every = h("select", {}, [[0, "Never (only when I press Rescan)"], [1, "Every hour"], [6, "Every 6 hours"], [12, "Every 12 hours"], [24, "Once a day"]].map(([v, l]) => h("option", { value: String(v), selected: c.settings.scanEvery === v }, l)));
  const plain = h("input", { type: "checkbox", checked: c.settings.plainHttp !== false });
  const secure = c.https ? h("div", { class: "field" }, h("span", {}, "Secure connection"),
    h("div", { class: "muted small" }, `The Windows, Linux and Android apps connect over HTTPS (port ${c.https.port}) with this server's own certificate. The first time, they show its fingerprint: it should match this one.`),
    h("code", { style: { display: "block", wordBreak: "break-all", margin: "6px 0" } }, c.https.fingerprint),
    h("label", { style: { display: "flex", gap: "8px", alignItems: "center" } }, plain, h("span", {}, "Also allow plain HTTP (needed by the iPhone and Apple TV apps, and older apps)"))) : null;
  return h("section", { class: "row" }, h("h2", {}, "Settings"),
    h("div", { class: "panel" },
      h("label", { class: "field" }, h("span", {}, "Server name"), serverName),
      h("label", { class: "field" }, h("span", {}, "Details from TMDB (optional)"), tmdb,
        h("div", { class: "muted small", style: { marginTop: "4px" } }, "Plots, posters and age ratings for films and shows. Free: make an account at themoviedb.org → Settings → API. Without it, Cellovision uses the .nfo files and pictures next to your media.")),
      h("label", { class: "field" }, h("span", {}, "Fit to Device: convert video with"), enc),
      h("label", { class: "field" }, h("span", {}, "Look for new files"), every),
      secure,
      h("div", { class: "btns" }, h("button", { class: "btn primary", onclick: () => act(async () => {
        await api("PUT", "/api/control/settings", { serverName: serverName.value, encoder: enc.value, scanEvery: +every.value, plainHttp: plain.checked, ...(tmdb.value ? { tmdbKey: tmdb.value } : {}) });
        // Plain HTTP just turned off while on it: carry on over HTTPS.
        if (!plain.checked && c.https && location.protocol === "http:") { location.href = `https://${location.hostname}:${c.https.port}/#/control`; return; }
        go("#/control");
      }, "Settings saved") }, "Save settings"),
        c.settings.tmdbKey ? h("button", { class: "btn", onclick: () => act(async () => { await api("PUT", "/api/control/settings", { tmdbKey: "" }); go("#/control"); }, "TMDB key removed") }, "Remove TMDB key") : null)));
}
