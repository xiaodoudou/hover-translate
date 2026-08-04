// Every translation goes through here rather than the content script, so the host page's CSP cannot
// block the request and no page ever sees which services are being called.
//
// Three providers, all free and none needing an account or an API key. Each was checked by hand
// against the numbered <bN> tags this extension relies on before being wired in.

import { hasScriptForeignTo, languageFromScript } from "./lib/script.js";
import { unescapeEntities } from "./lib/entities.js";

const TIMEOUT = 15000;
const RATE_LIMIT = 10;
const RATE_INTERVAL = 1050;

const recent = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const base = (lang) => String(lang || "").split("-")[0].toLowerCase();

async function throttle() {
  for (;;) {
    const now = Date.now();
    while (recent.length && now - recent[0] > RATE_INTERVAL) recent.shift();
    if (recent.length < RATE_LIMIT) {
      recent.push(now);
      return;
    }
    await sleep(RATE_INTERVAL - (now - recent[0]) + 10);
  }
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const abort = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response;
  } finally {
    clearTimeout(abort);
  }
}

const fetchJson = async (url, options) => (await fetchWithTimeout(url, options)).json();

// --- Google ---------------------------------------------------------------
// Batches natively, which matters because a block is sent alongside an untagged copy of itself.
const PA_URL = "https://translate-pa.googleapis.com/v1/translateHtml";
// Public key shipped inside Google's own translate clients. Not a secret, not tied to an account.
const PA_KEY = "AIzaSyATBXajvzQLTDHEQbcpq0Ihe0vWDHmO520";
const GTX_URL = "https://translate.googleapis.com/translate_a/t";

export async function viaTranslateHtml(texts, sourceLang, targetLang) {
  const json = await fetchJson(PA_URL, {
    method: "POST",
    headers: { "content-type": "application/json+protobuf", "x-goog-api-key": PA_KEY },
    body: JSON.stringify([[texts, sourceLang, targetLang], "te_lib"]),
  });
  const rows = json?.[0];
  if (!Array.isArray(rows) || rows.length !== texts.length) throw new Error("unexpected response shape");
  return {
    texts: rows.map((row) => unescapeEntities(Array.isArray(row) ? row[0] : row)),
    detected: json?.[1] ?? [],
  };
}

export async function viaGtx(texts, sourceLang, targetLang) {
  const params = new URLSearchParams({ client: "gtx", dt: "t", sl: sourceLang, tl: targetLang });
  const body = new URLSearchParams();
  for (const text of texts) body.append("q", text);

  const json = await fetchJson(`${GTX_URL}?${params}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded;charset=utf-8" },
    body: body.toString(),
  });
  // One q returns ["text","lang"]; several return [["text","lang"], ...].
  const rows = typeof json?.[0] === "string" ? [json] : json;
  if (!Array.isArray(rows) || rows.length !== texts.length) throw new Error("unexpected response shape");
  return {
    texts: rows.map((row) => unescapeEntities(Array.isArray(row) ? row[0] : row)),
    detected: rows.map((row) => (Array.isArray(row) ? row[1] : null)),
  };
}

async function google(texts, sourceLang, targetLang) {
  try {
    return await viaTranslateHtml(texts, sourceLang, targetLang);
  } catch (primary) {
    try {
      return await viaGtx(texts, sourceLang, targetLang);
    } catch (backup) {
      throw new Error(`${primary.message}; backup: ${backup.message}`);
    }
  }
}

// --- Tencent TranSmart ----------------------------------------------------
// Keyless, batches like Google, and the strongest of the three on Chinese.
const TRANSMART_URL = "https://transmart.qq.com/api/imt";
const CLIENT_KEY = `browser-chrome-150.0.0-Windows 10-${Math.random().toString(36).slice(2)}-${Date.now()}`;

async function tencent(texts, sourceLang, targetLang) {
  const json = await fetchJson(TRANSMART_URL, {
    method: "POST",
    headers: { "content-type": "application/json", referer: "https://transmart.qq.com/zh-CN/index" },
    body: JSON.stringify({
      header: { fn: "auto_translation", client_key: CLIENT_KEY },
      type: "plain",
      model_category: "normal",
      source: { lang: sourceLang === "auto" ? "auto" : sourceLang, text_list: texts },
      target: { lang: targetLang },
    }),
  });
  if (json?.header?.ret_code !== "succ") throw new Error(json?.header?.ret_code || "request refused");
  const rows = json?.auto_translation;
  if (!Array.isArray(rows) || rows.length !== texts.length) throw new Error("unexpected response shape");
  return {
    texts: rows.map((row) => unescapeEntities(row)),
    detected: texts.map(() => json.src_lang || null),
  };
}

// --- MyMemory -------------------------------------------------------------
// Last resort: no key, but it needs to be told the source language and caps each request at 500
// bytes, so it only ever serves short blocks the other two failed on.
const MYMEMORY_URL = "https://api.mymemory.translated.net/get";
const MYMEMORY_MAX = 500;

async function mymemory(texts, sourceLang, targetLang) {
  const source = sourceLang !== "auto" ? sourceLang : languageFromScript(texts.join("\n"));
  if (!source) throw new Error("needs a source language and the writing system did not give one");
  if (texts.some((text) => text.length > MYMEMORY_MAX)) {
    throw new Error(`text longer than the ${MYMEMORY_MAX} character limit`);
  }

  const out = [];
  for (const text of texts) {
    const params = new URLSearchParams({ q: text, langpair: `${source}|${targetLang}` });
    const json = await fetchJson(`${MYMEMORY_URL}?${params}`);
    if (json?.responseStatus !== 200) throw new Error(json?.responseDetails || "request refused");
    out.push(unescapeEntities(json.responseData.translatedText));
  }
  return { texts: out, detected: texts.map(() => source) };
}

// --- dispatch -------------------------------------------------------------
const PROVIDERS = [
  { id: "tencent", run: tencent },
  { id: "google", run: google },
  { id: "mymemory", run: mymemory },
];
const BY_ID = new Map(PROVIDERS.map((provider) => [provider.id, provider]));

// `preferred` is the user's order of preference. A string still works, so a single provider can be
// forced, and anything unrecognised falls back to the full list rather than failing outright.
export async function translate(texts, targetLang, preferred, sourceLang = "auto") {
  const wanted = typeof preferred === "string" ? [preferred] : preferred;
  const order = (Array.isArray(wanted) ? wanted : [])
    .map((id) => BY_ID.get(id))
    .filter(Boolean);
  if (!order.length) order.push(...PROVIDERS);

  const failures = [];
  for (const provider of order) {
    // Timed from just before the request so the figure the popup shows is the provider's own
    // round trip, not the queueing this extension added.
    try {
      await throttle();
      const startedAt = Date.now();
      const result = await provider.run(texts, sourceLang, targetLang);
      return { ...result, provider: provider.id, ms: Date.now() - startedAt };
    } catch (error) {
      failures.push(`${provider.id}: ${error?.message || error}`);
    }
  }
  throw new Error(failures.join("; ") || "no provider available");
}

async function handleTranslate({ texts, targetLang, order, sample = "" }) {
  const { texts: translated, detected, provider, ms } = await translate(texts, targetLang, order);

  // Judge every result, not just the first. A block whose Chinese sits inside child elements can
  // send a string dominated by markers and brand names, which detects as "en" or even "no" while the
  // rest detects as zh-CN. Skipping on that one result used to swallow the whole block.
  const langs = (detected || []).filter(Boolean);
  const foreign = langs.filter((lang) => base(lang) !== base(targetLang));
  const tally = new Map();
  for (const lang of foreign) tally.set(lang, (tally.get(lang) || 0) + 1);
  // The majority wins, so one misread fragment cannot speak for the block.
  const sourceLang = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || langs[0] || null;

  // Tencent omits the source language entirely when it already matches the target, so a reply that
  // came back byte for byte is the only signal that there was nothing to do. The script check still
  // has the final say: text full of Han that came back unchanged is a failure, not English.
  const unchanged =
    translated.length === texts.length && translated.every((text, i) => text === texts[i]);
  const allTarget = langs.length > 0 && foreign.length === 0;
  const evidence = sample || texts.join("\n");

  if ((allTarget || unchanged) && !hasScriptForeignTo(evidence, targetLang)) {
    return { same: true, sourceLang, ms };
  }
  return { texts: translated, engine: provider, sourceLang, ms };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "translate") return undefined;
  handleTranslate(message)
    .then(sendResponse)
    .catch((error) => sendResponse({ error: error?.message || String(error) }));
  return true;
});
