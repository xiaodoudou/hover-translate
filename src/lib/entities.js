// The endpoints return HTML-escaped text, and we escape source text before sending it so a stray
// "<" cannot be read as markup. Translated text only ever becomes text nodes, so unescape fully.
export function unescapeEntities(text) {
  return String(text)
    .replace(/％3C/gi, "<")
    .replace(/％3E/gi, ">")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#34;/gi, '"')
    .replace(/&#60;/gi, "<")
    .replace(/&#62;/gi, ">")
    .replace(/&#160;/gi, " ")
    .replace(/&#38;/gi, "&")
    .replace(/&amp;/gi, "&");
}

export function escapeText(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;");
}
