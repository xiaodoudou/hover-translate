// Thin client. Provider selection and failover happen in the background worker, where the host
// page's CSP cannot block the request.

const cache = new Map();
const CACHE_MAX = 2000;

function remember(texts, targetLang, translated) {
  texts.forEach((text, index) => cache.set(`${targetLang}|${text}`, translated[index]));
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

// Resolves to { texts, engine, sourceLang, ms } or { same: true } when the text is already in the
// target. `sample` is the tag-free text used for detection, since the <bN> markers are Latin.
export async function translateTexts(texts, targetLang, order, sample = "") {
  const keys = texts.map((text) => `${targetLang}|${text}`);
  if (keys.every((key) => cache.has(key))) {
    return { texts: keys.map((key) => cache.get(key)), engine: "cache", sourceLang: null, ms: 0 };
  }

  const response = await chrome.runtime.sendMessage({
    type: "translate",
    texts,
    targetLang,
    order,
    sample,
  });
  if (!response) throw new Error("Background worker did not respond.");
  if (response.error) throw new Error(response.error);
  if (response.same) return response;

  remember(texts, targetLang, response.texts);
  return response;
}
