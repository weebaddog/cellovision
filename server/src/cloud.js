// Sign in with CelloCloud: Cellovision comes with CelloCloud's 700 GB plan, so this server signs in
// with the owner's CelloCloud account (one per server) and asks CelloCloud whether the plan still
// includes Cellovision. When it doesn't (not in the plan, a payment failed and wasn't fixed, …) the
// server locks: every library and media request is refused (423), so every app shows the lock.
//
// The contract is cellocloud/APP-SIGNIN.md:
//   - The password never leaves this computer: PBKDF2-SHA256(NFKC password, salt, 600 000) → 64 bytes;
//     only bytes 32..63 (the auth key) are sent. Bytes 0..31 unlock the customer's files: wiped at once.
//     Neither the password nor that key is ever stored or logged.
//   - The token (ca_…) can only ask about the plan; it is still stored sealed (secrets.js).
//   - Ask at start, every 6 hours, and on "Check again". Offline: go by the last answer, but lock if
//     its lockAt has passed or there has been no answer for 14 days. Never lock for one failed check.
//   - Try https://cellosig.com first; if it can't be reached, http://127.0.0.1:8790 (the CelloCloud
//     server on the owner's PC; elsewhere nothing answers there).

import crypto from "node:crypto";
import os from "node:os";

export const APP_ID = "cellovision";
export const DEFAULT_BASES = ["https://cellosig.com", "http://127.0.0.1:8790"];
const ROUNDS = 600_000;
const EVERY = 6 * 3600_000;          // a normal check
const RETRY = 15 * 60_000;           // after a check that couldn't reach CelloCloud
const OFFLINE_LIMIT = 14 * 86400_000;
const USERNAME = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const HOME = "https://cellosig.com";

const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, extra });

/** The auth key for a password (lowercase hex of PBKDF2 bytes 32..63). The other half is wiped. */
export async function authKeyFor(password, saltHex) {
  if (!/^[0-9a-f]{32}$/i.test(String(saltHex))) throw new Error("Bad salt from CelloCloud");
  const bits = await new Promise((ok, bad) => crypto.pbkdf2(Buffer.from(String(password).normalize("NFKC"), "utf8"), Buffer.from(saltHex, "hex"), ROUNDS, 64, "sha256", (e, k) => (e ? bad(e) : ok(k))));
  const authKey = bits.subarray(32).toString("hex");
  bits.fill(0);
  return authKey;
}

const SIGN_IN_ERRORS = {
  wrong_login: [400, "Wrong CelloCloud username or password."],
  totp_required: [400, "Type the 6-digit two-step code from your authenticator app."],
  wrong_code: [400, "That two-step code didn't work. Try the newest one."],
  rate_limited: [429, "Too many sign-in tries. Wait a few minutes and try again."],
  signins_paused: [429, "Sign-ins are paused for a little while. Try again in a few minutes."],
  paused_signins: [423, "Sign-ins to this CelloCloud account are paused. Turn them back on at cellosig.com (Settings), then try again."],
};

const ACCESS_FIELDS = ["allowed", "reason", "message", "lockAt", "app", "appName", "plan", "username", "checked"];
const accessOf = (r) => Object.fromEntries(ACCESS_FIELDS.filter((k) => k in r).map((k) => [k, r[k]]));

/**
 * db: settings "cloud" (plain: username, device, last answer, when) and "cloudToken" (sealed).
 * bases: where CelloCloud is, in order. fetchImpl/now: for tests.
 */
export function createCloud({ db, bases = DEFAULT_BASES, fetchImpl = fetch, now = Date.now, log = console.log, device = os.hostname() }) {
  let timer = null;
  let checking = null;

  const saved = () => db.setting("cloud", null);
  const save = (s) => db.setSetting("cloud", s);
  const token = () => db.setting("cloudToken", null);

  /** Asks CelloCloud: the first address that can be reached answers. Returns { status, data }. */
  async function ask(method, path, { body, bearer } = {}) {
    let lastErr = null;
    for (const base of bases) {
      let r;
      try {
        r = await fetchImpl(base + path, {
          method,
          headers: { accept: "application/json", ...(body ? { "content-type": "application/json", "x-cellocloud": "1" } : method === "POST" ? { "x-cellocloud": "1" } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(15_000),
        });
      } catch (e) { lastErr = e; continue; } // can't reach this one: try the next
      const data = await r.json().catch(() => ({}));
      return { status: r.status, data };
    }
    throw Object.assign(new Error(`Can't reach CelloCloud (${lastErr?.cause?.code || lastErr?.message || "offline"})`), { offline: true });
  }

  /** What the apps are told: locked or not, why, and the warning date. */
  function status() {
    const s = saved();
    if (!s || !token()) {
      return { signedIn: false, locked: true, reason: "signed_out", lockAt: null,
        message: s?.signedOutBy === "cellocloud"
          ? "This server's CelloCloud sign-in ended (signed out from CelloCloud, or the password changed). The server's owner needs to sign in again in the Control Room."
          : "This Cellovision server needs its owner to sign in with a CelloCloud account first (Control Room → CelloCloud account)." };
    }
    const a = s.access || {};
    const t = now();
    const base = { signedIn: true, lockAt: a.lockAt || null };
    if (!a.allowed) return { ...base, locked: true, reason: a.reason || "not_allowed", message: a.message || "Your CelloCloud plan doesn't include Cellovision right now." };
    if (a.lockAt && t >= a.lockAt) return { ...base, locked: true, reason: "payment_failed", message: "Your CelloCloud payment didn't go through and wasn't fixed in time, so Cellovision is locked. Update your card on cellosig.com, then press Check again." };
    if (!s.fetchedAt || t - s.fetchedAt > OFFLINE_LIMIT) return { ...base, locked: true, reason: "offline", message: "Connect to the internet so Cellovision can check your CelloCloud plan." };
    return { ...base, locked: false, reason: "ok", message: null };
  }

  /** For the Control Room (admins). */
  function info() {
    const s = saved() || {};
    return { ...status(), username: s.username || null, device: s.device || device, plan: s.access?.plan || null, appName: s.access?.appName || null,
      checkedAt: s.fetchedAt || null, lastTry: s.lastTry || null, lastError: s.lastError || null, home: HOME };
  }

  /** Asks CelloCloud now (once at a time). Never throws; the answer is kept for offline use. */
  function check() {
    if (checking) return checking;
    checking = (async () => {
      const t = token();
      const s = saved();
      if (!t || !s) return status();
      s.lastTry = now();
      try {
        const r = await ask("GET", "/api/apps/access", { bearer: t });
        if (r.status === 200 && typeof r.data.allowed === "boolean") {
          s.access = accessOf(r.data); s.fetchedAt = now(); s.lastError = null;
          if (r.data.username) s.username = r.data.username;
        } else if (r.status === 401) {
          // Signed out from CelloCloud (Settings), password changed, or 90 days unused.
          db.setSetting("cloudToken", null);
          s.access = null; s.signedOutBy = "cellocloud"; s.lastError = null;
          log("[cloud] CelloCloud ended this server's sign-in");
        } else s.lastError = `CelloCloud answered ${r.status}${r.data?.error ? ` (${r.data.error})` : ""}`;
      } catch (e) { s.lastError = e.message; }
      save(s);
      return status();
    })().finally(() => { checking = null; });
    return checking;
  }

  return {
    status, info, check,

    /** Signs this server in with a CelloCloud account. Only the auth key goes over the network. */
    async signIn({ username, password, totp } = {}) {
      const u = String(username || "").trim().toLowerCase();
      if (!USERNAME.test(u)) throw fail(400, "Type your CelloCloud username (3 to 32 letters, numbers, dots, dashes or underscores).");
      if (typeof password !== "string" || !password) throw fail(400, "Type your CelloCloud password.");
      const code = totp ? String(totp).replace(/\s+/g, "") : undefined;
      if (code !== undefined && !/^\d{6}$/.test(code)) throw fail(400, "The two-step code is 6 numbers.", { code: "totp_required" });
      let r;
      try {
        const salt = await ask("GET", `/api/salt?u=${encodeURIComponent(u)}`);
        if (salt.status !== 200 || !salt.data.salt) throw fail(502, `CelloCloud couldn't start the sign-in (${salt.data.error || salt.status}).`);
        const authKey = await authKeyFor(password, salt.data.salt);
        r = await ask("POST", "/api/apps/login", { body: { username: u, authKey, app: APP_ID, device: String(device).slice(0, 60), ...(code ? { totp: code } : {}) } });
      } catch (e) {
        if (e.offline) throw fail(503, "Can't reach CelloCloud (cellosig.com). Check this computer's internet connection and try again.");
        throw e;
      }
      if (r.status !== 200 || !r.data.token) {
        const known = SIGN_IN_ERRORS[r.data.error];
        if (known) throw fail(known[0], known[1], { code: r.data.error });
        throw fail(502, `CelloCloud didn't sign in (${r.data.error || r.status}).`);
      }
      // Signed in: forget any old sign-in, keep the token sealed and the answer for offline use.
      const old = token();
      if (old && old !== r.data.token) ask("POST", "/api/apps/logout", { bearer: old }).catch(() => {});
      db.setSetting("cloudToken", r.data.token);
      save({ username: r.data.username || u, device: String(device).slice(0, 60), access: accessOf(r.data), fetchedAt: now(), lastTry: now(), lastError: null });
      log(`[cloud] signed in to CelloCloud as ${r.data.username || u}`);
      return info();
    },

    /** Signs this server out (it locks until someone signs in again). */
    async signOut() {
      const t = token();
      if (t) await ask("POST", "/api/apps/logout", { bearer: t }).catch(() => {});
      db.setSetting("cloudToken", null);
      db.setSetting("cloud", null);
      return info();
    },

    /** Checks at start, then every 6 hours (sooner again after a check that couldn't get through). */
    start() {
      check();
      timer = setInterval(() => {
        const s = saved();
        if (!s || !token()) return;
        const since = now() - (s.lastTry || 0);
        if (since >= EVERY || (s.lastError && since >= RETRY)) check();
      }, 60_000);
      timer.unref?.();
    },
    stop() { clearInterval(timer); timer = null; },
  };
}
