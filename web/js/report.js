// Problem reports from this app: errors are sent to the server automatically (it emails the owner),
// and anyone can describe a glitch with "Report a problem".

import { h, api, sheet, toast, state } from "./core.js";

const APP = window.CellovisionApp?.isTV ? "android" : window.CellovisionApp ? "desktop" : "web";
const seen = new Set();

function device() {
  const u = navigator.userAgent;
  return [APP === "android" ? (window.CellovisionApp.isTV?.() ? "Android TV" : "Android") : APP === "desktop" ? "Cellovision desktop" : "Browser",
    /Windows/.test(u) ? "Windows" : /Android/.test(u) ? "" : /iPhone|iPad/.test(u) ? "iOS" : /Mac/.test(u) ? "Mac" : /Linux/.test(u) ? "Linux" : ""].filter(Boolean).join(" · ");
}

/** Sends one problem (never throws; repeats of the same one in this visit are skipped). */
export function report(kind, message, detail = null) {
  const key = `${kind}|${message}`;
  if (kind !== "user" && seen.has(key)) return Promise.resolve();
  seen.add(key);
  return fetch("/api/report", { method: "POST", headers: { "content-type": "application/json", "x-cellovision": "1" }, credentials: "same-origin",
    body: JSON.stringify({ source: APP, kind, message: String(message).slice(0, 500), detail: detail ? String(detail).slice(0, 6000) : `${location.hash}\n${navigator.userAgent}`, device: device(), version: state.server?.version || null }) })
    .catch(() => {});
}

export function watchForErrors() {
  window.addEventListener("error", (e) => {
    if (!e.message || /ResizeObserver loop/.test(e.message)) return;
    report("app error", e.message, `${e.filename || ""}:${e.lineno || ""}:${e.colno || ""}\n${e.error?.stack || ""}\n${location.hash}`);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    if (r?.status === 401 || r?.name === "AbortError" || /Failed to fetch|NetworkError|Load failed/.test(String(r?.message))) return; // (signed out / offline: not a bug)
    report("app error", r?.message || String(r), `${r?.stack || ""}\n${location.hash}`);
  });
}

/** "Report a problem": what went wrong, in the person's own words. */
export function reportSheet() {
  sheet("Report a problem", (b, close) => {
    const what = h("textarea", { placeholder: "What happened? What were you doing? (e.g. “The Office S2E3 stops after 10 minutes on the TV”)", rows: "5" });
    b.append(h("p", { class: "muted" }, "Your report goes to whoever runs this server, with the page you're on and this device's type. Nothing else."),
      what, h("div", { class: "btns" }, h("button", { class: "btn primary", onclick: async () => {
        if (!what.value.trim()) { what.focus(); return; }
        await report("user", what.value.trim(), `${location.hash}\n${navigator.userAgent}`);
        close(); toast("Thanks, your report was sent.");
      } }, "Send report")));
    setTimeout(() => what.focus(), 50);
  });
}
