// HTTPS for the server: its own certificate, made once on first start (a server at home can't get
// one from a public authority). The apps trust it on first use and then accept only that exact
// certificate (they compare its fingerprint), so nobody on the network can pretend to be the server.
// The certificate is built here (a small X.509 writer) so the server still needs no packages.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---- just enough DER (ASN.1) ------------------------------------------------------------------
function len(n) {
  if (n < 0x80) return Buffer.from([n]);
  const b = [];
  for (let x = n; x > 0; x >>= 8) b.unshift(x & 0xff);
  return Buffer.from([0x80 | b.length, ...b]);
}
const der = (tag, ...parts) => { const c = Buffer.concat(parts); return Buffer.concat([Buffer.from([tag]), len(c.length), c]); };
const seq = (...p) => der(0x30, ...p);
const set = (...p) => der(0x31, ...p);
function int(buf) { if (buf[0] & 0x80) buf = Buffer.concat([Buffer.from([0]), buf]); return der(0x02, buf); }
function oid(s) {
  const p = s.split(".").map(Number);
  const out = [40 * p[0] + p[1]];
  for (const v of p.slice(2)) { const b = []; let x = v; b.unshift(x & 0x7f); x >>= 7; while (x > 0) { b.unshift((x & 0x7f) | 0x80); x >>= 7; } out.push(...b); }
  return der(0x06, Buffer.from(out));
}
const utf8 = (s) => der(0x0c, Buffer.from(s, "utf8"));
function utcTime(d) { const p = (n) => String(n).padStart(2, "0"); return der(0x17, Buffer.from(`${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`)); }

/** This computer's own addresses (for the certificate's list of names). */
export function localAddresses() {
  const out = new Set(["127.0.0.1"]);
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === "IPv4" && !a.internal) out.add(a.address);
  return [...out];
}

/** A new self-signed certificate (ECDSA P-256, 10 years) for these names: { cert, key } as PEM. */
export function makeCertificate(name = os.hostname(), ips = localAddresses()) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const sigAlg = seq(oid("1.2.840.10045.4.3.2")); // ecdsa-with-SHA256
  const cn = seq(set(seq(oid("2.5.4.3"), utf8(`${name} Cellovision`.slice(0, 64)))));
  const now = Date.now();
  const dns = [...new Set([name.toLowerCase(), `${name.toLowerCase()}.local`, "localhost"])].filter((n) => /^[a-z0-9.-]+$/.test(n));
  const san = seq(...dns.map((d) => der(0x82, Buffer.from(d))), ...ips.map((ip) => der(0x87, Buffer.from(ip.split(".").map(Number)))));
  const ext = der(0xa3, seq(
    seq(oid("2.5.29.17"), der(0x04, san)),                                   // subjectAltName
    seq(oid("2.5.29.37"), der(0x04, seq(oid("1.3.6.1.5.5.7.3.1")))),       // extKeyUsage: serverAuth
    seq(oid("2.5.29.19"), der(0x01, Buffer.from([0xff])), der(0x04, seq())), // basicConstraints: not a CA (critical)
  ));
  const tbs = seq(
    der(0xa0, int(Buffer.from([2]))),                     // v3
    int(crypto.randomBytes(16)),                          // serial
    sigAlg, cn,
    seq(utcTime(new Date(now - 86400_000)), utcTime(new Date(now + 10 * 365 * 86400_000))),
    cn,
    publicKey.export({ type: "spki", format: "der" }),
    ext,
  );
  const sig = crypto.sign("sha256", tbs, privateKey);     // (DER-encoded ECDSA)
  const certDer = seq(tbs, sigAlg, der(0x03, Buffer.concat([Buffer.from([0]), sig])));
  const pem = `-----BEGIN CERTIFICATE-----\n${certDer.toString("base64").replace(/.{1,64}/g, "$&\n")}-----END CERTIFICATE-----\n`;
  return { cert: pem, key: privateKey.export({ type: "pkcs8", format: "pem" }) };
}

/** "sha256/<base64>" of the certificate: the same form Electron and the apps compare. */
export function fingerprint(certPem) {
  return "sha256/" + crypto.createHash("sha256").update(new crypto.X509Certificate(certPem).raw).digest("base64");
}

/** The server's certificate, made on first start and kept in <data>/tls/. */
export function loadCertificate(dataDir) {
  const dir = path.join(dataDir, "tls");
  const certFile = path.join(dir, "cert.pem"), keyFile = path.join(dir, "key.pem");
  try {
    const cert = fs.readFileSync(certFile, "utf8"), key = fs.readFileSync(keyFile, "utf8");
    new crypto.X509Certificate(cert); // (still readable)
    return { cert, key, fingerprint: fingerprint(cert) };
  } catch { /* make one */ }
  const c = makeCertificate();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(keyFile, c.key, { mode: 0o600 });
  fs.writeFileSync(certFile, c.cert);
  return { ...c, fingerprint: fingerprint(c.cert) };
}
