// Words in an image are pixels, so they cannot be rewritten the way text is. Each recognised line is
// painted over its own box instead, in a closed shadow root anchored above the image: the page's own
// DOM is never touched, exactly as in bubble mode.

const overlays = new Map();
const pending = new Map();
let watching = false;

// The hovered <img>, or the one inside the hovered <picture>. No climbing: a container with a
// decorative background must still resolve to its text, not to the decoration.
export function resolveImage(target) {
  const el = target?.nodeType === Node.TEXT_NODE ? target.parentElement : target;
  if (!(el instanceof Element)) return null;
  if (el.tagName === "IMG") return el;
  if (el.tagName === "PICTURE") return el.querySelector("img");
  return null;
}

// currentSrc reflects the srcset choice actually on screen; src is the fallback. data: and blob:
// sources are fine here, since the bytes are read locally rather than handed to a remote service.
export function imageUrl(img) {
  return img?.currentSrc || img?.src || null;
}

// Only the worker can reach a cross-origin image, and only once the host permission is granted.
// This is the fallback for everything else, and the one path a same-origin image needs.
export async function readImage(img) {
  const response = await fetch(imageUrl(img), { credentials: "omit" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("could not read the image"));
    reader.readAsDataURL(blob);
  });
}

const CSS = `
  .w { position: relative; width: 100%; height: 100%; }
  .shot { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }

  /* The same sweep the text path uses, but drawn on top and in the middle. On a block the gradient
     can be a painted background; over an opaque image it would be hidden behind the pixels, so it
     needs its own bar. Centred rather than on the bottom edge, where it reads as part of the image.
     The translucent track underneath keeps it legible on a light image and a dark one alike. */
  .bar {
    position: absolute;
    top: 50%; left: 0; right: 0;
    transform: translateY(-50%);
    height: 4px;
    /* The dark track alone disappears into a mid-tone image, so it carries a pale hairline: one of
       the two always has contrast, whatever is underneath. */
    background-color: rgba(15, 23, 42, 0.55);
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.55);
    background-image: linear-gradient(
      90deg,
      rgba(14, 165, 233, 0) 0%,
      rgba(56, 189, 248, 0.9) 35%,
      rgba(14, 165, 233, 1) 50%,
      rgba(56, 189, 248, 0.9) 65%,
      rgba(14, 165, 233, 0) 100%
    );
    background-repeat: no-repeat;
    background-size: 45% 100%;
    background-position: -35% 0;
    animation: ht-img-sweep 1.1s linear infinite;
  }
  @keyframes ht-img-sweep {
    from { background-position: -35% 0; }
    to   { background-position: 135% 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    .bar { animation: none; background-size: 100% 100%; background-position: 0 0; }
  }
  .l {
    position: absolute;
    display: flex; align-items: center;
    overflow: hidden; white-space: nowrap;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    line-height: 1;
    padding: 0 1px;
    box-sizing: border-box;
  }
`;

// The recogniser works in the image's own pixels, which is not what is on screen once the page has
// scaled it. Everything is placed in natural-size coordinates and the whole overlay is scaled once.
function place(wrap, lines, scaleX, scaleY) {
  const cells = [];
  for (const line of lines) {
    const cell = document.createElement("div");
    cell.className = "l";
    cell.style.left = `${line.x * scaleX}px`;
    cell.style.top = `${line.y * scaleY}px`;
    cell.style.width = `${line.w * scaleX}px`;
    cell.style.height = `${line.h * scaleY}px`;
    if (line.background) cell.style.background = line.background;
    if (line.color) cell.style.color = line.color;
    cell.style.fontSize = `${Math.max(6, line.h * scaleY * 0.82)}px`;
    cell.textContent = line.text;
    wrap.append(cell);
    cells.push(cell);
  }

  // Translated text is usually longer than what it replaces, so it is shrunk until it fits. The
  // first guess comes from the overflow ratio; the loop only cleans up what rounding left over.
  for (const cell of cells) {
    if (cell.scrollWidth <= cell.clientWidth) continue;
    const size = parseFloat(cell.style.fontSize);
    let next = Math.max(6, Math.floor(size * (cell.clientWidth / cell.scrollWidth)));
    cell.style.fontSize = `${next}px`;
    for (let guard = 0; guard < 12 && cell.scrollWidth > cell.clientWidth && next > 6; guard++) {
      next -= 1;
      cell.style.fontSize = `${next}px`;
    }
  }
}

function position(img, host) {
  const rect = img.getBoundingClientRect();
  host.style.left = `${rect.left + scrollX}px`;
  host.style.top = `${rect.top + scrollY}px`;
  host.style.width = `${rect.width}px`;
  host.style.height = `${rect.height}px`;
}

// One listener for every overlay: images move together when the page scrolls or reflows.
function watch() {
  if (watching) return;
  watching = true;
  const sync = () => {
    for (const map of [overlays, pending]) {
      for (const [img, host] of map) {
        if (!img.isConnected) {
          host.remove();
          map.delete(img);
        } else {
          position(img, host);
        }
      }
    }
  };
  addEventListener("scroll", sync, { capture: true, passive: true });
  addEventListener("resize", sync, { passive: true });
}

// Anchored over the image and sealed, so no page stylesheet reaches in and nothing leaks out.
function makeHost(img, kind) {
  const host = document.createElement("div");
  // Valued rather than bare, so an overlay is tellable from the toast and the bubble, which are
  // also body-level data-ht-ui hosts.
  host.setAttribute("data-ht-ui", kind);
  host.style.cssText = "all:initial;position:absolute;z-index:2147483645;pointer-events:none;";
  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = CSS;
  const wrap = document.createElement("div");
  wrap.className = "w";
  shadow.append(style, wrap);
  position(img, host);
  (document.body || document.documentElement).append(host);
  watch();
  return { host, wrap };
}

// Shown the moment the trigger fires, so an image that takes a second to read says so.
export function showImagePending(img) {
  hideImagePending(img);
  const rect = img.getBoundingClientRect();
  if (!rect.width || !rect.height) return false;

  const { host, wrap } = makeHost(img, "image-pending");
  const bar = document.createElement("div");
  bar.className = "bar";
  wrap.append(bar);
  pending.set(img, host);
  return true;
}

export function hideImagePending(img) {
  const host = pending.get(img);
  if (!host) return false;
  host.remove();
  pending.delete(img);
  return true;
}

// `result` is either { lines } to paint over each recognised line, or { image } when the provider
// returned a finished picture of its own and there is nothing to lay out.
export function showImageOverlay(img, result) {
  hideImagePending(img);
  hideImageOverlay(img);

  const rect = img.getBoundingClientRect();
  const naturalWidth = img.naturalWidth || rect.width;
  const naturalHeight = img.naturalHeight || rect.height;
  if (!rect.width || !rect.height || !naturalWidth || !naturalHeight) return false;

  const { host, wrap } = makeHost(img, "image");

  if (result.image) {
    const shot = document.createElement("img");
    shot.className = "shot";
    shot.src = result.image;
    shot.alt = "";
    wrap.append(shot);
  } else {
    place(wrap, result.lines, rect.width / naturalWidth, rect.height / naturalHeight);
  }

  overlays.set(img, host);
  return true;
}

export function hideImageOverlay(img) {
  const host = overlays.get(img);
  if (!host) return false;
  host.remove();
  overlays.delete(img);
  return true;
}

export function hideAllImageOverlays() {
  const count = overlays.size;
  for (const img of Array.from(overlays.keys())) hideImageOverlay(img);
  return count;
}

export const hasImageOverlay = (img) => overlays.has(img);
