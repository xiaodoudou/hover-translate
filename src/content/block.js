import {
  ALL_BLOCK_TAGS,
  INLINE_TAGS,
  EXCLUDE_TAGS,
  HOVER_EXCLUDE_SELECTOR,
  BLOCK_MAX_TEXT,
  BLOCK_MIN_TEXT,
  tagOf,
} from "../lib/rules.js";
import { scriptsIn } from "../lib/script.js";

const MAX_CLIMB = 12;

// A minimum length keeps a stray letter or a bullet from being a target, but it is a Latin habit:
// scripts that do not space their words write whole words in one character, and a menu of them was
// unreachable. One Han character is a word; one Latin letter is not.
const UNSPACED = new Set(["han", "kana", "hangul"]);
const enoughText = (text) =>
  text.length >= BLOCK_MIN_TEXT || scriptsIn(text).some((script) => UNSPACED.has(script));

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
  // aria-hidden marks decoration, so the element under the pointer is taken at its word. It is not
  // allowed to speak for everything beneath it, though: pages carry it on whole regions they are
  // still drawing. A dialog marks the page behind it aria-hidden while leaving it on screen, and
  // Taobao's shop sidebar marks every category panel aria-hidden while showing it expanded, which
  // refused every row in it.
  if (el.getAttribute("aria-hidden") === "true") return true;

  for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
    if (tagOf(n) === "PRE" ? isCodeBlock(n) : EXCLUDE_TAGS.has(tagOf(n))) return true;
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

// A child that lays itself out as a block and carries words. Layout decides this, not a tag list:
// a container's children are routinely custom elements, and on GitHub the entire conversation sits
// inside <react-partial> and <rails-partial>, which no list of tag names would ever name. A label
// or a badge inside a table cell stays inline and so does not count.
function isPassage(el) {
  if (!enoughText((el.innerText || "").trim())) return false;
  // A flex or grid parent blockifies whatever it holds, so a row of links reports display:block
  // and would otherwise read as a stack of paragraphs. Taobao's hot-word row is exactly that.
  // For something inline by nature the tag is the honest answer and the computed display is not.
  if (INLINE_TAGS.has(tagOf(el))) return false;
  let display = "";
  try {
    display = getComputedStyle(el).display;
  } catch {
    return ALL_BLOCK_TAGS.has(tagOf(el));
  }
  return Boolean(display) && display !== "none" && !display.startsWith("inline");
}

// True when the element holds no words of its own and several block children that do. The pointer
// was over the gap between them rather than over a paragraph. Its own loose text is what tells the
// two apart: a list item carrying a sentence and a nested list is still a sentence.
//
// The answer has to be looked for downwards. A lone block child is the same passage wearing another
// box, so the question just moves into it, and modern pages stack a dozen of those between the
// container and the content. Counting only direct children let a whole page through whenever each
// layer happened to have exactly one child.
function isWrapper(el) {
  for (let n = el, depth = 0; n && depth < MAX_CLIMB; depth++) {
    for (const node of n.childNodes) {
      if (node.nodeType === Node.TEXT_NODE && node.nodeValue.trim().length >= BLOCK_MIN_TEXT) {
        return false;
      }
    }
    let only = null;
    for (const child of n.children) {
      if (!isPassage(child)) continue;
      // Two passages side by side: the pointer was between them, not on either one.
      if (only) return true;
      only = child;
    }
    if (!only) return false;
    n = only;
  }
  return false;
}

// Walks up from the hovered node to the paragraph-sized element the user meant to point at.
// Returns null when nothing under the cursor is safe or worth translating.
export function resolveBlock(node) {
  let el = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  if (!(el instanceof Element)) return null;
  if (isExcluded(el)) return null;

  // Only an element that could be the answer counts towards the limit. A paragraph routinely sits a
  // dozen spans above its own text node, and counting those hops put it out of reach entirely.
  for (let seen = 0; el && seen < MAX_CLIMB; el = el.parentElement) {
    if (el === document.body || el === document.documentElement) break;
    // The tag list names what pages are usually built from; layout answers for everything else. A
    // feed of custom elements has no tag this list will ever name, and gating on the list alone
    // walked straight past the post the pointer was on and offered the whole feed instead.
    if (!ALL_BLOCK_TAGS.has(tagOf(el)) && !isPassage(el)) continue;
    seen++;

    const text = (el.innerText || "").trim();
    if (!enoughText(text)) continue;
    // A block this big is a container, not a paragraph: refuse rather than rewrite half the page.
    if (text.length > BLOCK_MAX_TEXT) return null;
    // Climbing past a wrapper only reaches bigger wrappers, so this refuses rather than continues.
    if (isWrapper(el)) return null;
    return el;
  }
  return null;
}
