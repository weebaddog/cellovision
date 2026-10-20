// The pages people browse: Home, a Shelf, an item, Search, Hearts, Sets, Mixtapes, Pair Code.

import { h, api, img, act, toast, sheet, go, fmtTime, fmtRuntime, ep, state, localGet, localSet } from "./core.js";
import { playVideo, music, viewPhotos } from "./player.js";

const KIND_ICON = { movies: "🎬", shows: "📺", music: "🎵", photos: "🖼", videos: "📹" };
const SHAPE = { movie: "", show: "", season: "", episode: "wide", video: "wide", album: "square", artist: "square", track: "square", photo: "square", folder: "square" };

// ---- cards -------------------------------------------------------------------------------------

export function card(i, { shape = SHAPE[i.kind] ?? "", sub = null, onclick = null, list = null } = {}) {
  const pct = i.mark?.position && i.duration ? Math.min(100, (i.mark.position / i.duration) * 100) : 0;
  const width = shape === "wide" ? 400 : 260;
  const art = h("div", { class: "art" },
    i.poster || i.kind === "folder" ? h("img", { src: img(i.kind === "folder" ? firstOf(i) : i.id, "poster", width), alt: "", loading: "lazy", onerror: (e) => e.target.replaceWith(h("div", { class: "ph" }, i.kind === "folder" ? "📁" : i.title)) }) : h("div", { class: "ph" }, i.title),
    pct > 0 && !i.mark.played ? h("div", { class: "bar" }, h("i", { style: { width: `${pct}%` } })) : null,
    i.mark?.played && ["movie", "episode", "video"].includes(i.kind) ? h("div", { class: "tick", title: "Watched" }, "✓") : null,
    i.mark?.heart ? h("div", { class: "heart" }, "❤️") : null,
    ["episode", "video", "track"].includes(i.kind) ? h("div", { class: "play" }, "▶") : null);
  const subText = sub ?? (i.kind === "episode" ? `${i.showTitle ? i.showTitle + " · " : ""}${ep(i)}` : i.kind === "album" ? i.artist : i.kind === "season" ? null : i.year);
  return h("a", { class: `card ${shape}`, href: i.kind === "photo" || i.kind === "track" || i.kind === "folder" ? "#" : `#/item/${i.id}`, tabindex: "0",
    onclick: (e) => {
      if (onclick) { e.preventDefault(); onclick(i); }
      else if (i.kind === "photo") { e.preventDefault(); viewPhotos(list || [i], (list || [i]).indexOf(i)); }
      else if (i.kind === "track") { e.preventDefault(); music.play(list || [i], (list || [i]).indexOf(i)); }
    } },
    art, h("div", { class: "t", title: i.title }, i.title), subText ? h("div", { class: "s" }, String(subText)) : null);
}
// A folder's picture: its first photo (the server finds it when asked for the folder's poster).
const firstOf = (folder) => folder.id;

const row = (title, items, opts = {}) => items.length ? h("section", { class: "row" },
  h("h2", {}, title, opts.more ? h("a", { href: opts.more }, "See all") : null),
  h("div", { class: `scroller ${opts.shape || ""}` }, items.map((i) => card(i, { shape: opts.shape, list: items })))) : null;

// ---- Home ------------------------------------------------------------------------------------

export async function homePage() {
  const d = await api("GET", "/api/home");
  const heroItem = d.keepWatching[0] || d.upNext[0] || d.latest.find((r) => r.shelf.kind === "movies" || r.shelf.kind === "shows")?.items[0];
  const hero = heroItem ? h("section", { class: "hero" },
    h("div", { class: "bg", style: { backgroundImage: `url("${img(heroItem.showId || heroItem.id, "backdrop", 1600)}"), url("${img(heroItem.id, "poster", 1200)}")` } }),
    h("div", { class: "text" },
      h("div", { class: "small", style: { textTransform: "uppercase", letterSpacing: ".08em", opacity: ".8" } }, d.keepWatching[0] === heroItem ? "Keep Watching" : d.upNext[0] === heroItem ? "Up Next" : "New"),
      h("h1", {}, heroItem.showTitle || heroItem.title),
      heroItem.kind === "episode" ? h("div", { style: { fontWeight: "700", marginBottom: "6px" } }, `${ep(heroItem)} · ${heroItem.title}`) : null,
      heroItem.overview ? h("p", {}, heroItem.overview) : null,
      h("div", { class: "btns" },
        ["movie", "episode", "video"].includes(heroItem.kind) ? h("button", { class: "btn primary", onclick: () => playVideo(heroItem.id) }, heroItem.mark.position > 30 ? `▶ Resume ${fmtTime(heroItem.mark.position)}` : "▶ Play") : null,
        h("a", { class: "btn", href: `#/item/${heroItem.id}` }, "More")))) : null;
  if (!d.shelves.length) {
    return h("div", {}, h("div", { class: "empty" }, h("h2", {}, "Nothing here yet"),
      state.me.admin ? [h("p", {}, "Add your first shelf (a folder of movies, shows, music or photos) in the Control Room."), h("a", { class: "btn primary", href: "#/control" }, "Open the Control Room")]
        : h("p", {}, "Ask whoever runs this server to add some shelves.")));
  }
  return h("div", {},
    hero,
    h("div", { class: "tiles" }, d.shelves.map((s) => h("a", { class: "tile", href: `#/shelf/${s.id}` }, h("div", { class: "ic" }, KIND_ICON[s.kind]), s.name, h("small", {}, `${s.count} ${s.kind === "shows" ? "shows" : s.kind === "music" ? "albums" : "items"}`)))),
    row("Keep Watching", d.keepWatching, { shape: "wide" }),
    row("Up Next", d.upNext, { shape: "wide" }),
    d.latest.map((r) => row(`New in ${r.shelf.name}`, r.items, { more: `#/shelf/${r.shelf.id}`, shape: r.shelf.kind === "music" || r.shelf.kind === "photos" ? "square" : r.shelf.kind === "videos" ? "wide" : "" })));
}

// ---- a Shelf ---------------------------------------------------------------------------------

export async function shelfPage(id, query) {
  const shelves = (await api("GET", "/api/shelves")).shelves;
  const shelf = shelves.find((s) => s.id === id);
  if (!shelf) return h("div", { class: "empty" }, "That shelf isn't here.");
  const q = new URLSearchParams(query || localGet(`shelf.${id}`) || "");
  const folderMode = shelf.kind === "photos" || shelf.kind === "videos";
  const params = new URLSearchParams({ shelf: id, limit: "300", ...Object.fromEntries(q) });
  const d = await api("GET", `/api/browse?${params}`);
  const set = (k, v) => { if (v) q.set(k, v); else q.delete(k); localSet(`shelf.${id}`, q.toString()); go(`#/shelf/${id}?${q}`); };
  const sort = h("select", { "aria-label": "Sort", onchange: (e) => set("sort", e.target.value) },
    (folderMode ? [["", "Folders first"], ["taken", "Newest"], ["title", "A–Z"]] : [["", "A–Z"], ["added", "Newly added"], ["year", "Year"], ["score", "Best rated"]])
      .map(([v, l]) => h("option", { value: v, selected: (q.get("sort") || "") === v }, l)));
  const genre = d.genres.length ? h("select", { "aria-label": "Genre", onchange: (e) => set("genre", e.target.value) }, h("option", { value: "" }, "All genres"), d.genres.map((g) => h("option", { value: g, selected: q.get("genre") === g }, g))) : null;
  const parent = q.get("parent");
  const crumbs = parent ? (await api("GET", `/api/item?id=${parent}`)) : null;
  const items = d.items;
  const shape = shelf.kind === "music" ? "square" : shelf.kind === "photos" ? "square" : shelf.kind === "videos" ? "wide" : "";
  return h("div", {},
    h("h1", {}, shelf.name),
    crumbs ? h("p", {}, h("a", { href: "#", onclick: (e) => { e.preventDefault(); set("parent", crumbs.parentId); } }, "← Back"), " · ", crumbs.parents.map((p) => p.title).concat(crumbs.title).join(" / ")) : null,
    h("div", { class: "toolbar" }, sort, genre,
      !folderMode ? h("button", { class: `chip${q.get("played") === "0" ? " on" : ""}`, onclick: () => set("played", q.get("played") === "0" ? null : "0") }, "Not watched") : null,
      h("button", { class: `chip${q.get("heart") === "1" ? " on" : ""}`, onclick: () => set("heart", q.get("heart") === "1" ? null : "1") }, "❤ Hearts"),
      h("span", { class: "muted small" }, `${d.total} ${d.total === 1 ? "item" : "items"}`),
      shelf.kind === "photos" && items.some((i) => i.kind === "photo") ? h("button", { class: "btn small", onclick: () => viewPhotos(items, items.findIndex((i) => i.kind === "photo")) }, "▶ Slideshow") : null),
    items.length ? h("div", { class: `grid ${shape}` }, items.map((i) => card(i, {
      shape: i.kind === "folder" ? "square" : shape, list: items,
      onclick: i.kind === "folder" ? () => set("parent", i.id) : null,
    }))) : h("div", { class: "empty" }, "Nothing matches."));
}

// ---- an item ---------------------------------------------------------------------------------

export async function itemPage(id) {
  const i = await api("GET", `/api/item?id=${encodeURIComponent(id)}`);
  const show = i.parents.find((p) => p.kind === "show");
  const shape = { episode: "wide", video: "wide", album: "square", artist: "square" }[i.kind] || "";
  const facts = [i.year, i.age !== null && i.rating ? h("span", { class: "age" }, i.rating) : null, fmtRuntime(i.duration), i.score ? `★ ${i.score.toFixed(1)}` : null,
    i.video ? `${i.video.height >= 2000 ? "4K" : i.video.height >= 1000 ? "HD" : `${i.video.height}p`}${i.video.hdr ? " HDR" : ""}` : null, i.genres.join(", ") || null, i.studio].filter(Boolean);
  const heart = h("button", { class: `btn${i.mark.heart ? " on" : ""}`, "aria-pressed": String(i.mark.heart), onclick: async () => {
    const r = await act(() => api("POST", "/api/mark", { id: i.id, heart: !i.mark.heart }));
    if (r) { i.mark.heart = !!r.mark.heart; heart.classList.toggle("on", i.mark.heart); heart.textContent = i.mark.heart ? "❤ Hearted" : "♡ Heart"; }
  } }, i.mark.heart ? "❤ Hearted" : "♡ Heart");
  const watched = ["movie", "episode", "video", "show", "season"].includes(i.kind) ? h("button", { class: "btn", onclick: async () => {
    const played = !i.mark.played;
    if (await act(() => api("POST", "/api/mark", { id: i.id, played }), played ? "Marked as watched" : "Marked as not watched")) go(`#/item/${i.id}`);
  } }, i.mark.played ? "✓ Watched" : "Mark watched") : null;

  const playable = ["movie", "episode", "video"].includes(i.kind);
  const actions = h("div", { class: "btns" },
    playable && i.mark.position > 30 && !i.mark.played ? h("button", { class: "btn primary", onclick: () => playVideo(i.id) }, `▶ Resume ${fmtTime(i.mark.position)}`) : null,
    playable ? h("button", { class: `btn${i.mark.position > 30 && !i.mark.played ? "" : " primary"}`, onclick: () => playVideo(i.id, { start: 0 }) }, i.mark.position > 30 && !i.mark.played ? "↺ From the start" : "▶ Play") : null,
    i.kind === "show" && i.next ? h("button", { class: "btn primary", onclick: () => playVideo(i.next.id) }, `▶ ${i.next.mark.position > 30 ? "Resume" : "Play"} ${ep(i.next)}`) : null,
    i.kind === "album" ? [h("button", { class: "btn primary", onclick: () => music.play(i.children, 0) }, "▶ Play album"), h("button", { class: "btn", onclick: () => music.add(i.children) }, "+ Queue")] : null,
    heart, watched,
    ["movie", "episode", "video", "album", "track"].includes(i.kind) ? h("button", { class: "btn", onclick: () => addToMixtape(i) }, "+ Mixtape") : null,
    state.me.admin && ["movie", "show", "album"].includes(i.kind) ? h("button", { class: "btn", onclick: () => addToSet(i) }, "+ Set") : null);

  const top = h("section", { class: "item-top" },
    h("div", { class: "bg", style: { backgroundImage: `url("${img(i.kind === "episode" || i.kind === "season" ? show?.id || i.id : i.id, "backdrop", 1920)}")` } }),
    h("div", { class: `poster ${shape}` }, h("img", { src: img(i.id, "poster", shape === "wide" ? 720 : 460), alt: "", onerror: (e) => { e.target.style.display = "none"; } })),
    h("div", { class: "info" },
      i.parents.length ? h("div", { class: "muted", style: { fontWeight: "700" } }, i.parents.map((p, n) => [n ? " › " : "", h("a", { href: `#/item/${p.id}` }, p.title)])) : null,
      h("h1", {}, i.kind === "episode" ? `${ep(i)} · ${i.title}` : i.title),
      i.kind === "album" && i.artist && !i.parents.some((p) => p.title === i.artist) ? h("div", { style: { fontWeight: "700" } }, i.artist) : null,
      h("div", { class: "facts" }, facts.map((f) => (typeof f === "string" || typeof f === "number" ? h("span", {}, String(f)) : f))),
      i.overview ? h("p", { class: "overview" }, i.overview) : null,
      i.mark.position > 30 && !i.mark.played && i.duration ? h("div", { class: "meter", style: { maxWidth: "360px", margin: "8px 0" } }, h("i", { style: { width: `${(i.mark.position / i.duration) * 100}%` } })) : null,
      actions,
      i.sets?.length ? h("div", { class: "muted small" }, "In: ", i.sets.map((s, n) => [n ? ", " : "", h("a", { href: `#/set/${s.id}`, style: { color: "var(--accent)" } }, s.name)])) : null));

  let body = null;
  if (i.kind === "show") body = seasonsBlock(i);
  else if (i.kind === "season") body = episodesBlock(i.children);
  else if (i.kind === "album") body = trackList(i.children);
  else if (i.kind === "artist") body = h("section", { class: "row" }, h("h2", {}, "Albums"), h("div", { class: "grid square" }, i.children.map((a) => card(a, { shape: "square" }))));
  else if (i.kind === "episode" && i.nextEpisode) body = row("Next episode", [i.nextEpisode], { shape: "wide" });
  const tracksInfo = i.tracks ? h("p", { class: "muted small" },
    i.tracks.audio.length ? `Audio: ${i.tracks.audio.map((a) => [a.lang?.toUpperCase(), a.codec?.toUpperCase(), a.channels === 6 ? "5.1" : a.channels === 8 ? "7.1" : null].filter(Boolean).join(" ")).join(", ")}` : "",
    i.tracks.subtitles.length ? ` · Subtitles: ${i.tracks.subtitles.map((s) => (s.lang || "?").toUpperCase() + (s.forced ? " forced" : "")).join(", ")}` : "") : null;
  return h("div", {}, top, tracksInfo, body, i.similar?.length ? row("More like this", i.similar) : null);
}

function seasonsBlock(show) {
  const wrap = h("div");
  const tabs = h("div", { class: "chips", style: { margin: "10px 0 16px" } });
  const list = h("div");
  const pickIdx = Math.max(0, show.seasons.findIndex((s) => s.id === show.next?.parentId));
  const open = async (n) => {
    tabs.querySelectorAll(".chip").forEach((c, k) => c.classList.toggle("on", k === n));
    const s = await api("GET", `/api/item?id=${show.seasons[n].id}`);
    list.replaceChildren(episodesBlock(s.children));
  };
  show.seasons.forEach((s, n) => tabs.append(h("button", { class: "chip", onclick: () => open(n) }, s.title)));
  wrap.append(h("h2", {}, "Seasons"), tabs, list);
  if (show.seasons.length) open(pickIdx);
  return wrap;
}

function episodesBlock(eps) {
  return h("div", { class: "episodes" }, eps.map((e) => h("div", { class: "ep", role: "button", tabindex: "0", onclick: () => playVideo(e.id), onkeydown: (ev) => { if (ev.key === "Enter") playVideo(e.id); } },
    h("div", { class: "art" }, h("img", { src: img(e.id, "poster", 440), alt: "", loading: "lazy" }),
      e.mark.played ? h("div", { class: "card" }, h("div", { class: "tick", style: { position: "absolute", top: "6px", right: "6px" } }, "✓")) : null,
      e.mark.position > 30 && !e.mark.played && e.duration ? h("div", { class: "bar", style: { position: "absolute", left: 0, right: 0, bottom: 0, height: "4px", background: "rgba(0,0,0,.5)" } }, h("i", { style: { display: "block", height: "100%", width: `${(e.mark.position / e.duration) * 100}%`, background: "var(--accent)" } })) : null),
    h("div", {},
      h("div", { style: { fontWeight: "700" } }, `${e.episodeNo ?? ""}. ${e.title}`),
      h("div", { class: "muted small" }, [fmtRuntime(e.duration), e.premiered].filter(Boolean).join(" · ")),
      e.overview ? h("p", {}, e.overview) : null,
      h("a", { href: `#/item/${e.id}`, class: "small", style: { color: "var(--accent)" }, onclick: (ev) => ev.stopPropagation() }, "Details")))));
}

function trackList(tracks) {
  return h("div", { class: "list tracklist" }, tracks.map((t, n) => h("div", { class: "li click", onclick: () => music.play(tracks, n) },
    h("span", { class: "n" }, t.trackNo ?? n + 1), h("div", { class: "grow" }, h("div", {}, t.title), h("div", { class: "muted small" }, t.artist || "")),
    t.mark.heart ? h("span", {}, "❤") : null, h("span", { class: "muted small" }, fmtTime(t.duration)))));
}

async function addToMixtape(i) {
  const { mixtapes } = await api("GET", "/api/mixtapes");
  sheet("Add to a Mixtape", (b, close) => {
    const name = h("input", { type: "text", placeholder: "New mixtape name" });
    b.append(
      mixtapes.length ? h("div", { class: "list" }, mixtapes.map((m) => h("div", { class: "li click", onclick: () => act(async () => { await api("POST", "/api/mixtape/items", { mixtape: m.id, item: i.id }); close(); }, `Added to ${m.name}`) },
        h("div", { class: "grow" }, m.name), h("span", { class: "muted small" }, `${m.count}`)))) : null,
      h("label", { class: "field" }, h("span", {}, "Or start a new one"), name),
      h("button", { class: "btn primary", onclick: () => act(async () => { const { id } = await api("POST", "/api/mixtapes", { name: name.value || "New mixtape" }); await api("POST", "/api/mixtape/items", { mixtape: id, item: i.id }); close(); }, "Mixtape made") }, "Make mixtape"));
  });
}

async function addToSet(i) {
  const { sets } = await api("GET", "/api/sets");
  sheet("Add to a Set", (b, close) => {
    const name = h("input", { type: "text", placeholder: "e.g. Marvel, Christmas, Pixar" });
    b.append(h("p", { class: "muted" }, "Sets group things everyone on this server sees together."),
      sets.length ? h("div", { class: "list" }, sets.map((s) => h("div", { class: "li click", onclick: () => act(async () => { await api("POST", "/api/set/items", { set: s.id, item: i.id }); close(); }, `Added to ${s.name}`) }, h("div", { class: "grow" }, s.name), h("span", { class: "muted small" }, `${s.count}`)))) : null,
      h("label", { class: "field" }, h("span", {}, "New set"), name),
      h("button", { class: "btn primary", onclick: () => act(async () => { const { id } = await api("POST", "/api/sets", { name: name.value || "New set" }); await api("POST", "/api/set/items", { set: id, item: i.id }); close(); }, "Set made") }, "Make set"));
  });
}

// ---- Search, Hearts, Sets, Mixtapes ------------------------------------------------------------

export async function searchPage(q = "") {
  const input = h("input", { type: "search", placeholder: "Movies, shows, episodes, artists, songs…", value: q, "aria-label": "Search", autofocus: true });
  const results = h("div");
  let timer;
  const run = async () => {
    const text = input.value.trim();
    if (text.length < 2) { results.replaceChildren(h("div", { class: "empty" }, "Type at least two letters.")); return; }
    const { items } = await api("GET", `/api/search?q=${encodeURIComponent(text)}`);
    const by = (kinds) => items.filter((i) => kinds.includes(i.kind));
    results.replaceChildren(...[
      row("Movies & shows", by(["movie", "show"])), row("Episodes", by(["episode"]), { shape: "wide" }), row("Videos", by(["video"]), { shape: "wide" }),
      row("Artists", by(["artist"]), { shape: "square" }), row("Albums", by(["album"]), { shape: "square" }),
      by(["track"]).length ? h("section", { class: "row" }, h("h2", {}, "Songs"), trackList(by(["track"]))) : null,
    ].filter(Boolean));
    if (!items.length) results.replaceChildren(h("div", { class: "empty" }, `Nothing called “${text}”.`));
  };
  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(run, 250); });
  if (q) run();
  setTimeout(() => input.focus(), 0);
  return h("div", {}, h("h1", {}, "Search"), h("div", { class: "toolbar" }, input), results);
}

export async function heartsPage() {
  const { items } = await api("GET", "/api/hearts");
  if (!items.length) return h("div", {}, h("h1", {}, "Hearts"), h("div", { class: "empty" }, "Tap ♡ Heart on anything you love and it'll be here."));
  const by = (kinds) => items.filter((i) => kinds.includes(i.kind));
  return h("div", {}, h("h1", {}, "Hearts"), row("Movies & shows", by(["movie", "show"])), row("Episodes & videos", by(["episode", "video"]), { shape: "wide" }),
    row("Music", by(["album", "artist", "track"]), { shape: "square" }), row("Photos", by(["photo"]), { shape: "square" }));
}

export async function setsPage() {
  const { sets } = await api("GET", "/api/sets");
  return h("div", {}, h("h1", {}, "Sets"),
    sets.length ? h("div", { class: "grid" }, sets.map((s) => h("a", { class: "card", href: `#/set/${s.id}` },
      h("div", { class: "art" }, s.cover ? h("img", { src: img(s.cover, "poster", 260), alt: "", loading: "lazy" }) : h("div", { class: "ph" }, s.name)), h("div", { class: "t" }, s.name), h("div", { class: "s" }, `${s.count} items`))))
      : h("div", { class: "empty" }, "No sets yet. Films in the same series are grouped automatically when details come from TMDB; admins can make their own with “+ Set”."));
}
export async function setPage(id) {
  const s = await api("GET", `/api/set?id=${encodeURIComponent(id)}`);
  return h("div", {}, h("h1", {}, s.name), s.overview ? h("p", { class: "overview" }, s.overview) : null,
    state.me.admin ? h("div", { class: "btns" }, h("button", { class: "btn danger small", onclick: () => act(async () => { await api("DELETE", "/api/sets", { id }); go("#/sets"); }, "Set removed") }, "Delete set")) : null,
    h("div", { class: "grid" }, s.items.map((i) => card(i))));
}

export async function mixtapesPage() {
  const { mixtapes } = await api("GET", "/api/mixtapes");
  const name = h("input", { type: "text", placeholder: "New mixtape" });
  return h("div", {}, h("h1", {}, "Mixtapes"),
    h("div", { class: "toolbar" }, name, h("button", { class: "btn primary", onclick: () => act(async () => { const { id } = await api("POST", "/api/mixtapes", { name: name.value || "New mixtape" }); go(`#/mixtape/${id}`); }) }, "Make")),
    mixtapes.length ? h("div", { class: "list" }, mixtapes.map((m) => h("a", { class: "li click", href: `#/mixtape/${m.id}` }, h("span", {}, "🎞"), h("div", { class: "grow" }, h("div", { style: { fontWeight: "700" } }, m.name)), h("span", { class: "muted small" }, `${m.count} items`))))
      : h("div", { class: "empty" }, "Mixtapes are your own lists of songs, episodes or films. Add things with “+ Mixtape”."));
}
export async function mixtapePage(id) {
  const m = await api("GET", `/api/mixtape?id=${encodeURIComponent(id)}`);
  const tracks = m.items.filter((i) => i.kind === "track"), videos = m.items.filter((i) => i.kind !== "track");
  return h("div", {}, h("h1", {}, m.name),
    h("div", { class: "btns" },
      tracks.length ? h("button", { class: "btn primary", onclick: () => music.play(tracks, 0) }, "▶ Play songs") : null,
      videos.length ? h("button", { class: "btn primary", onclick: () => playVideo(videos[0].id, { start: 0, queue: videos.slice(1).map((v) => v.id) }) }, "▶ Play videos") : null,
      h("button", { class: "btn danger small", onclick: () => act(async () => { await api("DELETE", "/api/mixtapes", { id }); go("#/mixtapes"); }, "Mixtape deleted") }, "Delete")),
    m.items.length ? h("div", { class: "list" }, m.items.map((i, n) => h("div", { class: "li" },
      h("span", { class: "muted" }, String(n + 1)), h("div", { class: "grow click", style: { cursor: "pointer" }, onclick: () => (i.kind === "track" ? music.play(tracks, tracks.indexOf(i)) : playVideo(i.id)) },
        h("div", { style: { fontWeight: "600" } }, i.title), h("div", { class: "muted small" }, i.kind === "track" ? i.artist : i.kind === "episode" ? `${i.showTitle || ""} ${ep(i)}` : i.year || "")),
      h("button", { class: "iconbtn", "aria-label": "Remove", onclick: () => act(async () => { await api("POST", "/api/mixtape/items", { mixtape: id, item: i.id, remove: true }); go(`#/mixtape/${id}`); }) }, "✕"))))
      : h("div", { class: "empty" }, "Empty for now."));
}

// ---- Pair Code (sign in a TV from here) --------------------------------------------------------

export function pairPage() {
  const code = h("input", { type: "text", placeholder: "ABC123", maxlength: "8", style: { fontSize: "1.6rem", letterSpacing: ".2em", textTransform: "uppercase", textAlign: "center" }, autocapitalize: "characters" });
  return h("div", { style: { maxWidth: "460px" } }, h("h1", {}, "Pair Code"),
    h("p", {}, "Signing in a TV or another device? Choose “Use a Pair Code” on it, then type the code it shows here. It will be signed in as you."),
    code, h("div", { class: "btns" }, h("button", { class: "btn primary", onclick: () => act(async () => { const r = await api("POST", "/api/pair/approve", { code: code.value }); toast(`${r.device} is signed in as you`); code.value = ""; }) }, "Sign it in")));
}
