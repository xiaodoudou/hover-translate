import {
  ALL_BLOCK_TAGS,
  EXCLUDE_TAGS,
  HOVER_EXCLUDE_SELECTOR,
  BLOCK_MAX_TEXT,
  BLOCK_MIN_TEXT,
} from "../lib/rules.js";

const MAX_CLIMB = 12;

// A <pre> is refused because it usually holds code, where rewriting the words would be wrong and
// the whitespace is load bearing. It is not always code, though: chat clients render messages into
// one, Taobao's among them, and refusing those means refusing every message in the conversation.
// A nested <code> settles it outright; failing that the font does, since a browser renders <pre> in
// monospace unless the page has deliberately styled it as prose.
const MONOSPACE = /\bmonospace\b|\bconsolas\b|\bmenlo\b|\bmonaco\b|\bcourier\b|\bui-monospace\b|mono\b/i;

function isCodeBlock(el) {
  if (el.querySelector("code")) return true;
  try {
    return MONOSPACE.test(getComputedStyle(el).fontFamily || "");
  } catch {
    // Unstyled, so the browser default of monospace stands: treat it as code.
    return true;
  }
}

// True if the node sits anywhere inside something we must never rewrite.
function isExcluded(el) {
  for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
    if (n.tagName === "PRE" ? isCodeBlock(n) : EXCLUDE_TAGS.has(n.tagName)) return true;
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

// Tags that carry a passage of their own, as opposed to the many block-level tags that are really
// controls or decoration. Only these count towards deciding that an element is a layout wrapper: a
// table cell holding a label is still a cell, but a div holding a header, an article and a footer
// is not something anyone meant to point at.
const STRUCTURAL_TAGS = new Set([
  "DIV", "P", "SECTION", "ARTICLE", "ASIDE", "HEADER", "FOOTER", "MAIN", "NAV", "BLOCKQUOTE",
  "UL", "OL", "LI", "DL", "DD", "DT", "TABLE", "TBODY", "TR", "FIGURE", "FORM", "ADDRESS",
  "H1", "H2", "H3", "H4", "H5", "H6",
]);

// True when the element holds no words of its own and several structural children that do. The
// pointer was over the gap between them rather than over a paragraph. Its own loose text is what
// tells the two apart: a list item carrying a sentence and a nested list is still a sentence.
function isWrapper(el) {
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE && node.nodeValue.trim().length >= BLOCK_MIN_TEXT) {
      return false;
    }
  }
  let passages = 0;
  for (const child of el.children) {
    if (!STRUCTURAL_TAGS.has(child.tagName)) continue;
    if ((child.innerText || "").trim().length < BLOCK_MIN_TEXT) continue;
    // One child is just a wrapper around the same passage, and translating it reads the same.
    if (++passages > 1) return true;
  }
  return false;
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
    // Climbing past a wrapper only reaches bigger wrappers, so this refuses rather than continues.
    if (isWrapper(el)) return null;
    return el;
  }
  return null;
}
