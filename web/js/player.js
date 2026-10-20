// Watching and listening: the video player, the music bar, and the photo viewer.

import { h, api, mediaUrl, img, toast, fmtTime, deviceCaps, localGet, localSet, ep } from "./core.js";

const MODE_LABEL = { direct: "Direct", remux: "Repackaged", convert: "Converted" };

// ---- video ------------------------------------------------------------------------------------

/**
 * Plays an item full screen. opts: { start: seconds (null = resume where left off), queue: [ids] }.
 */
export async function playVideo(id, opts = {}) {
  // Inside the Android app: its own player plays it (more formats, TV remotes, picture-in-picture).
  if (window.CellovisionApp?.play) { music.pause(); window.CellovisionApp.play(id, opts.start ?? -1, (opts.queue || []).join(",")); return; }
  document.querySelector(".player")?.remove();
  music.pause();
  const item = await api("GET", `/api/item?id=${encodeURIComponent(id)}`);
  const caps = deviceCaps();
  const pick = { audio: null, sub: localGet("subs-off") === "1" ? null : undefined, burn: false };
  let plan = null, hls = null, offset = 0, ended = false, lastReport = 0, idleTimer = null, menu = null, nextBox = null;

  const video = h("video", { playsinline: true, autoplay: true, preload: "auto", crossorigin: "anonymous" });
  const spinner = h("div", { class: "spinner" });
  const msg = h("div", { class: "msg hidden" });
  const title = h("div", { class: "title" }, item.kind === "episode" ? `${item.parents.find((p) => p.kind === "show")?.title || ""} · ${ep(item)} · ${item.title}` : item.title);
  const badge = h("span", { class: "badge" });
  const timeEl = h("span", { class: "time" }, "0:00 / 0:00");
  const done = h("div", { class: "done" }), buf = h("div", { class: "buf" }), knob = h("div", { class: "knob" }), hover = h("div", { class: "hover hidden" });
  const seekBar = h("div", { class: "seek", role: "slider", "aria-label": "Position", tabindex: "0" }, h("div", { class: "track" }), buf, done, knob, hover);
  const playBtn = h("button", { "aria-label": "Play or pause", onclick: () => toggle() }, "⏸");
  const ctrl = h("div", { class: "controls" },
    playBtn,
    h("button", { "aria-label": "Back 10 seconds", onclick: () => seek(now() - 10) }, "⟲"),
    h("button", { "aria-label": "Forward 30 seconds", onclick: () => seek(now() + 30) }, "⟳"),
    timeEl, h("div", { class: "grow" }), badge,
    item.nextEpisode ? h("button", { "aria-label": "Next episode", title: "Next episode", onclick: () => nextUp(true) }, "⏭") : null,
    h("button", { "aria-label": "Subtitles and audio", title: "Subtitles, audio, quality", onclick: () => toggleMenu() }, "💬"),
    h("button", { "aria-label": "Full screen", onclick: () => fullscreen() }, "⛶"));
  const chrome = h("div", { class: "chrome" },
    h("div", { class: "top" }, h("button", { class: "iconbtn", style: { color: "#fff", fontSize: "24px" }, "aria-label": "Close", onclick: () => close() }, "←"), title),
    h("div", { class: "bottom" }, seekBar, ctrl));
  const box = h("div", { class: "player", tabindex: "-1" }, video, spinner, msg, chrome);
  document.body.append(box);
  box.focus();

  const duration = () => item.duration || (isFinite(video.duration) ? offset + video.duration : 0);
  const now = () => offset + (video.currentTime || 0);
  const isHls = () => plan && plan.mode !== "direct";

  async function load(at) {
    spinner.classList.remove("hidden"); msg.classList.add("hidden");
    const body = { id, caps, audio: pick.audio, sub: pick.sub === undefined ? null : pick.sub, burn: pick.burn };
    if (at !== null && at !== undefined) { body.start = at; body.hlsStart = at; }
    if (plan?.session) api("DELETE", "/api/hls", { session: plan.session }).catch(() => {});
    try { plan = await api("POST", "/api/play", body); }
    catch (e) { spinner.classList.add("hidden"); msg.textContent = e.message; msg.classList.remove("hidden"); return; }
    // First time: turn on subtitles in this person's language if the film is in another one.
    if (pick.sub === undefined) {
      pick.sub = null;
      const want = (navigator.language || "en").slice(0, 2);
      const forced = plan.tracks.subtitles.find((s) => s.forced && s.text);
      if (forced) { pick.sub = forced.key; return load(at); }
      void want;
    }
    badge.textContent = MODE_LABEL[plan.mode];
    badge.title = plan.reasons?.length ? `${MODE_LABEL[plan.mode]} because: ${plan.reasons.join(", ")}${plan.encoder ? ` (${plan.encoder})` : ""}` : "Playing the file as it is";
    offset = isHls() ? plan.start : 0;
    hls?.destroy(); hls = null;
    video.querySelectorAll("track").forEach((t) => t.remove());
    const src = mediaUrl(plan.url);
    if (isHls() && window.Hls?.isSupported()) {
      hls = new window.Hls({ maxBufferLength: 60, backBufferLength: 90, manifestLoadingMaxRetry: 8, levelLoadingMaxRetry: 8, fragLoadingMaxRetry: 8 });
      hls.loadSource(src); hls.attachMedia(video);
      hls.on(window.Hls.Events.ERROR, (_e, d) => { if (d.fatal) { msg.textContent = `Playback problem: ${d.details}`; msg.classList.remove("hidden"); } });
    } else video.src = src;
    if (plan.subtitle) setTrack(plan.subtitle);
    const resumeAt = plan.mode === "direct" ? (at ?? plan.resume ?? 0) : 0;
    video.addEventListener("loadedmetadata", () => { if (resumeAt > 0) video.currentTime = resumeAt; }, { once: true });
    video.play().catch(() => { playBtn.textContent = "▶"; });
  }

  function setTrack(url) {
    video.querySelectorAll("track").forEach((t) => t.remove());
    if (!url) return;
    const t = h("track", { kind: "subtitles", src: mediaUrl(url), default: true, srclang: "xx", label: "Subtitles" });
    video.append(t);
    t.addEventListener("load", () => { for (const tt of video.textTracks) tt.mode = "showing"; });
  }

  function seek(t) {
    t = Math.max(0, Math.min(t, duration() - 1));
    if (!isHls()) { video.currentTime = t; return; }
    const end = video.seekable.length ? video.seekable.end(video.seekable.length - 1) : 0;
    if (t >= offset && t <= offset + end - 1) video.currentTime = t - offset;
    else load(t); // further than converted so far: start converting from there
  }
  function toggle() { if (video.paused) video.play(); else video.pause(); }
  function fullscreen() { if (document.fullscreenElement) document.exitFullscreen(); else box.requestFullscreen?.().catch(() => {}); }

  function report(extra = {}) {
    if (!plan) return;
    lastReport = Date.now();
    api("POST", "/api/playing", { id, position: now(), paused: video.paused, mode: plan.mode, ...extra }).catch(() => {});
  }

  function drawTime() {
    const d = duration(), t = now();
    timeEl.textContent = `${fmtTime(t)} / ${fmtTime(d)}`;
    const pct = d ? (t / d) * 100 : 0;
    done.style.width = `${pct}%`; knob.style.left = `${pct}%`;
    if (video.buffered.length && d) buf.style.width = `${((offset + video.buffered.end(video.buffered.length - 1)) / d) * 100}%`;
    if (Date.now() - lastReport > 10_000 && !video.paused) report();
    // The last 30 seconds of an episode: offer the next one.
    if (item.nextEpisode && d && d - t < 30 && !nextBox && !ended) showNext();
  }

  function showNext() {
    const n = item.nextEpisode;
    let left = 15;
    const count = h("strong", {}, String(left));
    nextBox = h("div", { class: "next" }, h("div", { class: "small", style: { opacity: ".7" } }, "Up Next"), h("div", { style: { fontWeight: "800", margin: "4px 0" } }, `${ep(n)} · ${n.title}`),
      h("div", { class: "btns" }, h("button", { class: "btn primary small", onclick: () => nextUp(true) }, "Play now"), h("button", { class: "btn small", onclick: () => { clearInterval(tick); nextBox.remove(); } }, "Hide")),
      h("div", { class: "small", style: { opacity: ".7" } }, "Starts in ", count, " s"));
    box.append(nextBox);
    const tick = setInterval(() => { left--; count.textContent = String(left); if (left <= 0) { clearInterval(tick); nextUp(true); } }, 1000);
    nextBox.tick = tick;
  }
  function nextUp(go) {
    if (!go || !item.nextEpisode) return;
    clearInterval(nextBox?.tick);
    report({ position: duration() });
    const n = item.nextEpisode.id;
    close(true);
    playVideo(n, { start: 0 });
  }

  function toggleMenu() {
    if (menu) { menu.remove(); menu = null; return; }
    const t = plan?.tracks || { audio: [], subtitles: [] };
    const curAudio = pick.audio ?? t.audio.find((a) => a.default)?.index ?? t.audio[0]?.index;
    const label = (x) => [x.title, x.lang?.toUpperCase(), x.codec?.toUpperCase(), x.channels ? `${x.channels === 6 ? "5.1" : x.channels === 8 ? "7.1" : x.channels + "ch"}` : null, x.forced ? "forced" : null, x.sdh ? "SDH" : null].filter(Boolean).join(" · ") || "Track";
    const q = localGet("quality") || "auto";
    menu = h("div", { class: "pmenu" },
      h("h4", {}, "Subtitles"),
      h("button", { class: pick.sub === null ? "on" : "", onclick: () => { const burned = pick.burn; pick.sub = null; pick.burn = false; localSet("subs-off", "1"); toggleMenu(); if (burned) load(now()); else setTrack(null); } }, "Off"),
      t.subtitles.map((s) => h("button", { class: String(pick.sub) === s.key ? "on" : "", onclick: () => {
        const wasBurned = pick.burn;
        pick.sub = s.key; pick.burn = !s.text; localSet("subs-off", null); toggleMenu();
        // Text subtitles just swap the track; picture subtitles have to be burned into the video.
        if (s.text && !wasBurned) setTrack(`/api/subs/${id}/${s.key}.vtt${isHls() ? `?from=${offset}` : ""}`);
        else load(now());
      } }, `${label(s)}${s.text ? "" : " (burned in)"}`)),
      t.audio.length > 1 ? [h("h4", {}, "Audio"), t.audio.map((a) => h("button", { class: a.index === curAudio ? "on" : "", onclick: () => { pick.audio = a.index; toggleMenu(); load(now()); } }, label(a)))] : null,
      h("h4", {}, "Quality"),
      [["auto", "Best this device can play"], ["1080", "1080p"], ["720", "720p (saves data)"], ["480", "480p (slow connections)"]].map(([k, l]) =>
        h("button", { class: q === k ? "on" : "", onclick: () => { localSet("quality", k === "auto" ? null : k); caps.maxHeight = k === "auto" ? null : +k; toggleMenu(); load(now()); } }, l)));
    box.append(menu);
  }

  function close(skipReport = false) {
    if (!skipReport) report({ stopped: true });
    if (plan?.session) api("DELETE", "/api/hls", { session: plan.session }).catch(() => {});
    hls?.destroy();
    video.removeAttribute("src"); video.load();
    clearInterval(nextBox?.tick);
    box.remove();
    document.removeEventListener("keydown", keys);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    window.dispatchEvent(new Event("cv-player-closed"));
  }

  // events
  video.addEventListener("timeupdate", drawTime);
  video.addEventListener("playing", () => { spinner.classList.add("hidden"); playBtn.textContent = "⏸"; });
  video.addEventListener("waiting", () => spinner.classList.remove("hidden"));
  video.addEventListener("pause", () => { playBtn.textContent = "▶"; report(); });
  video.addEventListener("play", () => { playBtn.textContent = "⏸"; });
  video.addEventListener("ended", () => {
    // A converted stream "ends" where the conversion has got to only if it's really the end.
    if (isHls() && duration() - now() > 5) return;
    ended = true; report({ position: duration() });
    if (item.nextEpisode) nextUp(true);
    else if (opts.queue?.length) { const [n, ...rest] = opts.queue; close(true); playVideo(n, { start: 0, queue: rest }); }
    else close(true);
  });
  video.addEventListener("error", () => { if (!video.error || hls) return; msg.textContent = "This device couldn't play that. Converting it instead…"; msg.classList.remove("hidden"); caps.video = ["h264"]; caps.containers = ["mp4"]; load(now()); });
  const pos = (e) => { const r = seekBar.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * duration(); };
  seekBar.addEventListener("click", (e) => seek(pos(e)));
  seekBar.addEventListener("mousemove", (e) => { hover.textContent = fmtTime(pos(e)); hover.style.left = `${(pos(e) / (duration() || 1)) * 100}%`; hover.classList.remove("hidden"); });
  seekBar.addEventListener("mouseleave", () => hover.classList.add("hidden"));
  seekBar.addEventListener("keydown", (e) => { if (e.key === "ArrowLeft") { seek(now() - 10); e.preventDefault(); } if (e.key === "ArrowRight") { seek(now() + 10); e.preventDefault(); } });
  const wake = () => { box.classList.remove("idle"); clearTimeout(idleTimer); idleTimer = setTimeout(() => { if (!video.paused && !menu) box.classList.add("idle"); }, 3000); };
  box.addEventListener("mousemove", wake); box.addEventListener("touchstart", wake, { passive: true }); wake();
  video.addEventListener("click", () => toggle());
  video.addEventListener("dblclick", () => fullscreen());
  const keys = (e) => {
    if (e.target.tagName === "INPUT") return;
    wake();
    if (e.key === " " || e.key === "k") { toggle(); e.preventDefault(); }
    else if (e.key === "ArrowLeft" && e.target !== seekBar) seek(now() - 10);
    else if (e.key === "ArrowRight" && e.target !== seekBar) seek(now() + 10);
    else if (e.key === "f") fullscreen();
    else if (e.key === "m") video.muted = !video.muted;
    else if (e.key === "Escape" && !document.fullscreenElement) { if (menu) toggleMenu(); else close(); }
    else if (e.key === "MediaTrackNext" || e.key === "N") nextUp(true);
  };
  document.addEventListener("keydown", keys);

  await load(opts.start ?? null);
}

// ---- music ------------------------------------------------------------------------------------

export const music = (() => {
  const audio = new Audio();
  audio.preload = "auto";
  let queue = [], at = 0, bar = null, hls = null, current = null, lastReport = 0, shuffle = false, offset = 0;
  const caps = { ...deviceCaps(), video: [] };

  function draw() {
    if (!current) { bar?.remove(); bar = null; return; }
    const seek = h("input", { type: "range", min: "0", max: String(Math.round(current.duration || 0)), value: String(Math.round(offset + audio.currentTime)), "aria-label": "Position",
      oninput: (e) => { audio.currentTime = Math.max(0, +e.target.value - offset); } });
    const ui = h("div", { class: "musicbar" },
      h("img", { src: img(current.parentId || current.id, "poster", 96), alt: "", onerror: (e) => { e.target.style.visibility = "hidden"; } }),
      h("div", { class: "meta" }, h("div", { style: { fontWeight: "700" } }, current.title), h("div", { class: "muted small" }, [current.artist, current.album].filter(Boolean).join(" · "))),
      h("div", { class: "mid" },
        h("div", { class: "ctr" },
          h("button", { class: `iconbtn${shuffle ? " on" : ""}`, title: "Shuffle", "aria-pressed": String(shuffle), onclick: () => { shuffle = !shuffle; draw(); } }, "🔀"),
          h("button", { class: "iconbtn", "aria-label": "Previous", onclick: () => prev() }, "⏮"),
          h("button", { class: "iconbtn", "aria-label": audio.paused ? "Play" : "Pause", style: { fontSize: "26px" }, onclick: () => (audio.paused ? audio.play() : audio.pause()) }, audio.paused ? "▶" : "⏸"),
          h("button", { class: "iconbtn", "aria-label": "Next", onclick: () => next() }, "⏭")),
        seek,
        h("div", { class: "muted small" }, `${fmtTime(offset + audio.currentTime)} / ${fmtTime(current.duration)} · ${at + 1} of ${queue.length}`)),
      h("button", { class: "iconbtn", "aria-label": "Stop music", onclick: () => stop() }, "✕"));
    if (bar) bar.replaceWith(ui); else document.body.append(ui);
    bar = ui;
  }

  async function start(i) {
    at = i; current = queue[at];
    hls?.destroy(); hls = null;
    try {
      const plan = await api("POST", "/api/play", { id: current.id, caps });
      offset = plan.mode === "direct" ? 0 : plan.start;
      const src = mediaUrl(plan.url);
      if (plan.mode !== "direct" && window.Hls?.isSupported()) { hls = new window.Hls(); hls.loadSource(src); hls.attachMedia(audio); }
      else audio.src = src;
      await audio.play().catch(() => {});
    } catch (e) { toast(e.message, true); }
    draw();
    if ("mediaSession" in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({ title: current.title, artist: current.artist || "", album: current.album || "", artwork: [{ src: img(current.parentId || current.id, "poster", 512), sizes: "512x512", type: "image/jpeg" }] });
      navigator.mediaSession.setActionHandler("nexttrack", () => next());
      navigator.mediaSession.setActionHandler("previoustrack", () => prev());
    }
  }
  function next() {
    if (!queue.length) return;
    report(true);
    const n = shuffle ? Math.floor(Math.random() * queue.length) : at + 1;
    if (n >= queue.length) { stop(); return; }
    start(n);
  }
  function prev() { if (offset + audio.currentTime > 4) audio.currentTime = 0; else if (at > 0) start(at - 1); }
  function stop() { report(false, true); audio.pause(); hls?.destroy(); audio.removeAttribute("src"); current = null; queue = []; draw(); }
  function report(finished = false, stopped = false) {
    if (!current) return;
    lastReport = Date.now();
    api("POST", "/api/playing", { id: current.id, position: finished ? current.duration || 0 : offset + audio.currentTime, paused: audio.paused, mode: "music", stopped }).catch(() => {});
  }
  audio.addEventListener("ended", () => next());
  audio.addEventListener("timeupdate", () => { if (bar) { const r = bar.querySelector("input[type=range]"); if (r && document.activeElement !== r) r.value = String(Math.round(offset + audio.currentTime)); const s = bar.querySelector(".mid .muted"); if (s) s.textContent = `${fmtTime(offset + audio.currentTime)} / ${fmtTime(current?.duration)} · ${at + 1} of ${queue.length}`; } if (Date.now() - lastReport > 15_000 && !audio.paused) report(); });
  audio.addEventListener("play", draw); audio.addEventListener("pause", draw);

  return {
    /** Plays a list of tracks (from an album, artist, mixtape or search), starting at `index`. */
    play(tracks, index = 0) { queue = tracks.filter((t) => t.kind === "track"); if (!queue.length) return; start(Math.max(0, Math.min(index, queue.length - 1))); },
    add(tracks) { queue.push(...tracks.filter((t) => t.kind === "track")); draw(); toast(`Added ${tracks.length} to the queue`); },
    pause() { if (!audio.paused) audio.pause(); },
    get playing() { return current; },
  };
})();

// ---- photos -----------------------------------------------------------------------------------

export function viewPhotos(list, index) {
  const photos = list.filter((p) => p.kind === "photo" || p.kind === "video");
  let at = Math.max(0, photos.findIndex((p) => p.id === list[index]?.id));
  const pic = h("img", { alt: "" });
  const cap = h("div", { style: { position: "absolute", bottom: "18px", left: "0", right: "0", textAlign: "center", color: "#fff", opacity: ".8" } });
  const box = h("div", { class: "lightbox", tabindex: "-1" }, pic, cap,
    h("button", { class: "iconbtn", style: { top: "14px", right: "18px" }, "aria-label": "Close", onclick: () => close() }, "✕"),
    h("button", { class: "iconbtn", style: { left: "14px", top: "50%" }, "aria-label": "Previous", onclick: () => show(at - 1) }, "‹"),
    h("button", { class: "iconbtn", style: { right: "14px", top: "50%" }, "aria-label": "Next", onclick: () => show(at + 1) }, "›"));
  function show(i) {
    at = (i + photos.length) % photos.length;
    const p = photos[at];
    if (p.kind === "video") { close(); playVideo(p.id); return; }
    pic.src = img(p.id, "poster", 1920);
    cap.textContent = `${p.title} · ${at + 1} of ${photos.length}${p.premiered ? ` · ${p.premiered}` : ""}`;
  }
  const keys = (e) => { if (e.key === "ArrowLeft") show(at - 1); else if (e.key === "ArrowRight") show(at + 1); else if (e.key === "Escape") close(); };
  function close() { box.remove(); document.removeEventListener("keydown", keys); }
  let touchX = null;
  box.addEventListener("touchstart", (e) => { touchX = e.touches[0].clientX; }, { passive: true });
  box.addEventListener("touchend", (e) => { if (touchX === null) return; const dx = e.changedTouches[0].clientX - touchX; if (Math.abs(dx) > 50) show(at + (dx < 0 ? 1 : -1)); touchX = null; });
  document.addEventListener("keydown", keys);
  document.body.append(box);
  box.focus();
  show(at);
}
