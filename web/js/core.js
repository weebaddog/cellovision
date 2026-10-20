// Shared bits: building elements, talking to the server, pop-ups, and what this device can play.

export const state = { me: null, server: null, token: null, mediaToken: null };

// The web app signs in with a cookie; the desktop and phone apps (which load this same app) can
// pass a token instead (window.CellovisionApp.token()).
export function bearer() {
  try { return window.CellovisionApp?.token?.() || null; } catch { return null; }
}

export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k === "value") el.value = v;
    else if (k === "checked") el.checked = !!v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}

export class ApiError extends Error { constructor(message, status, data = null) { super(message); this.status = status; this.data = data; } }

export async function api(method, path, body) {
  const headers = { "content-type": "application/json", "x-cellovision": "1" };
  const t = bearer();
  if (t) headers.authorization = `Bearer ${t}`;
  const r = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: "same-origin" });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && !path.startsWith("/api/signin")) { window.dispatchEvent(new Event("cv-signed-out")); throw new ApiError("Sign in", 401); }
  // The CelloCloud plan doesn't include Cellovision now: the app shows the lock page (app.js).
  if (r.status === 423 && data.locked) window.dispatchEvent(new CustomEvent("cv-locked", { detail: data }));
  if (!r.ok) throw new ApiError(data.error || `Error ${r.status}`, r.status, data);
  return data;
}

/**
 * A media address (pictures, files, streams) that works without our headers. In a browser the
 * same-origin cookie authorizes it, so nothing goes in the URL. The phone/desktop wrappers sign in
 * with a token instead, so they put a short-lived media-only token in the URL — never the account one.
 */
export function mediaUrl(path) {
  if (!bearer()) return path;
  const t = state.mediaToken || bearer();
  return `${path}${path.includes("?") ? "&" : "?"}t=${encodeURIComponent(t)}`;
}
export const img = (id, which = "poster", w = 320) => mediaUrl(`/api/img/${id}/${which}?w=${Math.round(w * (window.devicePixelRatio || 1))}`);

export function toast(msg, bad = false) {
  document.querySelectorAll(".toast").forEach((t) => t.remove());
  const t = h("div", { class: `toast${bad ? " bad" : ""}`, role: "status" }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 3500);
}
export async function act(fn, ok) {
  try { const r = await fn(); if (ok) toast(ok); return r; } catch (e) { if (e.status !== 401 && e.status !== 423) toast(e.message, true); }
}

export function sheet(title, build) {
  const close = () => { bg.remove(); document.removeEventListener("keydown", esc); };
  const esc = (e) => { if (e.key === "Escape") close(); };
  const body = h("div");
  const bg = h("div", { class: "sheet-bg", onclick: (e) => { if (e.target === bg) close(); } },
    h("div", { class: "sheet", role: "dialog", "aria-modal": "true", "aria-label": title },
      h("div", { class: "head" }, h("h2", {}, title), h("button", { class: "iconbtn", "aria-label": "Close", onclick: close }, "✕")), body));
  document.addEventListener("keydown", esc);
  document.body.append(bg);
  build(body, close);
  return close;
}

export function confirmBox(title, text, yes, onYes) {
  sheet(title, (b, close) => b.append(h("p", {}, text), h("div", { class: "btns" },
    h("button", { class: "btn primary", onclick: async () => { close(); await onYes(); } }, yes), h("button", { class: "btn", onclick: close }, "Cancel"))));
}

export const fmtTime = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return hh ? `${hh}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}` : `${mm}:${String(ss).padStart(2, "0")}`;
};
export const fmtRuntime = (s) => { if (!s) return null; const m = Math.round(s / 60); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`; };
export const ep = (i) => (i.seasonNo !== null && i.episodeNo !== null ? `S${i.seasonNo} · E${i.episodeNo}` : "");

/** What this browser can play without help (sent to the server so it can Fit to Device). */
export function deviceCaps() {
  const v = document.createElement("video");
  const can = (t) => !!v.canPlayType(t).replace("no", "");
  const video = ["h264"];
  if (can('video/mp4; codecs="hvc1.1.6.L120.90"') || can('video/mp4; codecs="hev1.1.6.L120.90"')) video.push("hevc");
  if (can('video/webm; codecs="vp9"')) video.push("vp9");
  if (can('video/mp4; codecs="av01.0.05M.08"')) video.push("av1");
  if (can('video/webm; codecs="vp8"')) video.push("vp8");
  const audio = ["aac", "mp3"];
  if (can('audio/ogg; codecs="opus"') || can('audio/webm; codecs="opus"')) audio.push("opus");
  if (can("audio/flac")) audio.push("flac");
  if (can('audio/ogg; codecs="vorbis"')) audio.push("vorbis");
  if (can('audio/mp4; codecs="ac-3"')) audio.push("ac3");
  if (can('audio/mp4; codecs="ec-3"')) audio.push("eac3");
  const containers = ["mp4", "mp3", "m4a", "wav"];
  if (can("video/webm")) containers.push("webm");
  if (can("audio/flac")) containers.push("flac");
  if (can("audio/ogg")) containers.push("ogg");
  const pref = localGet("quality");
  return { video, audio, containers, maxHeight: pref && pref !== "auto" ? +pref : null, hdr: matchMedia("(dynamic-range: high)").matches && video.includes("hevc") };
}

export function localGet(k) { try { return localStorage.getItem(`cv.${k}`); } catch { return null; } }
export function localSet(k, v) { try { if (v === null) localStorage.removeItem(`cv.${k}`); else localStorage.setItem(`cv.${k}`, v); } catch { /* private window */ } }

// Light / Dark / Auto
export function applyTheme(mode = localGet("theme") || "dark") {
  if (mode === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", mode);
}
export function setTheme(mode) { localSet("theme", mode); applyTheme(mode); try { window.CellovisionApp?.themeChanged?.(mode); } catch { /* old app */ } }
// The desktop/phone app's own theme menu sets it here (without telling the app back).
window.CellovisionSetTheme = (mode) => { localSet("theme", mode); applyTheme(mode); };

// The app's pages: #/home, #/shelf/<id>, #/item/<id>… (re-drawn by app.js on change)
export function go(hash) { if (location.hash === hash) window.dispatchEvent(new HashChangeEvent("hashchange")); else location.hash = hash; }
