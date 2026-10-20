// Problem reports: crashes, errors and failed playback from every Cellovision app (and the server
// itself), plus "Report a problem" from people, collected here and emailed to the owner.
//   - The same problem again within an hour is counted, not repeated.
//   - Automatic reports go out together every few minutes; ones people write go at once.
//   - Mail is sent through the owner's own mail account (e.g. Gmail with an App Password), set in
//     the Control Room. Nothing is sent anywhere else.

import tls from "node:tls";
import net from "node:net";
import os from "node:os";
import crypto from "node:crypto";

const BATCH_MS = 5 * 60_000;
const SAME_FOR = 3600_000;

// ---- a tiny mail sender (SMTP) ---------------------------------------------------------------------

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const wrap = (s) => s.replace(/.{1,76}/g, "$&\r\n");
const header = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);

/**
 * Sends one plain-text email. cfg: { host, port (465 = encrypted from the start), user, pass, from?, to, secure? }.
 * (`secure: false` is only for the self-test's pretend mail server.)
 */
export function sendMail(cfg, subject, text) {
  return new Promise((resolve, reject) => {
    const port = cfg.port || 465;
    const sock = cfg.secure === false ? net.connect(port, cfg.host) : tls.connect({ port, host: cfg.host, servername: cfg.host });
    sock.setEncoding("utf8");
    sock.setTimeout(30_000, () => { sock.destroy(); reject(new Error("The mail server didn't answer")); });
    const from = cfg.from || cfg.user;
    const msg = [
      `From: ${header("Cellovision")} <${from}>`, `To: <${cfg.to}>`, `Subject: ${header(subject)}`, `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${crypto.randomBytes(12).toString("hex")}@cellovision>`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64", "", wrap(b64(text)),
    ].join("\r\n");
    // Each step: what to send once the server answers with the expected code.
    const steps = [
      [220, `EHLO ${os.hostname().replace(/[^A-Za-z0-9.-]/g, "") || "cellovision"}`], [250, "AUTH LOGIN"], [334, b64(cfg.user)], [334, b64(cfg.pass)],
      [235, `MAIL FROM:<${from}>`], [250, `RCPT TO:<${cfg.to}>`], [250, "DATA"], [354, `${msg}\r\n.`], [250, "QUIT"],
    ];
    let buf = "", step = 0;
    sock.on("data", (d) => {
      buf += d;
      // A reply is complete at a line "NNN text" (not "NNN-text", which continues).
      let m;
      while ((m = buf.match(/^(\d{3})([ -])(.*)\r?\n/m))) {
        const lineEnd = buf.indexOf("\n", m.index) + 1;
        const line = buf.slice(m.index, lineEnd);
        buf = buf.slice(lineEnd);
        if (m[2] === "-") continue;
        const code = +m[1];
        if (step >= steps.length) { sock.end(); resolve(); return; }
        const [want, send] = steps[step];
        if (code !== want) {
          sock.destroy();
          const hint = code === 535 ? " (wrong address or App Password)" : "";
          reject(new Error(`Mail server said: ${line.trim()}${hint}`));
          return;
        }
        step++;
        sock.write(`${send}\r\n`);
      }
    });
    sock.on("error", (e) => reject(new Error(`Couldn't reach the mail server: ${e.message}`)));
    sock.on("close", () => { if (step >= steps.length) resolve(); });
  });
}

// ---- collecting and sending -----------------------------------------------------------------------

const clip = (s, n) => (s === undefined || s === null ? null : String(s).slice(0, n));

export function createReports({ db, version, log = console.log, send = sendMail }) {
  db.raw.exec(`CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT, first INTEGER NOT NULL, last INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 1,
    sig TEXT NOT NULL, source TEXT, kind TEXT, message TEXT, detail TEXT, device TEXT, profile TEXT, app_version TEXT, sent INTEGER NOT NULL DEFAULT 0)`);
  let timer = null;

  const mailCfg = () => {
    const c = db.setting("mail", null);
    return c && c.to && c.user && c.pass ? c : null;
  };

  function format(rows) {
    return rows.map((r) => [
      `• ${r.kind === "user" ? "Someone reported a problem" : r.kind || "error"} in ${r.source || "?"}${r.count > 1 ? ` (${r.count} times)` : ""}`,
      `  ${r.message}`,
      r.detail ? r.detail.split("\n").slice(0, 25).map((l) => `    ${l}`).join("\n") : null,
      `  ${[r.device, r.profile ? `profile ${r.profile}` : null, r.app_version ? `app ${r.app_version}` : null, new Date(r.last).toLocaleString()].filter(Boolean).join(" · ")}`,
    ].filter(Boolean).join("\n")).join("\n\n");
  }

  /** Emails everything not sent yet. */
  async function flush() {
    timer = null;
    const cfg = mailCfg();
    if (!cfg) return { sent: 0, reason: "Email isn't set up" };
    const rows = db.all("SELECT * FROM reports WHERE sent = 0 ORDER BY id LIMIT 50");
    if (!rows.length) return { sent: 0 };
    const people = rows.filter((r) => r.kind === "user").length;
    const subject = people ? `Cellovision: ${people === 1 ? "a problem was reported" : `${people} problems were reported`}` : `Cellovision: ${rows.length} new ${rows.length === 1 ? "problem" : "problems"}`;
    const server = db.setting("serverName", os.hostname());
    try {
      await send(cfg, subject, `${server} (Cellovision ${version})\n\n${format(rows)}\n\n— Sent by your Cellovision server. Turn these emails off in the Control Room → Problem reports.\n`);
      db.run(`UPDATE reports SET sent = 1 WHERE id IN (${rows.map(() => "?").join(",")})`, ...rows.map((r) => r.id));
      return { sent: rows.length };
    } catch (e) {
      log(`[reports] couldn't email: ${e.message}`);
      db.setSetting("mailError", { at: Date.now(), message: e.message });
      return { sent: 0, reason: e.message };
    }
  }

  return {
    /** Records a problem. now = true sends straight away (people's own reports). */
    add(r, now = false) {
      const row = { source: clip(r.source, 30) || "?", kind: clip(r.kind, 30) || "error", message: clip(r.message, 500) || "(no message)", detail: clip(r.detail, 6000),
        device: clip(r.device, 80), profile: clip(r.profile, 40), app_version: clip(r.version, 30) };
      const sig = crypto.createHash("sha1").update(`${row.source}|${row.kind}|${row.message}`).digest("hex");
      const same = row.kind !== "user" && db.get("SELECT id FROM reports WHERE sig = ? AND last > ? ORDER BY id DESC LIMIT 1", sig, Date.now() - SAME_FOR);
      if (same) db.run("UPDATE reports SET count = count + 1, last = ? WHERE id = ?", Date.now(), same.id);
      else db.run("INSERT INTO reports (first, last, sig, source, kind, message, detail, device, profile, app_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        Date.now(), Date.now(), sig, row.source, row.kind, row.message, row.detail, row.device, row.profile, row.app_version);
      db.run("DELETE FROM reports WHERE id < (SELECT MAX(id) - 1000 FROM reports)");
      if (!mailCfg() || db.setting("mailOff", false)) return;
      if (now) { clearTimeout(timer); timer = null; flush().catch(() => {}); }
      else if (!timer && !same) timer = setTimeout(() => flush().catch(() => {}), BATCH_MS);
    },
    flush,
    list: (limit = 100) => db.all("SELECT id, first, last, count, source, kind, message, detail, device, profile, app_version, sent FROM reports ORDER BY last DESC LIMIT ?", limit),
    /** The mail settings for the Control Room (never the App Password itself). */
    settings() {
      const c = db.setting("mail", null) || {};
      return { to: c.to || "", user: c.user || "", host: c.host || "smtp.gmail.com", port: c.port || 465, hasPass: !!c.pass, off: !!db.setting("mailOff", false), lastError: db.setting("mailError", null) };
    },
    save(b) {
      const c = db.setting("mail", null) || {};
      const next = { ...c };
      for (const k of ["to", "user", "host"]) if (typeof b[k] === "string") next[k] = b[k].trim().slice(0, 200);
      if (b.port) next.port = Math.max(1, Math.min(65535, +b.port || 465));
      if (typeof b.pass === "string" && b.pass) next.pass = b.pass.replace(/\s+/g, ""); // (Google shows App Passwords with spaces)
      if (b.pass === null) delete next.pass;
      for (const k of ["to", "user"]) if (next[k] && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next[k])) throw Object.assign(new Error(`That isn't an email address: ${next[k]}`), { status: 400 });
      db.setSetting("mail", next);
      if ("off" in b) db.setSetting("mailOff", !!b.off);
      db.setSetting("mailError", null);
    },
    async test() {
      const cfg = mailCfg();
      if (!cfg) throw Object.assign(new Error("Fill in your email address, the sending account and its App Password first"), { status: 400 });
      await send(cfg, "Cellovision: test email", `It works: problem reports from ${db.setting("serverName", os.hostname())} will come to this address.\n`);
    },
  };
}
