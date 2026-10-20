// A small pretend CelloCloud server (just the app sign-in API from cellocloud/APP-SIGNIN.md), for the
// self-test and the demo. Accounts: { username: { password, totp? } }. Change `fake.access` to make
// the plan answer change, and `fake.offline = true` to make it unreachable (connections are dropped).

import http from "node:http";
import crypto from "node:crypto";
import { authKeyFor } from "../src/cloud.js";

export async function startFakeCloud({ accounts = { carol: { password: "carol's long password" } }, port = 0 } = {}) {
  const salts = {};
  const keys = {};
  for (const [u, a] of Object.entries(accounts)) { salts[u] = crypto.randomBytes(16).toString("hex"); keys[u] = await authKeyFor(a.password, salts[u]); }
  const tokens = new Map(); // token → username
  const fake = {
    url: "", offline: false, logins: [], logouts: 0,
    access: { allowed: true, reason: "ok", message: null, lockAt: null },
    tokens,
  };
  const answer = (u) => ({ app: "cellovision", appName: "Cellovision", plan: "plus700", username: u, checked: Date.now(), ...fake.access });
  const server = http.createServer(async (req, res) => {
    if (fake.offline) return req.socket.destroy();
    const url = new URL(req.url, "http://x");
    const send = (status, data) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    let body = "";
    for await (const c of req) body += c;
    const b = body ? JSON.parse(body) : {};
    const bearer = String(req.headers.authorization || "").replace(/^Bearer /, "");
    if (req.method === "POST" && req.headers["x-cellocloud"] !== "1") return send(403, { error: "forbidden" });
    if (req.method === "GET" && url.pathname === "/api/salt") {
      const u = url.searchParams.get("u");
      return send(200, { salt: salts[u] || crypto.createHash("sha256").update(`fake:${u}`).digest("hex").slice(0, 32) });
    }
    if (req.method === "POST" && url.pathname === "/api/apps/login") {
      fake.logins.push({ ...b });
      const a = accounts[b.username];
      if (b.app !== "cellovision") return send(400, { error: "bad_app" });
      if (!a || b.authKey !== keys[b.username]) return send(401, { error: "wrong_login" });
      if (a.totp && !b.totp) return send(401, { error: "totp_required" });
      if (a.totp && b.totp !== a.totp) return send(401, { error: "wrong_code" });
      const token = `ca_${crypto.randomBytes(18).toString("hex")}`;
      tokens.set(token, b.username);
      return send(200, { token, ...answer(b.username) });
    }
    if (req.method === "GET" && url.pathname === "/api/apps/access") {
      const u = tokens.get(bearer);
      return u ? send(200, answer(u)) : send(401, { error: "signed_out" });
    }
    if (req.method === "POST" && url.pathname === "/api/apps/logout") { tokens.delete(bearer); fake.logouts++; return send(200, { ok: true }); }
    send(404, { error: "not_found" });
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  fake.url = `http://127.0.0.1:${server.address().port}`;
  fake.close = () => { server.close(); server.closeAllConnections?.(); };
  return fake;
}
