import { EXCLUDE_TAGS, STAY_ORIGINAL_TAGS } from "../lib/rules.js";
import { escapeText } from "../lib/entities.js";

// Serialises a block into numbered <bN>…</bN> tags, sends it as one string, and rebuilds the block
// from the reply. Every element keeps its tag and all of its attributes, so page styling survives:
// only the text changes. Every provider carries these tags through and repositions them correctly
// when the translation reorders the sentence, which was verified against each before this was written.
//
// Sending the block whole also means the provider sees the entire sentence at once, so short inline
// fragments are not mistranslated for lack of context.

const MAX_ELEMENTS = 60;
const TAG = /<b(\d+)>|<\/b(\d+)>/g;
// Page text of its own containing our tag shape would be indistinguishable from a real marker.
const GUARD = /<\/?b\d/;

// Returns { text, elements } or null when the block cannot be represented safely.
export function serialize(block) {
  const elements = [];
  let out = "";
  let hasText = false;
  let bail = false;

  const walk = (parent) => {
    for (const node of parent.childNodes) {
      if (bail) return;

      if (node.nodeType === Node.TEXT_NODE) {
        const value = node.nodeValue || "";
        if (GUARD.test(value)) {
          bail = true;
          return;
        }
        if (value.trim()) hasText = true;
        out += escapeText(value);
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      // Nothing sets this today, since the loading state is a class rather than an appended node.
      // It stays as a guard so any future UI element cannot be mistaken for page content.
      if (node.hasAttribute("data-ht-ui")) continue;
      if (elements.length >= MAX_ELEMENTS) {
        bail = true;
        return;
      }

      // Opaque elements are sent as an empty pair: their contents are never exposed to a provider
      // and come back byte for byte. A self-closing <bN/> gets mangled, an empty pair does not.
      const opaque = EXCLUDE_TAGS.has(node.tagName) || STAY_ORIGINAL_TAGS.has(node.tagName);
      const index = elements.length;
      elements.push({ node, opaque });
      out += `<b${index}>`;
      if (!opaque) walk(node);
      out += `</b${index}>`;
    }
  };
  walk(block);

  if (bail || !hasText) return null;
  return { text: out, elements, plain: block.innerText || "" };
}

// Providers sometimes swallow the space next to a tag, turning "found on <b0>the site</b0>" into
// "found on<b0>the site</b0>". Where the source had whitespace at that boundary and the reply runs
// two word characters together, put it back. \w never matches Han or kana, so a target language
// that does not use spaces is left alone.
function restoreBoundarySpacing(source, translated, count) {
  let out = translated;
  for (let index = 0; index < count; index++) {
    if (new RegExp(`\\s<b${index}>`).test(source)) {
      out = out.replace(new RegExp(`(\\w)<b${index}>`, "g"), `$1 <b${index}>`);
    }
    if (new RegExp(`</b${index}>\\s`).test(source)) {
      out = out.replace(new RegExp(`</b${index}>(\\w)`, "g"), `</b${index}> $1`);
    }
  }
  return out;
}

// Parses the reply into a tree of element indexes and text runs. Strict on purpose: an index it did
// not send, an unbalanced tag or a missing element all return null, and the caller degrades to plain
// text rather than writing something malformed into the page.
function parse(translated, count) {
  const root = { children: [] };
  const stack = [root];
  const seen = new Set();
  const pattern = new RegExp(TAG.source, "g");
  let pos = 0;
  let match;

  const pushText = (value) => {
    if (value) stack[stack.length - 1].children.push(value);
  };

  while ((match = pattern.exec(translated))) {
    pushText(translated.slice(pos, match.index));
    pos = match.index + match[0].length;

    if (match[1] !== undefined) {
      const index = Number(match[1]);
      if (index >= count || seen.has(index)) return null;
      seen.add(index);
      const node = { index, children: [] };
      stack[stack.length - 1].children.push(node);
      stack.push(node);
    } else {
      const index = Number(match[2]);
      const top = stack[stack.length - 1];
      if (top === root || top.index !== index) return null;
      stack.pop();
    }
  }
  pushText(translated.slice(pos));

  if (stack.length !== 1 || seen.size !== count) return null;
  return root;
}

// Splits a node's children into the elements it contains and the text slots around them:
// slots.length is always elements.length + 1.
function split(children, isText, getText) {
  const elements = [];
  const slots = [[]];
  for (const child of children) {
    if (isText(child)) {
      slots[slots.length - 1].push(child);
      continue;
    }
    elements.push(child);
    slots.push([]);
  }
  return { elements, slots: slots.map(getText) };
}

// Writes a text run into its slot without creating or removing a single node. When the engine puts
// text where the page has no text node, it is appended to the nearest one instead of inserting.
function writeSlot(slots, index, text, edits) {
  const here = slots[index];
  if (here.length) {
    for (const [offset, node] of here.entries()) {
      edits.push([node, node.nodeValue]);
      node.nodeValue = offset === 0 ? text : "";
    }
    return true;
  }
  if (!text) return true;
  for (let i = index - 1; i >= 0; i--) {
    if (slots[i].length) {
      const node = slots[i][0];
      edits.push([node, node.nodeValue]);
      node.nodeValue += text;
      return true;
    }
  }
  for (let i = index + 1; i < slots.length; i++) {
    if (slots[i].length) {
      const node = slots[i][0];
      edits.push([node, node.nodeValue]);
      node.nodeValue = text + node.nodeValue;
      return true;
    }
  }
  return false;
}

function writeInto(node, spec, plan, indexOf, edits) {
  const origin = split(
    [...node.childNodes].filter(
      (n) =>
        n.nodeType === Node.TEXT_NODE ||
        (n.nodeType === Node.ELEMENT_NODE && !n.hasAttribute("data-ht-ui")),
    ),
    (n) => n.nodeType === Node.TEXT_NODE,
    (nodes) => nodes,
  );
  const reply = split(
    spec.children,
    (c) => typeof c === "string",
    (parts) => parts.join(""),
  );

  // The engine is free to reorder elements. That cannot be expressed by editing text alone, so the
  // caller is told to fall back to rebuilding the subtree instead.
  if (reply.elements.length !== origin.elements.length) return false;
  for (const [i, element] of origin.elements.entries()) {
    if (indexOf.get(element) !== reply.elements[i].index) return false;
  }

  for (const [i, text] of reply.slots.entries()) {
    if (!writeSlot(origin.slots, i, text, edits)) return false;
  }

  for (const [i, element] of origin.elements.entries()) {
    if (plan.elements[reply.elements[i].index].opaque) continue; // contents never sent, never touched
    if (!writeInto(element, reply.elements[i], plan, indexOf, edits)) return false;
  }
  return true;
}

// The preferred path: change only the text, leaving every node in place. Pages built with React and
// friends keep their DOM identity, so nothing is torn out from under their reconciler.
// Returns the edits made, for undo, or null when the reply cannot be applied this way.
export function applyInPlace(block, translated, plan, plainTranslation = "") {
  const spaced = restoreBoundarySpacing(plan.text, translated, plan.elements.length);
  const tree = parse(spaced, plan.elements.length);
  if (!tree) return null;
  fixCapitalisation(tree, plainTranslation);

  const indexOf = new Map(plan.elements.map((entry, index) => [entry.node, index]));
  const edits = [];
  if (writeInto(block, tree, plan, indexOf, edits)) return edits;

  // Roll back anything already written before giving up.
  for (let i = edits.length - 1; i >= 0; i--) edits[i][0].nodeValue = edits[i][1];
  return null;
}

// The fallback when the translation reordered elements: rebuild the subtree from clones. Every tag
// and attribute is preserved, but node identity is not, so it is only used when editing cannot work.
const SENTENCE_END = /[.!?:;。！？：；…]["')\]]?\s*$/;
// A whole capitalised word, so "Odin2" and "DOCK" are never candidates.
const LEADING_CAP = /^(\s*)([A-Z][a-z]+)(?![\w'’])/;

// Providers treat every tagged run as a sentence of its own and capitalise its first word, which
// litters a translated block with stray capitals: "support Nationwide warranty Serve." An untagged
// translation of the same block is the evidence for which words are genuinely proper nouns, so a word
// that appears capitalised there is left alone and everything else is put back to lower case.
function fixCapitalisation(tree, plainTranslation) {
  if (!plainTranslation) return;
  const proper = new Set(plainTranslation.match(/[A-Z][a-z]+/g) || []);
  let preceding = "";

  const visit = (spec) => {
    for (const [index, child] of spec.children.entries()) {
      if (typeof child !== "string") {
        visit(child);
        continue;
      }
      let text = child;
      const match = text.match(LEADING_CAP);
      // Only mid-sentence: a run that genuinely starts a sentence keeps its capital.
      if (match && preceding.trim() && !SENTENCE_END.test(preceding) && !proper.has(match[2])) {
        const lead = match[1];
        text = lead + match[2][0].toLowerCase() + text.slice(lead.length + 1);
        spec.children[index] = text;
      }
      preceding += text;
    }
  };
  visit(tree);
}

export function rebuild(translated, elements, plainTranslation = "", sourceText = "") {
  const spaced = sourceText
    ? restoreBoundarySpacing(sourceText, translated, elements.length)
    : translated;
  const tree = parse(spaced, elements.length);
  if (!tree) return null;
  fixCapitalisation(tree, plainTranslation);

  const build = (spec) => {
    const fragment = document.createDocumentFragment();
    for (const child of spec.children) {
      if (typeof child === "string") {
        fragment.append(document.createTextNode(child));
        continue;
      }
      const { node, opaque } = elements[child.index];
      // Deep for opaque nodes so their contents are untouched; shallow for containers, which copies
      // every attribute and lets the translated text take its place inside.
      if (opaque) {
        fragment.append(node.cloneNode(true));
        continue;
      }
      const clone = node.cloneNode(false);
      clone.append(build(child));
      fragment.append(clone);
    }
    return fragment;
  };
  return build(tree);
}
