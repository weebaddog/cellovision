// A demo server with made-up media, for trying the apps: http://localhost:8421
// Profiles: "Demo" (admin, password demo-pass) and "Kid" (no password, Age Limit 10).
//   node test/demo.js

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "../src/main.js";
import { FF, run } from "../src/probe.js";
import { startFakeCloud } from "./fake-cellocloud.js";

process.removeAllListeners("warning");
const root = path.join(os.tmpdir(), "cellovision-demo");
const media = path.join(root, "media");
const mk = (p) => { fs.mkdirSync(path.dirname(p), { recursive: true }); return p; };
const ff = (args) => run(FF.ffmpeg, ["-v", "error", "-y", ...args], { timeout: 300_000 });
// A test-pattern clip with a label: inputs first, then (optional) more inputs, then the label filter.
const clip = (secs, size, label, color, moreInputs = []) => ["-f", "lavfi", "-i", `testsrc2=size=${size}:rate=25:duration=${secs}`, "-f", "lavfi", "-i", `sine=frequency=330:duration=${secs}`, ...moreInputs,
  "-vf", `drawbox=c=${color}@0.35:t=fill,drawtext=text='${label}':fontcolor=white:fontsize=h/9:x=(w-tw)/2:y=h*0.7:box=1:boxcolor=black@0.5`];

if (!fs.existsSync(path.join(root, ".made"))) {
  console.log("making demo media (once)…");
  const M = path.join(media, "Movies"), S = path.join(media, "Shows"), MU = path.join(media, "Music"), P = path.join(media, "Photos");
  const films = [["Night Harbor", 2019, "PG-13", "A lighthouse keeper finds a message that changes the town.", ["Mystery", "Drama"], "steelblue"],
    ["Paper Rockets", 2021, "PG", "Two kids build a rocket out of everything in the garage.", ["Family", "Comedy"], "orange"],
    ["The Long Signal", 2017, "R", "A radio operator hears a voice from twenty years ago.", ["Sci-Fi", "Thriller"], "purple"],
    ["Quiet Field", 2023, "G", "A year in a meadow, season by season.", ["Documentary"], "green"]];
  for (const [t, y, r, plot, genres, c] of films) {
    const dir = path.join(M, `${t} (${y})`);
    await ff([...clip(180, "640x360", t, c), "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-movflags", "+faststart", mk(path.join(dir, `${t.replace(/ /g, ".")}.${y}.1080p.mp4`))]);
    fs.writeFileSync(path.join(dir, "movie.nfo"), `<movie><title>${t}</title><plot>${plot}</plot><year>${y}</year><mpaa>${r}</mpaa>${genres.map((g) => `<genre>${g}</genre>`).join("")}<rating>${(6 + Math.random() * 3).toFixed(1)}</rating></movie>`);
    await ff(["-f", "lavfi", "-i", `gradients=size=400x600:c0=${c}:c1=black:duration=1`, "-vf", `drawtext=text='${t}':fontcolor=white:fontsize=34:x=(w-tw)/2:y=h*0.75`, "-frames:v", "1", mk(path.join(dir, "poster.jpg"))]);
    await ff(["-f", "lavfi", "-i", `gradients=size=1280x720:c0=black:c1=${c}:duration=1`, "-frames:v", "1", mk(path.join(dir, "fanart.jpg"))]);
  }
  // One that needs converting (HEVC + AC-3 + subtitles inside).
  fs.writeFileSync(path.join(root, "s.srt"), "1\n00:00:02,000 --> 00:00:06,000\nThese words are inside the file.\n");
  await ff([...clip(120, "1280x720", "Deep Blue (HEVC)", "navy", ["-i", path.join(root, "s.srt")]), "-map", "0:v", "-map", "1:a", "-map", "2:s", "-c:v", "libx265", "-preset", "ultrafast", "-x265-params", "log-level=error", "-c:a", "ac3", "-c:s", "srt", "-metadata:s:s:0", "language=eng",
    mk(path.join(M, "Deep Blue (2024)", "deep.blue.2024.2160p.hevc.mkv"))]);
  for (const s of [1, 2]) for (const e of [1, 2, 3]) await ff([...clip(90, "640x360", `S0${s}E0${e}`, s === 1 ? "teal" : "maroon"), "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", mk(path.join(S, "Backyard Detectives (2020)", `Season 0${s}`, `Backyard.Detectives.S0${s}E0${e}.mkv`))]);
  fs.writeFileSync(path.join(S, "Backyard Detectives (2020)", "tvshow.nfo"), "<tvshow><title>Backyard Detectives</title><plot>Three neighbours solve the small mysteries of their street.</plot><mpaa>TV-PG</mpaa><genre>Family</genre><genre>Mystery</genre></tvshow>");
  await ff(["-f", "lavfi", "-i", "gradients=size=400x600:c0=teal:c1=black:duration=1", "-vf", "drawtext=text='Backyard Detectives':fontcolor=white:fontsize=30:x=(w-tw)/2:y=h*0.75", "-frames:v", "1", mk(path.join(S, "Backyard Detectives (2020)", "poster.jpg"))]);
  for (const [n, title] of [[1, "Morning Light"], [2, "Coastline"], [3, "Late Train"]]) await ff(["-f", "lavfi", "-i", `sine=frequency=${200 + n * 110}:duration=40`, "-metadata", `title=${title}`, "-metadata", "artist=The Demo Band", "-metadata", "album=First Light", "-metadata", `track=${n}`, "-metadata", "date=2022", "-metadata", "genre=Indie", "-c:a", "libmp3lame", mk(path.join(MU, "The Demo Band", "First Light", `0${n} ${title}.mp3`))]);
  await ff(["-f", "lavfi", "-i", "gradients=size=600x600:c0=gold:c1=crimson:duration=1", "-frames:v", "1", mk(path.join(MU, "The Demo Band", "First Light", "cover.jpg"))]);
  for (const [n, c] of [["beach", "skyblue"], ["sunset", "orange"], ["forest", "forestgreen"], ["snow", "white"]]) await ff(["-f", "lavfi", "-i", `gradients=size=1600x1066:c0=${c}:c1=black:duration=1`, "-vf", `drawtext=text='${n}':fontcolor=white:fontsize=90:x=(w-tw)/2:y=(h-th)/2`, "-frames:v", "1", mk(path.join(P, "Summer 2024", `${n}.jpg`))]);
  fs.writeFileSync(path.join(root, ".made"), "1");
}

// A pretend CelloCloud (so the demo doesn't need a real account). To see the plan lock:
//   CELLOVISION_DEMO_PLAN=warning   (a payment failed: banner)   or   =locked   (payment_failed: lock page)
const cloudAcct = { username: "demo", password: "demo-cloud-pass" };
const fakeCloud = await startFakeCloud({ accounts: { [cloudAcct.username]: { password: cloudAcct.password } } });
const plan = process.env.CELLOVISION_DEMO_PLAN;
if (plan === "warning") fakeCloud.access = { allowed: true, reason: "ok", message: null, lockAt: Date.now() + 3 * 86400_000 };
if (plan === "locked") fakeCloud.access = { allowed: false, reason: "payment_failed", message: "Your CelloCloud payment didn't go through and wasn't fixed within 3 days, so Cellovision is locked. Update your card on cellosig.com.", lockAt: Date.now() - 1000 };

const fresh = !fs.existsSync(path.join(root, "data"));
const srv = await createServer({ dataDir: path.join(root, "data"), log: console.log, cloud: { bases: [fakeCloud.url] } });
await srv.cloud.signIn(cloudAcct); // (the pretend CelloCloud forgets its sign-ins between runs)
if (fresh) {
  const id = srv.auth.create({ name: "Demo", password: "demo-pass", admin: true });
  srv.auth.create({ name: "Kid", maxAge: 10 });
  srv.db.setSetting("serverName", "Demo Cellovision");
  for (const [name, kind, dir] of [["Movies", "movies", "Movies"], ["Shows", "shows", "Shows"], ["Music", "music", "Music"], ["Photos", "photos", "Photos"]])
    srv.db.run("INSERT INTO shelves (id, name, kind, paths, created) VALUES (?, ?, ?, ?, ?)", kind, name, kind, JSON.stringify([path.join(media, dir)]), Date.now());
  void id;
}
await srv.scanner.scan();
await srv.listen(Number(process.env.CELLOVISION_PORT || 8421), "0.0.0.0", 8444);
console.log(`Demo: http://localhost:8421  (Demo / demo-pass, or Kid) · pretend CelloCloud ${fakeCloud.url} (${cloudAcct.username} / ${cloudAcct.password})`);
