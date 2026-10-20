// Pictures for the screens: posters, backdrops, photo thumbnails and stills from videos without
// artwork. Shrunk once to a few standard widths with FFmpeg and cached, so phones never download a
// 4000-pixel poster to show it at 150.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { FF, run, grabImage } from "./probe.js";

const WIDTHS = [160, 320, 480, 800, 1280, 1920];
const pending = new Map(); // cache file → promise (two screens asking at once make one picture)

export function createImages({ cacheDir }) {
  const dir = path.join(cacheDir, "img");
  fs.mkdirSync(dir, { recursive: true });

  const sized = (w) => WIDTHS.find((x) => x >= (w || 480)) || WIDTHS.at(-1);

  async function once(out, make) {
    if (fs.existsSync(out)) return out;
    if (!pending.has(out)) pending.set(out, make().then(() => out, () => null).finally(() => pending.delete(out)));
    return pending.get(out);
  }

  /** A resized copy of an image file. */
  function resized(src, width) {
    let st;
    try { st = fs.statSync(src); } catch { return Promise.resolve(null); }
    const w = sized(width);
    const key = crypto.createHash("sha1").update(`${src}|${st.mtimeMs}|${w}`).digest("hex").slice(0, 24);
    const out = path.join(dir, `${key}.jpg`);
    return once(out, () => run(FF.ffmpeg, ["-v", "error", "-y", "-i", src, "-frames:v", "1", "-vf", `scale='min(${w},iw)':-2`, "-q:v", "4", out], { timeout: 30_000 }));
  }

  /**
   * The picture for an item: its poster/backdrop, the photo itself, or a still from the video.
   * which: "poster" | "backdrop". Falls back up the family (episode → season → show).
   */
  async function forItem(db, item, which, width) {
    let src = null;
    for (let cur = item, depth = 0; cur && depth < 3 && !src; cur = cur.parent_id ? db.get("SELECT * FROM items WHERE id = ?", cur.parent_id) : null, depth++) {
      if (which === "backdrop") src = cur.backdrop;
      else src = cur.poster || (cur.kind === "photo" ? cur.path : null);
      if (!src && which === "poster" && cur.kind === "folder") {
        const p = db.get("SELECT path FROM items WHERE parent_id = ? AND kind = 'photo' AND missing = 0 ORDER BY sort_title DESC LIMIT 1", cur.id)
          || db.get("SELECT f.path FROM items f JOIN items c ON f.parent_id = c.id WHERE c.parent_id = ? AND f.kind = 'photo' AND f.missing = 0 LIMIT 1", cur.id);
        if (p) src = p.path;
      }
      if (!src && which === "poster" && ["album"].includes(cur.kind)) {
        const t = db.get("SELECT path FROM items WHERE parent_id = ? AND kind = 'track' AND streams LIKE '%\"cover\":true%' LIMIT 1", cur.id);
        if (t) { const out = path.join(dir, `${cur.id}-cover.jpg`); src = await once(out, () => grabImage(t.path, out, { cover: true, width: 800 })); }
      }
      if (!src && (cur.kind === "video" || cur.kind === "episode" || cur.kind === "movie") && cur.path && which === "poster") {
        const out = path.join(dir, `${cur.id}-still.jpg`);
        src = await once(out, () => grabImage(cur.path, out, { at: Math.min(300, (cur.duration || 60) * 0.1), width: 800 }));
      }
      if (which === "backdrop" && cur.kind === "episode") continue;
    }
    if (!src && which === "backdrop") return null;
    return src ? resized(src, width) : null;
  }

  return { forItem, resized };
}
