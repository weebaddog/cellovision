// Profiles, signing in, and Pair Code.
//   - A profile may have a password (or none, for a home without strangers).
//   - Signing in gives a device a token (kept as a hash on the server).
//   - Pair Code: a TV asks for a 6-character code, shows it; you approve it from a signed-in phone or
//     computer, and the TV is signed in as you without typing a password on a remote.

import crypto from "node:crypto";

const hash = (t) => crypto.createHash("sha256").update(t).digest("hex");
const PAIR_TTL = 10 * 60_000;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString("hex")}$${crypto.scryptSync(String(pw), salt, 32, { N: 16384, r: 8, p: 1 }).toString("hex")}`;
}
export function checkPassword(pw, stored) {
  if (!stored) return pw === "" || pw === undefined || pw === null; // no password set
  const [, salt, h] = stored.split("$");
  const got = crypto.scryptSync(String(pw ?? ""), Buffer.from(salt, "hex"), 32, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(got, Buffer.from(h, "hex"));
}

export function createAuth(db) {
  const pairs = new Map(); // code → { secret, device, client, created, profileId }
  const failures = new Map();

  function newSession(profileId, device, client) {
    const token = crypto.randomBytes(32).toString("base64url");
    db.run("INSERT INTO sessions (token_hash, profile_id, device, client, created, last_seen) VALUES (?, ?, ?, ?, ?, ?)",
      hash(token), profileId, String(device || "").slice(0, 60), String(client || "").slice(0, 40), Date.now(), Date.now());
    return token;
  }

  return {
    profiles: () => db.all("SELECT id, name, admin, max_age, shelves, pass_hash IS NOT NULL AS has_password FROM profiles ORDER BY name"),
    count: () => db.get("SELECT COUNT(*) AS n FROM profiles").n,

    create({ name, password = null, admin = false, maxAge = null, shelves = null }) {
      const n = String(name || "").trim().slice(0, 40);
      if (!n) throw Object.assign(new Error("Give the profile a name"), { status: 400 });
      if (db.get("SELECT 1 FROM profiles WHERE name = ?", n)) throw Object.assign(new Error("That name is taken"), { status: 409 });
      const id = crypto.randomBytes(8).toString("hex");
      db.run("INSERT INTO profiles (id, name, pass_hash, admin, max_age, shelves, created) VALUES (?, ?, ?, ?, ?, ?, ?)",
        id, n, password ? hashPassword(password) : null, admin ? 1 : 0, maxAge ?? null, shelves ? JSON.stringify(shelves) : null, Date.now());
      return id;
    },

    signIn(name, password, device, client, ip) {
      const list = (failures.get(ip) || []).filter((t) => Date.now() - t < 15 * 60_000);
      if (list.length >= 10) throw Object.assign(new Error("Too many tries; wait 15 minutes"), { status: 429 });
      const p = db.get("SELECT id, pass_hash FROM profiles WHERE name = ?", String(name || ""));
      if (!p || !checkPassword(password, p.pass_hash)) { list.push(Date.now()); failures.set(ip, list); throw Object.assign(new Error("Wrong name or password"), { status: 403 }); }
      return newSession(p.id, device, client);
    },

    /** The profile behind a token (and notes the device was seen), or null. */
    who(token) {
      if (!token) return null;
      const s = db.get(`SELECT p.id, p.name, p.admin, p.max_age, p.shelves, s.token_hash, s.device, s.client FROM sessions s JOIN profiles p ON p.id = s.profile_id WHERE s.token_hash = ?`, hash(token));
      if (!s) return null;
      db.run("UPDATE sessions SET last_seen = ? WHERE token_hash = ?", Date.now(), s.token_hash);
      return { ...s, admin: !!s.admin, shelves: s.shelves ? JSON.parse(s.shelves) : null };
    },
    signOut(token) { db.run("DELETE FROM sessions WHERE token_hash = ?", hash(token)); },

    // ---- Pair Code ------------------------------------------------------------------------------
    pairStart(device, client) {
      for (const [c, p] of pairs) if (Date.now() - p.created > PAIR_TTL) pairs.delete(c);
      if (pairs.size > 50) throw Object.assign(new Error("Too many codes waiting"), { status: 429 });
      const code = Array.from(crypto.randomBytes(6), (b) => ALPHABET[b % 32]).join("");
      const secret = crypto.randomBytes(24).toString("base64url");
      pairs.set(code, { secret, device, client, created: Date.now(), profileId: null });
      return { code, secret, expires: Date.now() + PAIR_TTL };
    },
    /** A signed-in profile approves the code shown on the TV. */
    pairApprove(code, profileId) {
      const p = pairs.get(String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, ""));
      if (!p || Date.now() - p.created > PAIR_TTL) throw Object.assign(new Error("That code isn't valid (or ran out). Get a new one on the TV."), { status: 404 });
      p.profileId = profileId;
      return { device: p.device };
    },
    /** The TV asks (with its secret) whether its code was approved: a token once it is. */
    pairCheck(code, secret) {
      const p = pairs.get(code);
      if (!p || p.secret !== secret || Date.now() - p.created > PAIR_TTL) throw Object.assign(new Error("Code ran out"), { status: 410 });
      if (!p.profileId) return { approved: false };
      pairs.delete(code);
      return { approved: true, token: newSession(p.profileId, p.device, p.client) };
    },

    devices: (profileId) => db.all("SELECT token_hash AS id, device, client, created, last_seen FROM sessions WHERE profile_id = ? ORDER BY last_seen DESC", profileId),
    forgetDevice: (profileId, id) => db.run("DELETE FROM sessions WHERE profile_id = ? AND token_hash = ?", profileId, id),
  };
}
