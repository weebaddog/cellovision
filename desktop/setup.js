const app = window.CellovisionApp;
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
$("error").textContent = params.get("error") || "";

let busy = false;
function setBusy(text) { busy = !!text; $("status").textContent = text || ""; for (const id of ["connect", "find", "server"]) $(id).disabled = busy; }

async function connect(address) {
  if (busy) return;
  $("error").textContent = "";
  setBusy(`Connecting to ${address}…`);
  const r = await app.connect(address).catch((e) => ({ error: e.message }));
  setBusy("");
  if (r.error) $("error").textContent = r.error;
}
$("form").addEventListener("submit", (e) => { e.preventDefault(); connect($("address").value); });

$("find").addEventListener("click", async () => {
  $("error").textContent = "";
  setBusy("Looking for Cellovision servers on this network… (a few seconds)");
  const { found, nets } = await app.find();
  setBusy("");
  const box = $("found");
  box.replaceChildren();
  if (!found.length) { $("error").textContent = `No server answered on ${nets.length ? nets.map((n) => `${n}.x`).join(" or ") : "this network"}.`; return; }
  for (const f of found) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "server";
    b.innerHTML = "<strong></strong><span></span>";
    b.querySelector("strong").textContent = f.name; b.querySelector("span").textContent = f.local ? "on this computer" : f.url.replace(/^https?:\/\//, "");
    b.addEventListener("click", () => connect(f.url));
    box.append(b);
  }
});

$("server").addEventListener("click", async () => {
  const s = await app.state();
  if (s.runServer && s.serverState.running) { await app.beServer(false); draw(); return; }
  $("error").textContent = "";
  setBusy("Starting the server…");
  const r = await app.beServer(true);
  setBusy("");
  if (r.error) $("error").textContent = r.error;
  draw();
});
app.onServerState((s) => {
  const m = $("progress");
  if (s.progress !== null && s.progress !== undefined) { m.classList.remove("hidden"); m.firstElementChild.style.width = `${Math.round(s.progress * 100)}%`; $("status").textContent = `Getting FFmpeg… ${Math.round(s.progress * 100)}%`; }
  else m.classList.add("hidden");
  if (s.error) $("error").textContent = s.error;
});

async function draw() {
  const s = await app.state();
  $("server").textContent = s.runServer && s.serverState.running ? "Stop the server on this computer" : "Run the server here";
  $("address").value = $("address").value || (s.server || "").replace(/^http:\/\//, "").replace(/:8420$/, "");
  document.querySelectorAll("[data-theme]").forEach((b) => b.classList.toggle("on", b.dataset.theme === s.theme));
}
document.querySelectorAll("[data-theme]").forEach((b) => b.addEventListener("click", () => { app.themeChanged(b.dataset.theme); setTimeout(draw, 50); }));
draw();
