import {
  ATTR_STATE,
  CLASS_AIM,
  CLASS_TRANSLATED,
  CLASS_BILINGUAL,
  CLASS_PENDING,
  CLASS_ERROR,
} from "../lib/rules.js";
import { markOverflow, clearOverflow } from "./marquee.js";

// How to put each block back, as a closure: the two apply paths undo differently.
const undos = new WeakMap();
// Original child nodes, kept alive by reference so the rebuild path restores identity, not a copy.
const saved = new WeakMap();
const translated = new Set();
// The blocks whose own text was rewritten, so a line of theirs that no longer fits is ours to deal
// with. Bilingual mode is deliberately not among them: it adds a line and leaves the page's alone.
const replaced = new Set();

export function isTranslated(el) {
  return el.getAttribute(ATTR_STATE) === "translated";
}

// Must run before anything mutates the block, including markPending() appending the spinner.
export function snapshot(block) {
  if (!saved.has(block)) saved.set(block, Array.from(block.childNodes));
}

export function discardSnapshot(block) {
  if (!isTranslated(block)) {
    saved.delete(block);
    undos.delete(block);
  }
}

// Both states are a class and nothing else: no node is appended, so a reactive page never sees the
// extension touch its tree while a translation is in flight.
export function markPending(block) {
  block.classList.remove(CLASS_ERROR);
  block.classList.add(CLASS_PENDING);
}

export function clearPending(block) {
  block.classList.remove(CLASS_PENDING);
}

export function markError(block) {
  block.classList.remove(CLASS_PENDING);
  block.classList.add(CLASS_ERROR);
  setTimeout(() => {
    block.classList.remove(CLASS_ERROR);
    if (block.getAttribute("class") === "") block.removeAttribute("class");
  }, 1600);
}

// What the trigger would act on, while the key is held. Exactly the block that would be translated,
// so where nothing is outlined nothing would happen: the absence is as much of an answer as the
// outline. One element at a time, and the class is the whole of it.
let aiming = null;

export function aim(block) {
  if (aiming === block) return;
  clearAim();
  if (!block) return;
  aiming = block;
  block.classList.add(CLASS_AIM);
}

export function clearAim() {
  if (!aiming) return;
  aiming.classList.remove(CLASS_AIM);
  if (aiming.getAttribute("class") === "") aiming.removeAttribute("class");
  aiming = null;
}

// Purely visual markers for the modes that replace the text. Each is chosen because it costs no
// layout at all: an outline is painted outside the box, a text decoration inside the line box.
const MARKERS = {
  outlined: "ht-mark-outline",
  underlined: "ht-mark-underline",
  dashed: "ht-mark-dashed",
};
const MARKER_CLASSES = Object.values(MARKERS);
let markerClass = "";

export function setMarker(mode) {
  markerClass = MARKERS[mode] || "";
}

function mark(block) {
  block.setAttribute(ATTR_STATE, "translated");
  block.classList.add(CLASS_TRANSLATED);
  if (markerClass) block.classList.add(markerClass);
  translated.add(block);
}

// Text-only path: the DOM is untouched, so undo is just putting the old strings back.
export function applyEdits(block, edits) {
  undos.set(block, () => {
    for (let i = edits.length - 1; i >= 0; i--) edits[i][0].nodeValue = edits[i][1];
  });
  mark(block);
  replaced.add(block);
  markOverflow(block);
}

// Bubble mode: the page is not touched at all, so the only thing to undo is dismissing the overlay.
// Bilingual: the original is untouched and the translation is added after it as text.
// A span rather than a div, because this goes inside a <p>, a <td> or an <li> just the same, and
// CSS gives it its own line. Text only: cloning the subtree would duplicate ids and form controls.
const LAID_OUT = new Set(["flex", "inline-flex", "grid", "inline-grid"]);
// Parents where a stray span between the children would be invalid or dropped by the parser.
const NO_SIBLING = new Set(["TR", "TBODY", "THEAD", "TFOOT", "TABLE", "UL", "OL", "DL", "SELECT"]);

export function applyBoth(block, text) {
  const holder = document.createElement("span");
  holder.className = CLASS_BILINGUAL;
  holder.setAttribute("data-ht-ui", "");
  holder.textContent = text;

  // Inside a flex or grid block the holder would become another item on the same row, and
  // flex-wrap defaults to nowrap so no width can push it onto a line of its own. In that case it
  // goes after the block instead, where the normal flow puts it under the original as intended.
  const laidOut = LAID_OUT.has(getComputedStyle(block).display);
  if (laidOut && block.parentElement && !NO_SIBLING.has(block.parentElement.tagName)) {
    block.after(holder);
  } else {
    block.append(holder);
  }

  undos.set(block, () => holder.remove());
  mark(block);
}

// Node-replacing path, used only when editing text cannot express the translation.
export function apply(block, content) {
  snapshot(block);
  const nodes = saved.get(block);
  undos.set(block, () => block.replaceChildren(...nodes));
  block.replaceChildren(content);
  mark(block);
  replaced.add(block);
  markOverflow(block);
}

// Whatever is already translated follows the setting straight away, rather than waiting for the
// next block to be translated before it looks right.
export function refreshOverflow() {
  for (const block of replaced) {
    clearOverflow(block);
    markOverflow(block);
  }
}

export function revert(block) {
  const undo = undos.get(block);
  if (!undo) return false;
  if (aiming === block) clearAim();
  clearOverflow(block);
  undo();
  undos.delete(block);
  saved.delete(block);
  translated.delete(block);
  replaced.delete(block);
  block.removeAttribute(ATTR_STATE);
  block.classList.remove(CLASS_TRANSLATED, CLASS_PENDING, CLASS_ERROR, ...MARKER_CLASSES);
  if (block.getAttribute("class") === "") block.removeAttribute("class");
  return true;
}

export function revertAll() {
  const count = translated.size;
  for (const block of Array.from(translated)) revert(block);
  return count;
}
