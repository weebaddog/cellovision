// Secrets at rest: settings like the mail App Password and the TMDB key are stored encrypted
// (AES-256-GCM) in the database, never as plain text.
//
// The key comes from:
//   1. CELLOVISION_SECRET_KEY (base64, 32 bytes): the Windows/Linux app passes it, kept by the
//      operating system's own protection (Windows DPAPI / the Linux keyring, via Electron safeStorage);
//   2. otherwise <data>/secret.key, made on first start and readable only by this user.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const PREFIX = "enc:v1:";

export function loadKey(dataDir) {
  const env = process.env.CELLOVISION_SECRET_KEY;
  if (env) {
    const k = Buffer.from(env, "base64");
    if (k.length !== 32) throw new Error("CELLOVISION_SECRET_KEY must be 32 bytes (base64)");
    return k;
  }
  const file = path.join(dataDir, "secret.key");
  try {
    const k = Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64");
    if (k.length === 32) return k;
  } catch { /* first start */ }
  const k = crypto.randomBytes(32);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, k.toString("base64"), { mode: 0o600 });
  return k;
}

export function createSealer(key) {
  return {
    seal(text) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv("aes-256-gcm", key, iv);
      const ct = Buffer.concat([c.update(String(text), "utf8"), c.final()]);
      return PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
    },
    /** Plain text from seal(); text that was never sealed comes back as it is (older data). */
    open(s) {
      if (typeof s !== "string" || !s.startsWith(PREFIX)) return s;
      const b = Buffer.from(s.slice(PREFIX.length), "base64");
      const d = crypto.createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
      d.setAuthTag(b.subarray(12, 28));
      return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
    },
    isSealed: (s) => typeof s === "string" && s.startsWith(PREFIX),
  };
}
