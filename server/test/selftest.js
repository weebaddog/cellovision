// Cellovision self-test: makes real sample media with FFmpeg, runs the server, and checks it all.
//   node test/selftest.js

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createServer } from "../src/main.js";
import { FF, run, probe } from "../src/probe.js";
import { parseMovie, parseEpisode, seasonOf } from "../src/names.js";
import { decide } from "../src/stream.js";
import { ageOf } from "../src/meta.js";

process.removeAllListeners("warning");
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${String(e.stack).split("\n").slice(0, 4).join("\n       ")}`); }
}

console.log("names");
await test("movie names", () => {
  assert.deepEqual(parseMovie("Heat (1995).mkv"), { title: "Heat", year: 1995 });
  assert.deepEqual(parseMovie("The.Matrix.1999.1080p.BluRay.x264-GRP.mkv"), { title: "The Matrix", year: 1999 });
  assert.deepEqual(parseMovie("1917 (2019).mp4"), { title: "1917", year: 2019 });
  assert.deepEqual(parseMovie("Blade Runner 2049 (2017) [2160p HDR].mkv"), { title: "Blade Runner 2049", year: 2017 });
  assert.deepEqual(parseMovie("Some Home Movie.mp4"), { title: "Some Home Movie", year: null });
});
await test("episode names", () => {
  assert.deepEqual(parseEpisode("Show.Name.S02E05.Title.Here.1080p.mkv"), { season: 2, episode: 5, episodeEnd: null, title: "Title Here" });
  assert.equal(parseEpisode("show.2x05.mkv").episode, 5);
  assert.equal(parseEpisode("S01E01E02 - Double.mkv").episodeEnd, 2);
  assert.deepEqual(parseEpisode("E03.mkv", "Season 4"), { season: 4, episode: 3, episodeEnd: null, title: null });
  assert.equal(parseEpisode("03 - Something.mkv", "Season 1").episode, 3);
  assert.equal(seasonOf("Specials"), 0);
  assert.equal(seasonOf("Extras"), null);
});
await test("age labels", () => {
  assert.equal(ageOf("R"), 17); assert.equal(ageOf("TV-MA"), 17); assert.equal(ageOf("PG-13"), 13); assert.equal(ageOf("G"), 0); assert.equal(ageOf("FSK 12"), 12); assert.equal(ageOf(null), null);
});
await test("Fit to Device decisions", () => {
  const h264mp4 = { container: "mov,mp4,m4a,3gp,3g2,mj2", streams: [{ index: 0, type: "video", codec: "h264", height: 1080 }, { index: 1, type: "audio", codec: "aac", channels: 2 }] };
  const web = { video: ["h264"], audio: ["aac", "mp3"], containers: ["mp4"] };
  assert.equal(decide(h264mp4, web).mode, "direct");
  assert.equal(decide({ ...h264mp4, container: "matroska,webm" }, web).mode, "remux");
  assert.equal(decide({ ...h264mp4, streams: [{ ...h264mp4.streams[0], codec: "hevc" }, h264mp4.streams[1]] }, web).mode, "convert");
  assert.equal(decide(h264mp4, { ...web, maxHeight: 720 }).mode, "convert");
  assert.equal(decide({ ...h264mp4, streams: [...h264mp4.streams, { index: 2, type: "audio", codec: "aac" }] }, web, { audio: 2 }).mode, "remux");
  assert.equal(decide({ ...h264mp4, streams: [...h264mp4.streams, { index: 3, type: "subtitle", codec: "hdmv_pgs_subtitle", text: false }] }, web, { sub: 3 }).mode, "convert");
});

// ---- sample media --------------------------------------------------------------------------

console.log("making sample media with ffmpeg…");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cellovision-"));
const media = path.join(tmp, "media");
const mk = (p) => { fs.mkdirSync(path.dirname(p), { recursive: true }); return p; };
const ff = (args) => run(FF.ffmpeg, ["-v", "error", "-y", ...args], { timeout: 180_000 });
const VIDEO = (secs, size = "320x180") => ["-f", "lavfi", "-i", `testsrc2=size=${size}:rate=25:duration=${secs}`, "-f", "lavfi", "-i", `sine=frequency=440:duration=${secs}`];

const M = path.join(media, "Movies"), S = path.join(media, "Shows"), MU = path.join(media, "Music"), P = path.join(media, "Photos");
await ff([...VIDEO(6), "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", mk(path.join(M, "Heat (1995)", "Heat.1995.1080p.BluRay.mkv"))]);
fs.writeFileSync(path.join(M, "Heat (1995)", "Heat.1995.1080p.BluRay.en.srt"), "1\n00:00:01,000 --> 00:00:03,000\nHello from a subtitle file\n");
fs.writeFileSync(path.join(M, "Heat (1995)", "movie.nfo"), `<movie><title>Heat</title><plot>A crew of thieves and a detective.</plot><year>1995</year><mpaa>Rated R</mpaa><genre>Crime</genre><genre>Drama</genre><rating>8.3</rating></movie>`);
await ff([...VIDEO(150, "160x90"), "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-movflags", "+faststart", mk(path.join(M, "Toy.Story.1995.720p.mp4"))]);
// HEVC + AC-3 + an embedded text subtitle: needs converting for a browser.
fs.writeFileSync(path.join(tmp, "embedded.srt"), "1\n00:00:00,500 --> 00:00:02,500\nEmbedded words\n");
await ff([...VIDEO(8), "-i", path.join(tmp, "embedded.srt"), "-map", "0:v", "-map", "1:a", "-map", "2:s", "-c:v", "libx265", "-preset", "ultrafast", "-x265-params", "log-level=error", "-c:a", "ac3", "-c:s", "srt", "-metadata:s:s:0", "language=eng",
  mk(path.join(M, "Far Future (2031)", "far.future.2031.2160p.hevc.mkv"))]);
for (const [s, e] of [[1, 1], [1, 2], [2, 1]]) await ff([...VIDEO(4, "160x90"), "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", mk(path.join(S, "Example Show (2010)", `Season 0${s}`, `Example.Show.S0${s}E0${e}.Episode.${s}${e}.mkv`))]);
fs.writeFileSync(path.join(S, "Example Show (2010)", "tvshow.nfo"), `<tvshow><title>Example Show</title><plot>A show for testing.</plot><mpaa>TV-MA</mpaa><genre>Comedy</genre></tvshow>`);
for (const n of [1, 2]) await ff(["-f", "lavfi", "-i", "sine=frequency=330:duration=3", "-metadata", `title=Song ${n}`, "-metadata", "artist=Test Artist", "-metadata", "album=Test Album", "-metadata", `track=${n}`, "-metadata", "date=2001", "-metadata", "genre=Rock", "-c:a", "libmp3lame", mk(path.join(MU, "whatever", `0${n} track.mp3`))]);
await ff(["-f", "lavfi", "-i", "color=c=teal:size=640x480", "-frames:v", "1", mk(path.join(P, "2024", "beach.jpg"))]);
await ff(["-f", "lavfi", "-i", "color=c=orange:size=640x480", "-frames:v", "1", mk(path.join(P, "2024", "sunset.png"))]);

// ---- the server -----------------------------------------------------------------------------

console.log("server");
const dataDir = path.join(tmp, "data");
const srv = await createServer({ dataDir, log: () => {}, fetchImpl: async () => { throw new Error("offline"); } });
const PORT = 18420;
await srv.listen(PORT, "127.0.0.1");
const base = `http://127.0.0.1:${PORT}`;
let token = null;
const call = async (method, p, body, tok = token, extra = {}) => {
  const r = await fetch(base + p, { method, headers: { "content-type": "application/json", ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });
  const type = r.headers.get("content-type") || "";
  return { status: r.status, headers: r.headers, body: type.includes("json") ? await r.json() : Buffer.from(await r.arrayBuffer()) };
};

await test("first set-up makes the admin profile", async () => {
  assert.equal((await call("GET", "/api/hello")).body.setUp, false);
  assert.equal((await call("POST", "/api/setup", { name: "Ana", password: "x" })).status, 400);
  const r = await call("POST", "/api/setup", { name: "Ana", password: "secret-pass", serverName: "Home", device: "test" });
  assert.equal(r.status, 200); token = r.body.token;
  assert.equal((await call("POST", "/api/setup", { name: "Eve", password: "secret-pass" })).status, 409);
  const me = await call("GET", "/api/me");
  assert.equal(me.body.name, "Ana"); assert.equal(me.body.admin, true);
  assert.equal((await call("GET", "/api/hello")).body.name, "Home");
});
await test("sign in, wrong password, signed-out requests", async () => {
  assert.equal((await call("POST", "/api/signin", { name: "Ana", password: "nope" }, null)).status, 403);
  assert.equal((await call("POST", "/api/signin", { name: "Ana", password: "secret-pass" }, null)).status, 200);
  assert.equal((await call("GET", "/api/home", null, null)).status, 401);
});
await test("cookie sign-in needs the app's header to change things", async () => {
  const r = await fetch(`${base}/api/signin`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Ana", password: "secret-pass", web: true }) });
  const ck = r.headers.get("set-cookie").split(";")[0];
  assert.equal((await call("GET", "/api/me", null, null, { cookie: ck })).status, 200);
  assert.equal((await call("POST", "/api/mixtapes", { name: "x" }, null, { cookie: ck })).status, 403);
  assert.equal((await call("POST", "/api/mixtapes", { name: "x" }, null, { cookie: ck, "x-cellovision": "1" })).status, 200);
});

const shelf = {};
await test("adding shelves and scanning them", async () => {
  for (const [name, kind, dir] of [["Movies", "movies", M], ["Shows", "shows", S], ["Music", "music", MU], ["Photos", "photos", P]]) {
    const r = await call("POST", "/api/control/shelves", { name, kind, paths: [dir] });
    assert.equal(r.status, 200, JSON.stringify(r.body)); shelf[kind] = r.body.id;
  }
  assert.equal((await call("POST", "/api/control/shelves", { name: "x", kind: "movies", paths: [path.join(tmp, "nope")] })).status, 400);
  await srv.scanner.scan();
  const c = await call("GET", "/api/control");
  assert.ok(c.body.activity.some((a) => a.text.startsWith("Scanned Movies: 3")), JSON.stringify(c.body.activity.map((a) => a.text)));
});

let ids = {};
await test("movies: names, details from .nfo, age, sidecar subtitles", async () => {
  const r = await call("GET", `/api/browse?shelf=${shelf.movies}`);
  const titles = r.body.items.map((i) => `${i.title} (${i.year})`).sort();
  assert.deepEqual(titles, ["Far Future (2031)", "Heat (1995)", "Toy Story (1995)"]);
  for (const i of r.body.items) ids[i.title] = i.id;
  const heat = (await call("GET", `/api/item?id=${ids.Heat}`)).body;
  assert.equal(heat.overview, "A crew of thieves and a detective."); assert.equal(heat.age, 17); assert.deepEqual(heat.genres, ["Crime", "Drama"]); assert.equal(heat.score, 8.3);
  assert.equal(heat.tracks.subtitles.find((s) => s.key === "f0").lang, "en");
  const far = (await call("GET", `/api/item?id=${ids["Far Future"]}`)).body;
  assert.equal(far.video.codec, "hevc"); assert.equal(far.tracks.audio[0].codec, "ac3");
  assert.equal(far.tracks.subtitles[0].lang, "eng"); assert.equal(far.tracks.subtitles[0].text, true);
  assert.deepEqual(r.body.genres, ["Crime", "Drama"]);
});
await test("shows: show › seasons › episodes, details from tvshow.nfo", async () => {
  const shows = (await call("GET", `/api/browse?shelf=${shelf.shows}`)).body.items;
  assert.equal(shows.length, 1); ids.show = shows[0].id;
  const show = (await call("GET", `/api/item?id=${ids.show}`)).body;
  assert.equal(show.title, "Example Show"); assert.equal(show.age, 17); assert.deepEqual(show.seasons.map((s) => s.title), ["Season 1", "Season 2"]);
  const s1 = (await call("GET", `/api/item?id=${show.seasons[0].id}`)).body;
  assert.deepEqual(s1.children.map((e) => `${e.seasonNo}x${e.episodeNo} ${e.title}`), ["1x1 Episode 11", "1x2 Episode 12"]);
  ids.e11 = s1.children[0].id; ids.e12 = s1.children[1].id;
  assert.equal(show.next.id, ids.e11);
});
await test("music: artist › album › tracks from tags", async () => {
  const albums = (await call("GET", `/api/browse?shelf=${shelf.music}`)).body.items;
  assert.equal(albums.length, 1); assert.equal(albums[0].title, "Test Album"); assert.equal(albums[0].artist, "Test Artist");
  const album = (await call("GET", `/api/item?id=${albums[0].id}`)).body;
  assert.deepEqual(album.children.map((t) => `${t.trackNo} ${t.title}`), ["1 Song 1", "2 Song 2"], JSON.stringify(srv.db.all("SELECT kind, title, parent_id, missing, shelf_id FROM items WHERE shelf_id = ?", shelf.music)));
  assert.equal(album.parents[0].title, "Test Artist");
  ids.album = albums[0].id; ids.track = album.children[0].id;
});
await test("photos: folders and pictures", async () => {
  const top = (await call("GET", `/api/browse?shelf=${shelf.photos}`)).body.items;
  assert.equal(top.length, 1); assert.equal(top[0].kind, "folder"); assert.equal(top[0].title, "2024");
  const inside = (await call("GET", `/api/browse?shelf=${shelf.photos}&parent=${top[0].id}`)).body.items;
  assert.deepEqual(inside.map((p) => p.title).sort(), ["beach.jpg", "sunset.png"]);
  ids.photo = inside[0].id;
});
await test("pictures: posters from video stills, photo thumbnails, sized", async () => {
  for (const id of [ids.Heat, ids.photo, ids.e11]) {
    const r = await call("GET", `/api/img/${id}/poster?w=200`);
    assert.equal(r.status, 200); assert.equal(r.headers.get("content-type"), "image/jpeg"); assert.ok(r.body.length > 500);
  }
  assert.equal((await call("GET", `/api/img/${ids.Heat}/backdrop`)).status, 404);
});

const WEB = { video: ["h264"], audio: ["aac", "mp3"], containers: ["mp4"] };
await test("Fit to Device: direct play with byte ranges", async () => {
  const p = (await call("POST", "/api/play", { id: ids["Toy Story"], caps: WEB })).body;
  assert.equal(p.mode, "direct");
  const r = await call("GET", `${p.url}?t=${token}`, null, null, { range: "bytes=0-99" });
  assert.equal(r.status, 206); assert.equal(r.body.length, 100); assert.equal(r.headers.get("content-type"), "video/mp4");
});
async function hlsFirstSegment(p) {
  const pl = await call("GET", p.url, null, null);
  assert.equal(pl.status, 401); // (the playlist needs the token too)
  const list = (await call("GET", `${p.url}?t=${token}`, null, null)).body.toString();
  assert.match(list, /#EXTINF/);
  const seg = list.split("\n").find((l) => l.startsWith("s00000.ts"));
  assert.ok(seg, list);
  const r = await call("GET", `/api/hls/${p.session}/${seg}`, null, null);
  assert.equal(r.status, 200); assert.ok(r.body.length > 1000);
  const f = path.join(tmp, `${p.session}.ts`); fs.writeFileSync(f, r.body);
  return probe(f);
}
await test("Fit to Device: remux (MKV for a device that only takes MP4)", async () => {
  const p = (await call("POST", "/api/play", { id: ids.Heat, caps: WEB })).body;
  assert.equal(p.mode, "remux"); assert.deepEqual(p.reasons, ["container matroska,webm"]);
  const info = await hlsFirstSegment(p);
  assert.equal(info.streams.find((s) => s.type === "video").codec, "h264");
});
await test("Fit to Device: convert (HEVC + AC-3 → H.264 + AAC)", async () => {
  const p = (await call("POST", "/api/play", { id: ids["Far Future"], caps: WEB })).body;
  assert.equal(p.mode, "convert"); assert.ok(p.reasons.includes("video hevc") && p.reasons.includes("audio ac3"));
  const info = await hlsFirstSegment(p);
  assert.equal(info.streams.find((s) => s.type === "video").codec, "h264");
  assert.equal(info.streams.find((s) => s.type === "audio").codec, "aac");
  console.log(`       (encoder: ${p.encoder})`);
  assert.equal((await call("DELETE", "/api/hls", { session: p.session })).status, 200);
});
await test("Fit to Device: HEVC for a device that plays HEVC is repackaged into fMP4 (init + segments)", async () => {
  const p = (await call("POST", "/api/play", { id: ids["Far Future"], caps: { ...WEB, video: ["h264", "hevc"] } })).body;
  assert.equal(p.mode, "remux");
  const list = (await call("GET", `${p.url}?t=${token}`, null, null)).body.toString();
  assert.match(list, /#EXT-X-MAP:URI="init\.mp4\?t=/);
  assert.match(list, /s00000\.m4s\?t=/);
  assert.equal((await call("GET", `/api/hls/${p.session}/init.mp4?t=${token}`, null, null)).status, 200);
  const seg = await call("GET", `/api/hls/${p.session}/s00000.m4s?t=${token}`, null, null);
  assert.equal(seg.status, 200); assert.ok(seg.body.length > 1000);
  await call("DELETE", "/api/hls", { session: p.session });
});
await test("subtitles as WebVTT: a file beside the video, and one inside it", async () => {
  const a = await call("GET", `/api/subs/${ids.Heat}/f0.vtt?t=${token}`, null, null);
  assert.match(a.body.toString(), /WEBVTT[\s\S]*Hello from a subtitle file/);
  const far = (await call("GET", `/api/item?id=${ids["Far Future"]}`)).body;
  const b = await call("GET", `/api/subs/${ids["Far Future"]}/${far.tracks.subtitles[0].key}.vtt?t=${token}`, null, null);
  assert.match(b.body.toString(), /Embedded words/);
});
await test("Keep Watching, watched at 90%, Up Next", async () => {
  await call("POST", "/api/playing", { id: ids["Toy Story"], position: 40 });
  let home = (await call("GET", "/api/home")).body;
  assert.deepEqual(home.keepWatching.map((i) => i.title), ["Toy Story"]);
  assert.equal(home.keepWatching[0].mark.position, 40);
  assert.equal((await call("POST", "/api/play", { id: ids["Toy Story"], caps: WEB })).body.resume, 40);
  const done = await call("POST", "/api/playing", { id: ids.e11, position: 3.8 }); // 95% of 4 s
  assert.equal(done.body.played, true);
  home = (await call("GET", "/api/home")).body;
  assert.equal(home.upNext[0].id, ids.e12); assert.equal(home.upNext[0].showTitle, "Example Show");
  assert.ok(home.latest.some((r) => r.shelf.kind === "movies" && r.items.length === 3));
  assert.equal((await call("GET", `/api/item?id=${ids.e11}`)).body.nextEpisode.id, ids.e12);
});
await test("marking a whole season watched", async () => {
  const show = (await call("GET", `/api/item?id=${ids.show}`)).body;
  await call("POST", "/api/mark", { id: show.seasons[0].id, played: true });
  const s1 = (await call("GET", `/api/item?id=${show.seasons[0].id}`)).body;
  assert.ok(s1.children.every((e) => e.mark.played));
  assert.equal((await call("GET", "/api/home")).body.upNext[0].seasonNo, 2);
});
await test("Hearts and search", async () => {
  await call("POST", "/api/mark", { id: ids.Heat, heart: true });
  assert.deepEqual((await call("GET", "/api/hearts")).body.items.map((i) => i.title), ["Heat"]);
  assert.deepEqual((await call("GET", `/api/browse?shelf=${shelf.movies}&heart=1`)).body.items.map((i) => i.title), ["Heat"]);
  const s = (await call("GET", "/api/search?q=song")).body.items.map((i) => i.title);
  assert.deepEqual(s, ["Song 1", "Song 2"]);
  assert.ok((await call("GET", "/api/search?q=example")).body.items.some((i) => i.kind === "show"));
});
await test("Sets and Mixtapes", async () => {
  const set = (await call("POST", "/api/sets", { name: "Nineties" })).body.id;
  await call("POST", "/api/set/items", { set, item: ids.Heat });
  await call("POST", "/api/set/items", { set, item: ids["Toy Story"] });
  assert.deepEqual((await call("GET", `/api/set?id=${set}`)).body.items.map((i) => i.title).sort(), ["Heat", "Toy Story"]);
  const mt = (await call("POST", "/api/mixtapes", { name: "Road trip" })).body.id;
  await call("POST", "/api/mixtape/items", { mixtape: mt, item: ids.album });
  assert.deepEqual((await call("GET", `/api/mixtape?id=${mt}`)).body.items.map((i) => i.title), ["Song 1", "Song 2"]);
});
let kidToken;
await test("Age Limits: a 10-year-old's profile can't see R or TV-MA", async () => {
  await call("POST", "/api/control/profiles", { name: "Kid", password: "", maxAge: 10 });
  kidToken = (await call("POST", "/api/signin", { name: "Kid", password: "" }, null)).body.token;
  const titles = (await call("GET", `/api/browse?shelf=${shelf.movies}`, null, kidToken)).body.items.map((i) => i.title).sort();
  assert.deepEqual(titles, ["Far Future", "Toy Story"]);
  assert.equal((await call("GET", `/api/browse?shelf=${shelf.shows}`, null, kidToken)).body.items.length, 0);
  assert.equal((await call("GET", `/api/item?id=${ids.Heat}`, null, kidToken)).status, 404);
  assert.equal((await call("GET", `/api/item?id=${ids.e11}`, null, kidToken)).status, 404); // (the episode follows its show)
  assert.equal((await call("GET", `/api/file/${ids.Heat}?t=${kidToken}`, null, null)).status, 404);
  assert.equal((await call("GET", "/api/control", null, kidToken)).status, 403);
  assert.equal((await call("GET", "/api/home", null, kidToken)).body.keepWatching.length, 0); // (Ana's marks are hers)
});
await test("Pair Code: a TV signs in by a code approved on a phone", async () => {
  const s = (await call("POST", "/api/pair/start", { device: "Living room TV" }, null)).body;
  assert.match(s.code, /^[A-Z2-9]{6}$/);
  assert.equal((await call("POST", "/api/pair/check", { code: s.code, secret: s.secret }, null)).body.approved, false);
  assert.equal((await call("POST", "/api/pair/check", { code: s.code, secret: "wrong" }, null)).status, 410);
  assert.equal((await call("POST", "/api/pair/approve", { code: "ZZZZZZ" })).status, 404);
  assert.equal((await call("POST", "/api/pair/approve", { code: s.code.toLowerCase() })).body.device, "Living room TV");
  const ok = (await call("POST", "/api/pair/check", { code: s.code, secret: s.secret }, null)).body;
  assert.equal(ok.approved, true);
  assert.equal((await call("GET", "/api/me", null, ok.token)).body.name, "Ana");
  assert.equal((await call("POST", "/api/pair/check", { code: s.code, secret: s.secret }, null)).status, 410); // (used up)
});
await test("Control Room: folders, settings, now playing", async () => {
  const roots = (await call("GET", "/api/control/folders")).body.folders;
  assert.ok(roots.length > 0);
  const inside = (await call("GET", `/api/control/folders?path=${encodeURIComponent(media)}`)).body.folders.map((f) => path.basename(f)).sort();
  assert.deepEqual(inside, ["Movies", "Music", "Photos", "Shows"]);
  await call("PUT", "/api/control/settings", { encoder: "libx264", scanEvery: 12 });
  const c = (await call("GET", "/api/control")).body;
  assert.equal(c.settings.encoder, "libx264"); assert.equal(c.settings.scanEvery, 12);
  assert.ok(c.playing.some((p) => p.item.title === "Toy Story" || p.item.id));
  assert.equal(c.profiles.length, 2);
});
await test("a file that disappears is marked missing, not deleted", async () => {
  fs.rmSync(path.join(M, "Toy.Story.1995.720p.mp4"));
  await srv.scanner.scan(shelf.movies);
  assert.equal((await call("GET", `/api/browse?shelf=${shelf.movies}`)).body.total, 2);
  assert.equal(srv.db.get("SELECT missing FROM items WHERE id = ?", ids["Toy Story"]).missing, 1);
  assert.equal(srv.db.get("SELECT position FROM marks WHERE item_id = ?", ids["Toy Story"]).position, 40); // (Keep Watching kept)
});
await test("the web app is served, files outside it aren't", async () => {
  const r = await fetch(`${base}/`);
  assert.equal(r.status, 200);
  assert.equal((await fetch(`${base}/..%2fserver%2fpackage.json`)).status, 404);
});

srv.close();
await new Promise((r) => setTimeout(r, 500));
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
