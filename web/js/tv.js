// TV remotes: the arrow keys move between whatever can be picked on screen (the nearest thing in
// that direction), OK picks it. Switched on by the Android TV app (and by ?tv=1 for testing).

const PICKABLE = "a[href], button:not([disabled]), input, select, textarea, [tabindex='0'], .card";

function visible(el) {
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return false;
  const s = getComputedStyle(el);
  return s.visibility !== "hidden" && s.display !== "none" && !el.closest(".hidden");
}

function candidates() {
  // Inside an open pop-up (sheet, player menu, photo viewer), stay inside it.
  const scope = document.querySelector(".sheet-bg, .lightbox, .player .pmenu") || document;
  return [...scope.querySelectorAll(PICKABLE)].filter(visible);
}

function move(dir) {
  const from = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
  const list = candidates();
  if (!from) { list[0]?.focus(); return; }
  const a = from.getBoundingClientRect();
  const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
  let best = null, bestScore = Infinity;
  for (const el of list) {
    if (el === from || from.contains(el) || el.contains(from)) continue;
    const b = el.getBoundingClientRect();
    const bx = b.left + b.width / 2, by = b.top + b.height / 2;
    const dx = bx - ax, dy = by - ay;
    const ok = dir === "right" ? b.left >= a.right - 4 : dir === "left" ? b.right <= a.left + 4 : dir === "down" ? b.top >= a.bottom - 4 : b.bottom <= a.top + 4;
    if (!ok) continue;
    // Mostly along the direction; sideways distance costs more (stay in the same row/column).
    const along = dir === "left" || dir === "right" ? Math.abs(dx) : Math.abs(dy);
    const across = dir === "left" || dir === "right" ? Math.abs(dy) : Math.abs(dx);
    const score = along + across * 3;
    if (score < bestScore) { bestScore = score; best = el; }
  }
  if (best) { best.focus({ preventScroll: true }); best.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" }); }
}

export function enableTv() {
  document.documentElement.classList.add("tv");
  document.addEventListener("keydown", (e) => {
    const dir = { ArrowRight: "right", ArrowLeft: "left", ArrowDown: "down", ArrowUp: "up" }[e.key];
    if (!dir) return;
    const t = document.activeElement;
    // Typing in a box: left/right move the text cursor; the video player has its own arrow keys.
    if ((t?.tagName === "INPUT" || t?.tagName === "TEXTAREA") && (dir === "left" || dir === "right")) return;
    if (document.querySelector(".player") && !document.querySelector(".player .pmenu")) return;
    e.preventDefault();
    move(dir);
  }, true);
  // Something is always picked, so the remote does something on the first press.
  const ensure = () => { if (!document.activeElement || document.activeElement === document.body) candidates().find((el) => el.closest("main"))?.focus(); };
  new MutationObserver(() => setTimeout(ensure, 50)).observe(document.body, { childList: true, subtree: false });
  window.addEventListener("hashchange", () => setTimeout(ensure, 300));
  setTimeout(ensure, 500);
}
