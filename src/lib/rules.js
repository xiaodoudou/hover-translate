// DOM classification sets transcribed from Immersive Translate's default_config.json (generalRule).
// They encode which elements are safe to treat as a paragraph, as inline content, or to leave alone.

export const ALL_BLOCK_TAGS = new Set([
  "BODY", "HGROUP", "CONTENT", "ADDRESS", "ARTICLE", "ASIDE", "DETAILS", "BLOCKQUOTE",
  "SELECT", "OPTION", "CANVAS", "DD", "DL", "DT", "FIELDSET", "FIGCAPTION", "FIGURE",
  "FOOTER", "HEADER", "FORM", "HR", "MAIN", "SUMMARY", "NAV", "NOSCRIPT", "PRE",
  "SECTION", "TABLE", "TFOOT", "UL", "VIDEO", "P", "DIV", "H1", "H2", "H3", "H4", "H5",
  "H6", "LI", "OL", "BR", "PICTURE", "TBODY", "TR", "TD", "TH", "SOURCE", "C-WIZ",
  "BUTTON", "TURBO-FRAME", "README-TOC", "LABEL",
]);

export const INLINE_TAGS = new Set([
  "A", "ABBR", "FONT", "ACRONYM", "B", "INS", "DEL", "RUBY", "RP", "RB", "BDO", "MARK",
  "BIG", "RT", "NOBR", "CITE", "DFN", "EM", "I", "LABEL", "Q", "S", "SMALL", "SPAN",
  "STRONG", "SUB", "SUP", "U", "KBD", "TT", "VAR", "IMG", "CODE", "SCRIPT", "STYLE",
  "LINK", "TIME", "META", "WBR",
]);

// Never translated and never entered.
export const EXCLUDE_TAGS = new Set([
  "TITLE", "LINK", "SCRIPT", "STYLE", "TEXTAREA", "SVG", "G", "NOSCRIPT", "BASE",
  "PRE", "KBD", "WBR", "RT", "RP", "META", "MATH", "INPUT", "IFRAME", "CANVAS",
  "AUDIO", "VIDEO", "OBJECT", "EMBED",
]);

// Every set here is uppercase, and tagName only comes back uppercase for HTML elements. SVG and
// MathML report the case the document was written in, so an icon is "svg" and a formula is "math",
// "mrow", "mi". Comparing those raw meant the sets silently never matched them: the elements the
// lists above promise never to enter were walked into like ordinary prose, and a formula's symbols
// were sent to a translation engine and written back.
export const tagOf = (el) => el.tagName.toUpperCase();

// Kept byte-for-byte inside a translated block: passed through as an opaque placeholder.
export const STAY_ORIGINAL_TAGS = new Set([
  "CODE", "TT", "IMG", "SUP", "SUB", "SAMP", "MATH", "SEMANTICS", "MROW", "MO",
  "MFRAC", "MSUP", "MI", "MN", "MSQRT", "BR", "SVG", "PICTURE", "VIDEO", "AUDIO",
  "BUTTON", "INPUT", "SELECT", "IFRAME",
]);

// Elements that must never become a hover target: icon fonts, syntax highlighting, decoration.
// Every one of these speaks for its subtree. aria-hidden is deliberately not among them, because it
// does not: see the note in block.js.
export const HOVER_EXCLUDE_SELECTORS = [
  "rp", "rt", ".prism-code", ".enlighter-code", ".rc-CodeBlock", '[role="code"]',
  "table.highlight", 'div[class^="codeBlockContent"]', 'div[class^="codeBlockLines"]',
  ".material-icons", "material-icon", "i.fa", 'i[class^="fa-"]',
  ".google-symbols.notranslate", ".notranslate",
  '[translate="no"]',
];

export const HOVER_EXCLUDE_SELECTOR = HOVER_EXCLUDE_SELECTORS.join(",");

// A block bigger than this is almost certainly a container the user did not mean to point at.
export const BLOCK_MAX_TEXT = 5000;
export const BLOCK_MIN_TEXT = 2;

// Beyond this many child elements, structure-preserving translation is abandoned for plain text.
export const MAX_SEGMENTS = 30;

// Classes and attributes this extension owns.
export const CLASS_TRANSLATED = "ht-translated";
export const CLASS_BILINGUAL = "ht-bilingual";
export const CLASS_PENDING = "ht-pending";
export const CLASS_ERROR = "ht-error";
export const CLASS_MARQUEE = "ht-marquee";
// The one node this extension adds to a page, and only inside a box whose text it already replaced:
// a transform needs an element to move, and moving a layout property instead costs a relayout of
// the line on every frame.
export const CLASS_MARQUEE_LINE = "ht-marquee-line";
// Only while the line is actually moving: the ellipsis marks a cut that is not there mid-slide.
export const CLASS_MARQUEE_MOVING = "ht-marquee-moving";
export const CLASS_UNCLIPPED = "ht-unclipped";
// What the trigger would act on, shown while the key is held.
export const CLASS_AIM = "ht-aim";
export const ATTR_STATE = "data-ht-state";
