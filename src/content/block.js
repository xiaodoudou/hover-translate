import {
  ALL_BLOCK_TAGS,
  EXCLUDE_TAGS,
  HOVER_EXCLUDE_SELECTOR,
  BLOCK_MAX_TEXT,
  BLOCK_MIN_TEXT,
} from "../lib/rules.js";

const MAX_CLIMB = 12;

// True if the node sits anywhere inside something we must never rewrite.
function isExcluded(el) {
  for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
    if (EXCLUDE_TAGS.has(n.tagName)) return true;
    if (n.isContentEditable) return true;
    // Text this extension added itself, such as the bilingual line. Never a translation target.
    if (n.hasAttribute("data-ht-ui")) return true;
  }
  try {
    return Boolean(el.closest(HOVER_EXCLUDE_SELECTOR));
  } catch {
    return false;
  }
}

// Walks up from the hovered node to the paragraph-sized element the user meant to point at.
// Returns null when nothing under the cursor is safe or worth translating.
export function resolveBlock(node) {
  let el = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  if (!(el instanceof Element)) return null;
  if (isExcluded(el)) return null;

  for (let depth = 0; el && depth < MAX_CLIMB; el = el.parentElement, depth++) {
    if (el === document.body || el === document.documentElement) break;
    if (!ALL_BLOCK_TAGS.has(el.tagName)) continue;

    const text = (el.innerText || "").trim();
    if (text.length < BLOCK_MIN_TEXT) continue;
    // A block this big is a container, not a paragraph: refuse rather than rewrite half the page.
    if (text.length > BLOCK_MAX_TEXT) return null;
    return el;
  }
  return null;
}
