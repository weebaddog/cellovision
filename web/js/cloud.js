// Sign in with CelloCloud: the server's CelloCloud account (Control Room), the lock page shown when
// the plan doesn't include Cellovision, and the warning banner after a failed payment.
// The password goes to this Cellovision server only, which turns it into CelloCloud's auth key and
// forgets it (see server/src/cloud.js); it is never saved here either.

import { h, api, toast, confirmBox } from "./core.js";

const HOME = "https://cellosig.com";
const day = (t) => new Date(t).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
const when = (t) => (t ? new Date(t).toLocaleString() : "never");

/** "Your payment didn't go through…" while a failed payment hasn't locked the app yet. */
export function paymentBanner(lockAt) {
  if (!lockAt || lockAt <= Date.now()) return null;
  return h("div", { class: "cloud-banner", role: "alert" },
    h("span", {}, "⚠ "), `Your CelloCloud payment didn't go through. Update your card on cellosig.com by ${day(lockAt)} or Cellovision locks.`,
    " ", h("a", { href: HOME, target: "_blank", rel: "noopener" }, "Open cellosig.com"));
}

/**
 * The CelloCloud account box (admins): a sign-in form, or who's signed in with Check again / Sign out.
 * changed(info) is called after anything changes.
 */
export function cloudSection(info, changed) {
  const box = h("div", { class: "panel" });
  const draw = (c) => box.replaceChildren(...(c.signedIn ? account(c) : signInForm(c)).filter(Boolean));

  function signInForm(c) {
    const user = h("input", { type: "text", placeholder: "Your CelloCloud username", autocomplete: "username", autocapitalize: "none", spellcheck: "false" });
    const pass = h("input", { type: "password", placeholder: "Your CelloCloud password", autocomplete: "current-password" });
    const code = h("input", { type: "text", inputmode: "numeric", placeholder: "6-digit code", autocomplete: "one-time-code", maxlength: "7" });
    const codeRow = h("label", { class: "field hidden" }, h("span", {}, "Two-step code"), code);
    const err = h("p", { class: "muted", role: "alert" });
    const btn = h("button", { class: "btn primary", type: "submit" }, "Sign in with CelloCloud");
    const form = h("form", { onsubmit: async (e) => {
      e.preventDefault(); err.textContent = ""; btn.disabled = true; btn.textContent = "Signing in… (a few seconds)";
      try {
        const r = await api("POST", "/api/cloud/login", { username: user.value, password: pass.value, ...(code.value ? { totp: code.value } : {}) });
        pass.value = ""; code.value = "";
        toast(r.locked ? "Signed in, but the plan doesn't include Cellovision" : "Signed in with CelloCloud");
        draw(r); changed?.(r);
      } catch (x) {
        err.textContent = x.message;
        if (x.data?.code === "totp_required" || x.data?.code === "wrong_code") { codeRow.classList.remove("hidden"); code.focus(); }
      } finally { btn.disabled = false; btn.textContent = "Sign in with CelloCloud"; }
    } },
      h("label", { class: "field" }, h("span", {}, "CelloCloud username"), user),
      h("label", { class: "field" }, h("span", {}, "CelloCloud password"), pass),
      codeRow, err, h("div", { class: "btns" }, btn));
    setTimeout(() => user.focus(), 0);
    return [
      h("p", { class: "muted" }, "Cellovision comes with CelloCloud's 700 GB plan. Sign this server in with your CelloCloud account; everyone who watches from this server is covered by it."),
      c.reason === "signed_out" && c.message && /ended/.test(c.message) ? h("p", { style: { color: "var(--bad)" } }, c.message) : null,
      form,
      h("p", { class: "muted small" }, "Your password is turned into a sign-in key on this server and then forgotten; it's never saved. No account yet? ", h("a", { href: HOME, target: "_blank", rel: "noopener" }, "cellosig.com")),
    ];
  }

  function account(c) {
    const state = c.locked ? h("p", { style: { color: "var(--bad)", fontWeight: "600" } }, `Locked: ${c.message}`)
      : c.lockAt ? h("p", { style: { color: "var(--warn, #d9a400)", fontWeight: "600" } }, `A payment didn't go through: Cellovision locks on ${day(c.lockAt)} unless the card is updated on cellosig.com.`)
        : h("p", { style: { fontWeight: "600" } }, `✓ ${c.appName || "Cellovision"} is in your plan.`);
    return [
      h("div", { class: "li" }, h("span", { style: { fontSize: "22px" } }, "☁"),
        h("div", { class: "grow" }, h("div", { style: { fontWeight: "700" } }, c.username), h("div", { class: "muted small" }, [c.plan ? `Plan ${c.plan}` : null, `this server: ${c.device}`].filter(Boolean).join(" · ")))),
      state,
      h("p", { class: "muted small" }, `Last answer from CelloCloud: ${when(c.checkedAt)}${c.lastError ? ` · last try failed: ${c.lastError}` : ""}`),
      h("div", { class: "btns" },
        h("button", { class: "btn", onclick: async (e) => {
          e.target.disabled = true;
          try { const r = await api("POST", "/api/cloud/check"); draw(r); changed?.(r); toast(r.locked ? "Still locked" : "Checked: all good"); } catch (x) { toast(x.message, true); }
          e.target.disabled = false;
        } }, "Check again"),
        h("a", { class: "btn", href: HOME, target: "_blank", rel: "noopener" }, "Open cellosig.com"),
        h("button", { class: "btn danger", onclick: () => confirmBox("Sign out of CelloCloud?", "Cellovision on this server locks until someone signs in with a CelloCloud account again.", "Sign out", async () => {
          try { const r = await api("POST", "/api/cloud/logout"); draw(r); changed?.(r); } catch (x) { toast(x.message, true); }
        }) }, "Sign out / use another account")),
    ];
  }

  draw(info);
  return box;
}

/**
 * The full-screen lock. lock: the server's answer ({ message, reason, signedIn }). Admins get the
 * CelloCloud account box (sign in, Check again, sign out); everyone else is told to ask the owner.
 */
export async function lockPage(app, { lock, me, serverName, unlocked, switchProfile }) {
  let info = null;
  if (me?.admin) { try { info = await api("GET", "/api/cloud"); } catch { info = null; } }
  const signIn = me?.admin && info && !info.signedIn;
  const title = signIn ? "Sign in with CelloCloud" : "Cellovision is locked";
  const after = (r) => { if (!r.locked) unlocked(); else msg.textContent = r.message; };
  const msg = h("p", {}, signIn ? "Before anything plays, this server needs your CelloCloud account." : lock.message);
  app.replaceChildren(h("div", { class: "signin lock" },
    h("img", { class: "logo", src: "icon.svg", alt: "" }),
    h("h1", {}, title), msg,
    me?.admin && info ? cloudSection(info, after)
      : h("div", {},
        h("p", { class: "muted" }, "The owner of this server can fix this in the Control Room. Once they have, press Check again."),
        h("div", { class: "btns", style: { justifyContent: "center" } },
          h("button", { class: "btn primary", onclick: async () => {
            try { const s = await api("GET", "/api/hello"); if (!s.cloud?.locked) unlocked(); else { msg.textContent = s.cloud.message; toast("Still locked"); } } catch (x) { toast(x.message, true); }
          } }, "Check again"),
          h("a", { class: "btn", href: HOME, target: "_blank", rel: "noopener" }, "cellosig.com"))),
    h("p", { class: "muted small", style: { marginTop: "18px" } }, serverName,
      me ? [" · ", h("a", { href: "#", onclick: (e) => { e.preventDefault(); switchProfile(); } }, `${me.name}: switch profile`)] : null)));
}
