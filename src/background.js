// Every translation goes through here rather than the content script, so the host page's CSP cannot
// block the request and no page ever sees which services are being called.
//
// Three text providers, all free and none needing an account or an API key. Each was checked by hand
// against the numbered <bN> tags this extension relies on before being wired in.

import { hasScriptForeignTo, languageFromScript } from "./lib/script.js";
import { unescapeEntities } from "./lib/entities.js";
import { field, decode, all, sub, str, numeric } from "./lib/proto.js";

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

// The failures that say the service is down rather than that this one request was wrong. Only these
// put a provider on cool-down: a refusal or a malformed reply is about the text, not the service.
const unreachable = (message) => Object.assign(new Error(message), { unreachable: true });

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const abort = setTimeout(() => controller.abort(), TIMEOUT);
  let response;
  try {
    response = await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw unreachable(`timed out after ${TIMEOUT / 1000} s`);
    throw unreachable(`unreachable (${error?.message || error})`);
  } finally {
    clearTimeout(abort);
  }
  if (response.status >= 500 || response.status === 429) throw unreachable(`HTTP ${response.status}`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response;
}

// --- cool-down ------------------------------------------------------------
// A provider that is down costs the full timeout on every block until it comes back, so after one
// unreachable failure it goes to the back of the order for a while instead of being dropped: if
// everything else fails too, it still gets its turn.
const COOLDOWN = 10 * 60 * 1000;
// Mirrored to session storage because the worker is stopped after half a minute idle, and a cool-down
// held only in memory would be forgotten between two blocks read a minute apart.
const cooling = new Map();
const sessionStore = globalThis.chrome?.storage?.session;
const restored = sessionStore
  ? sessionStore.get("cooling").then(
      ({ cooling: saved }) => {
        for (const [id, entry] of Object.entries(saved || {})) cooling.set(id, entry);
      },
      () => {},
    )
  : Promise.resolve();

function saveCooling() {
  sessionStore?.set({ cooling: Object.fromEntries(cooling) }).catch(() => {});
}

function coolingSince(id) {
  const entry = cooling.get(id);
  if (!entry) return null;
  if (Date.now() - entry.since < COOLDOWN) return entry;
  cooling.delete(id);
  saveCooling();
  return null;
}

function coolDown(id, reason) {
  cooling.set(id, { since: Date.now(), reason });
  saveCooling();
}

function recover(id) {
  if (cooling.delete(id)) saveCooling();
}

// Stable: providers keep their relative order on both sides of the split.
function backOfTheLine(order) {
  const ready = order.filter((provider) => !coolingSince(provider.id));
  return [...ready, ...order.filter((provider) => !ready.includes(provider))];
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
      const message = `${primary.message}; backup: ${backup.message}`;
      throw primary.unreachable && backup.unreachable ? unreachable(message) : new Error(message);
    }
  }
}

// --- Alibaba --------------------------------------------------------------
// Keyless behind a CSRF token anyone can fetch, and strong on Chinese. It took Tencent TranSmart's
// place when TranSmart shut down on 2026-11-24. One text per request, so a block's tagged and plain
// copies go out side by side.
const ALIBABA_URL = "https://translate.alibaba.com/api/translate/text";
const ALIBABA_TOKEN_URL = "https://translate.alibaba.com/api/translate/csrftoken";
// Refused with TranslateFailed one character past this.
const ALIBABA_MAX = 5000;
// Its own codes where they differ from ours: zh-CN and zh-TW are refused outright.
const ALIBABA_LANGS = { "zh-cn": "zh", "zh-hans": "zh", "zh-hant": "zh-tw", "zh-tw": "zh-tw" };
const alibabaLang = (lang) => ALIBABA_LANGS[String(lang).toLowerCase()] || base(lang);

let alibabaToken = null;
function alibabaCsrf(fresh = false) {
  if (fresh || !alibabaToken) {
    alibabaToken = fetchJson(ALIBABA_TOKEN_URL).catch((error) => {
      alibabaToken = null;
      throw error;
    });
  }
  return alibabaToken;
}

// It sometimes writes a marker back as <B0> or </b1 >, which is the same marker to everyone else.
const tidyMarkers = (text) => text.replace(/<\s*(\/?)\s*b\s*(\d+)\s*>/gi, "<$1b$2>");

async function alibabaOne(text, sourceLang, targetLang, fresh = false) {
  const csrf = await alibabaCsrf(fresh);
  const form = new FormData();
  form.append("srcLang", sourceLang === "auto" ? "auto" : alibabaLang(sourceLang));
  form.append("tgtLang", alibabaLang(targetLang));
  form.append("domain", "general");
  form.append("query", text);
  form.append(csrf.parameterName, csrf.token);
  const response = await fetchWithTimeout(ALIBABA_URL, {
    method: "POST",
    headers: { [csrf.headerName]: csrf.token },
    body: form,
  });
  const body = await response.text();
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    // A token it no longer accepts gets the site's HTML page back rather than an error.
    if (!fresh) return alibabaOne(text, sourceLang, targetLang, true);
    throw new Error("request refused");
  }
  if (!json?.success || typeof json.data?.translateText !== "string") {
    throw new Error(json?.code || json?.message || "request refused");
  }
  return { text: tidyMarkers(unescapeEntities(json.data.translateText)), detected: json.data.detectLanguage || null };
}

async function alibaba(texts, sourceLang, targetLang) {
  if (texts.some((text) => text.length > ALIBABA_MAX)) {
    throw new Error(`text longer than the ${ALIBABA_MAX} character limit`);
  }
  const rows = await Promise.all(texts.map((text) => alibabaOne(text, sourceLang, targetLang)));
  return { texts: rows.map((row) => row.text), detected: rows.map((row) => row.detected) };
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

// --- image OCR ------------------------------------------------------------
// Words in an image are pixels, so they have to be read before they can be translated. Yandex's
// recogniser was the only keyless one that answered: Lens now speaks protobuf behind an API key,
// and TranSmart replies "unsupported fn" to every image function.
// lang=* is its auto-detect wildcard; naming a language returns nothing when the guess is wrong.
const YANDEX_OCR_URL = "https://translate.yandex.net/ocr/v1.1/recognize";
const IMAGE_MAX_BYTES = 12 * 1024 * 1024;

// The recogniser reports colours as separate channels, with `a` always zero rather than an alpha.
const rgb = (c) =>
  c && typeof c.r === "number" ? `rgb(${c.r | 0},${c.g | 0},${c.b | 0})` : null;

// The box's own rect is a tight band around the x-height, so painting over it leaves the tops of
// tall glyphs and the tails of descenders showing. The word rects cover the full glyphs, so the
// area to paint is their union, with a pixel of margin for anti-aliased edges.
function cover(box) {
  const words = (box.words || []).filter((w) => typeof w.x === "number");
  if (!words.length) return { x: box.x | 0, y: box.y | 0, w: box.w | 0, h: box.h | 0 };

  const left = Math.min(box.x, ...words.map((w) => w.x));
  const top = Math.min(box.y, ...words.map((w) => w.y));
  const right = Math.max(box.x + box.w, ...words.map((w) => w.x + w.w));
  const bottom = Math.max(box.y + box.h, ...words.map((w) => w.y + w.h));
  return {
    x: Math.round(left) - 1,
    y: Math.round(top) - 1,
    w: Math.round(right - left) + 2,
    h: Math.round(bottom - top) + 2,
  };
}

async function yandexOcr(blob) {
  const params = new URLSearchParams({
    srv: "tr-image",
    sid: `${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`,
    lang: "*",
    rotate: "auto",
  });
  const form = new FormData();
  form.append("file", blob, "image.png");

  const json = await fetchJson(`${YANDEX_OCR_URL}?${params}`, { method: "POST", body: form });
  if (json?.status !== "success") {
    throw new Error(json?.description || json?.error || "request refused");
  }

  // Boxes rather than blocks: a block groups lines that share a background, and painting over the
  // block would cover neighbouring text the recogniser reported separately.
  const lines = [];
  for (const block of json.data?.blocks || []) {
    for (const box of block.boxes || []) {
      const text = String(box.text || "").trim();
      if (!text) continue;
      lines.push({
        text,
        ...cover(box),
        color: rgb(box.textColor),
        background: rgb(box.backgroundColor),
      });
    }
  }
  return { lines, sourceLang: json.data?.detected_lang || null };
}

// --- Google Lens ----------------------------------------------------------
// The endpoint Chrome's own Lens overlay uses. The key below is Google's, baked into the official
// Chrome build and recovered from it by others: it is not published by Google, is not in the
// Chromium source, and is not ours. It is not a secret in any useful sense, since it identifies
// Chrome rather than a user and grants access to nobody's account, but it can be rotated or
// rate-limited without warning. Lens is ordered after Youdao partly for that reason: when this
// stops working the failover carries on to Yandex.
// The request is the smallest message the server accepts:
//   LensOverlayServerRequest{ objects_request{ image_data{ payload{ image_bytes } } } }
// image_data is a oneof, so payload must be the only member set or the request is rejected.
const LENS_URL = "https://lensfrontend-pa.googleapis.com/v1/crupload";
const LENS_KEY = "AIzaSyDr2UxVnv_U85AbhhY8XSHSIavUW0DC-sY";

async function lensOcr(blob, size) {
  const image = new Uint8Array(await blob.arrayBuffer());
  const body = field(1, field(3, field(1, field(1, image))));

  const response = await fetchWithTimeout(LENS_URL, {
    method: "POST",
    headers: { "content-type": "application/x-protobuf", "x-goog-api-key": LENS_KEY },
    body,
  });
  const reply = decode(new Uint8Array(await response.arrayBuffer()));

  // objects_response -> text -> text_layout -> paragraph[] -> line[] -> word[]
  const layout = sub(sub(sub(reply, 2), 3), 1);
  const lines = [];
  for (const paragraphBytes of all(layout, 1)) {
    const paragraph = decode(paragraphBytes);
    for (const lineBytes of all(paragraph, 2)) {
      const line = decode(lineBytes);

      // Each word carries the separator that follows it, so joining them rebuilds the spacing.
      let text = "";
      for (const wordBytes of all(line, 1)) {
        const word = decode(wordBytes);
        text += str(word, 2) + str(word, 3);
      }
      text = text.trim();
      if (!text) continue;

      // Centre point and extent, as a fraction of the image.
      const box = sub(sub(line, 2), 1);
      if (!box) continue;
      const cx = numeric(box, 1);
      const cy = numeric(box, 2);
      const w = numeric(box, 3);
      const h = numeric(box, 4);
      if (!w || !h) continue;

      // Lens reports a tight box around the glyphs, so painting it exactly leaves a sliver of the
      // original showing above and below. A sixth of the line height each way covers it and still
      // clears the next line, which sits a whole line height away.
      const width = w * size.width;
      const height = h * size.height;
      const padY = Math.max(2, Math.round(height / 6));
      const padX = 2;

      lines.push({
        text,
        x: Math.round((cx - w / 2) * size.width) - padX,
        y: Math.round((cy - h / 2) * size.height) - padY,
        w: Math.round(width) + padX * 2,
        h: Math.round(height) + padY * 2,
        color: null,
        background: null,
      });
    }
  }
  if (!lines.length) throw new Error("no text found");
  return { lines, sourceLang: null };
}

// --- Youdao ---------------------------------------------------------------
// Much the strongest of the three on Chinese, and it translates as it reads, handing back a picture
// of the finished result rather than boxes. So this one replaces the image instead of annotating it.
//
// Its demo endpoint ignores langTo completely: Chinese always comes back English and everything
// else always comes back Chinese. It is therefore only ever right for two target languages, and the
// reply is checked against what was actually asked for before it is used.
const YOUDAO_URL = "https://aidemo.youdao.com/ocrtransapi1";
const YOUDAO_TARGETS = new Set(["en", "zh"]);

async function youdaoOcr(blob, _size, targetLang) {
  if (!YOUDAO_TARGETS.has(base(targetLang))) {
    throw new Error(`only translates into English or Chinese, not ${targetLang}`);
  }

  const base64 = await blobToBase64(blob);
  // langFrom has to be named even when it is "auto", and the base64 needs its data: prefix.
  const body = new URLSearchParams({
    imgBase: `data:${blob.type || "image/png"};base64,${base64}`,
    langFrom: "auto",
    langTo: targetLang,
  });

  const json = await fetchJson(YOUDAO_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (json?.errorCode !== "0") throw new Error(`error ${json?.errorCode || "unknown"}`);
  if (!json.renderImage) throw new Error("no rendered image returned");
  if (base(json.lanTo) !== base(targetLang)) {
    throw new Error(`answered in ${json.lanTo}, not ${targetLang}`);
  }

  return {
    image: `data:image/jpeg;base64,${json.renderImage}`,
    sourceLang: json.lanFrom || null,
  };
}

const OCR_PROVIDERS = [
  { id: "youdao", run: youdaoOcr },
  { id: "lens", run: lensOcr },
  { id: "yandex", run: yandexOcr },
];
const OCR_BY_ID = new Map(OCR_PROVIDERS.map((provider) => [provider.id, provider]));

// btoa needs a binary string, and spreading a megabyte-long array blows the argument limit.
async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(at, at + 0x8000));
  }
  return btoa(binary);
}

// Lens reports no colours, so a box painted over its own text would be unreadable. The background
// is taken from just outside the box, where the text is not, and the ink is simply whichever of
// black or white the background can carry.
function sampleColours(context, lines, size) {
  for (const line of lines) {
    if (line.background) continue;
    const y = Math.min(size.height - 1, Math.max(0, line.y + line.h + 2));
    const x = Math.min(size.width - 1, Math.max(0, line.x + Math.floor(line.w / 2)));
    let pixel;
    try {
      pixel = context.getImageData(x, y, 1, 1).data;
    } catch {
      continue;
    }
    const [r, g, b] = pixel;
    line.background = `rgb(${r},${g},${b})`;
    // Rec. 709 luma: light backgrounds take dark ink and the other way about.
    line.color = 0.2126 * r + 0.7152 * g + 0.0722 * b > 140 ? "rgb(17,17,17)" : "rgb(245,245,245)";
  }
}

// Same failover contract as translate(): tried in the user's order until one answers.
export async function recognise(blob, preferred, targetLang) {
  const wanted = typeof preferred === "string" ? [preferred] : preferred;
  const order = (Array.isArray(wanted) ? wanted : []).map((id) => OCR_BY_ID.get(id)).filter(Boolean);
  if (!order.length) order.push(...OCR_PROVIDERS);

  // Decoded once and shared: Lens needs the pixel size to turn its fractions into coordinates, and
  // whichever provider omits colours needs the pixels themselves.
  const bitmap = await createImageBitmap(blob);
  const size = { width: bitmap.width, height: bitmap.height };
  let context = null;
  const pixels = () => {
    if (!context) {
      const canvas = new OffscreenCanvas(size.width, size.height);
      context = canvas.getContext("2d", { willReadFrequently: true });
      context.drawImage(bitmap, 0, 0);
    }
    return context;
  };

  const failures = [];
  try {
    for (const provider of order) {
      try {
        await throttle();
        const startedAt = Date.now();
        const result = await provider.run(blob, size, targetLang);
        if (result.lines?.some((line) => !line.background)) {
          sampleColours(pixels(), result.lines, size);
        }
        return { ...result, provider: provider.id, ms: Date.now() - startedAt };
      } catch (error) {
        failures.push(`${provider.id}: ${error?.message || error}`);
      }
    }
  } finally {
    bitmap.close();
  }
  throw new Error(failures.join("; ") || "no recogniser available");
}

// `image` is a data URL the content script already fetched. It is only sent when the worker itself
// could not reach the URL, which is the usual case: reading any image needs a host permission the
// extension asks for separately.
async function handleOcr({ url, image, order, targetLang = "en" }) {
  let blob;
  if (image) {
    blob = await (await fetch(image)).blob();
  } else {
    try {
      blob = await (await fetchWithTimeout(url, { credentials: "omit" })).blob();
    } catch (error) {
      throw new Error(`cannot read the image (${error?.message || error})`);
    }
  }
  if (blob.size > IMAGE_MAX_BYTES) throw new Error("image is larger than 12 MB");

  const result = await recognise(blob, order, targetLang);
  return { ...result, engine: result.provider, provider: undefined };
}

// --- dispatch -------------------------------------------------------------
const PROVIDERS = [
  { id: "alibaba", run: alibaba },
  { id: "google", run: google },
  { id: "mymemory", run: mymemory },
];
const BY_ID = new Map(PROVIDERS.map((provider) => [provider.id, provider]));

// Whether a reply still carries every numbered marker it was handed, each exactly once. The whole
// structure-preserving scheme rests on that: richtext.js refuses an unbalanced reply and the block
// degrades to flat text, losing its links and its emphasis. Google's backup endpoint drops a closing
// marker on text it otherwise translates correctly, so this is worth knowing before the reply is
// used rather than after.
export function keepsMarkers(sent, got) {
  const wanted = sent.join("\n").match(/<\/?b\d+>/g) || [];
  if (!wanted.length) return true;
  const tally = new Map();
  for (const marker of got.join("\n").match(/<\/?b\d+>/g) || []) {
    tally.set(marker, (tally.get(marker) || 0) + 1);
  }
  for (const marker of wanted) {
    const left = tally.get(marker) || 0;
    if (!left) return false;
    tally.set(marker, left - 1);
  }
  // Anything left over is a marker the provider invented, which parse() would refuse just as fast.
  return [...tally.values()].every((left) => left === 0);
}

// `preferred` is the user's order of preference. A string still works, so a single provider can be
// forced, and anything unrecognised falls back to the full list rather than failing outright.
export async function translate(texts, targetLang, preferred, sourceLang = "auto") {
  const wanted = typeof preferred === "string" ? [preferred] : preferred;
  let order = (Array.isArray(wanted) ? wanted : [])
    .map((id) => BY_ID.get(id))
    .filter(Boolean);
  if (!order.length) order.push(...PROVIDERS);
  await restored;
  order = backOfTheLine(order);

  const begunAt = Date.now();
  const failures = [];
  // What the stats show next to the provider that answered, so a fast answer after a slow failure
  // does not read as a fast translation.
  const failed = [];
  // A reply that lost its markers has not failed: the words are right and the block can still be
  // rewritten as flat text. It is kept in case nothing better answers, and the chain carries on
  // looking for one that would let the block keep its markup as well.
  let flattened = null;
  // Resting providers sit at the back, so any not reached by the time one answers were skipped.
  const resting = order.map((provider) => [provider.id, coolingSince(provider.id)]).filter(([, r]) => r);
  const tried = new Set();
  const finish = (answer) => {
    for (const [id, entry] of resting) {
      if (!tried.has(id)) failed.push({ id, reason: `skipped, ${entry.reason}`, since: entry.since });
    }
    return { ...answer, total: Date.now() - begunAt, failed };
  };
  for (const provider of order) {
    tried.add(provider.id);
    // Timed from just before the request so `ms` is the provider's own round trip, not the queueing
    // this extension added; `total` is the whole wait.
    try {
      await throttle();
      const startedAt = Date.now();
      const result = await provider.run(texts, sourceLang, targetLang);
      recover(provider.id);
      const answer = { ...result, provider: provider.id, ms: Date.now() - startedAt };
      if (keepsMarkers(texts, result.texts)) return finish(answer);
      flattened ??= answer;
      failures.push(`${provider.id}: lost the markers it was given`);
    } catch (error) {
      const message = error?.message || String(error);
      failures.push(`${provider.id}: ${message}`);
      if (error?.unreachable) coolDown(provider.id, message);
      failed.push({ id: provider.id, reason: message });
    }
  }
  if (flattened) return finish(flattened);
  throw new Error(failures.join("; ") || "no provider available");
}

async function handleTranslate({ texts, targetLang, order, sample = "" }) {
  const { texts: translated, detected, provider, ms, total, failed } = await translate(
    texts,
    targetLang,
    order,
  );

  // Judge every result, not just the first. A block whose Chinese sits inside child elements can
  // send a string dominated by markers and brand names, which detects as "en" or even "no" while the
  // rest detects as zh-CN. Skipping on that one result used to swallow the whole block.
  const langs = (detected || []).filter(Boolean);
  const foreign = langs.filter((lang) => base(lang) !== base(targetLang));
  const tally = new Map();
  for (const lang of foreign) tally.set(lang, (tally.get(lang) || 0) + 1);
  // The majority wins, so one misread fragment cannot speak for the block.
  const sourceLang = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || langs[0] || null;

  // A provider may omit the source language when it already matches the target, so a reply that
  // came back byte for byte is the only signal that there was nothing to do. The script check still
  // has the final say: text full of Han that came back unchanged is a failure, not English.
  const unchanged =
    translated.length === texts.length && translated.every((text, i) => text === texts[i]);
  const allTarget = langs.length > 0 && foreign.length === 0;
  const evidence = sample || texts.join("\n");

  if ((allTarget || unchanged) && !hasScriptForeignTo(evidence, targetLang)) {
    return { same: true, sourceLang, ms, total, failed };
  }
  return { texts: translated, engine: provider, sourceLang, ms, total, failed };
}

// There is nothing on the toolbar to click and nothing to see until a page is open, so a fresh
// install shows its own settings rather than waiting to be found under Details in chrome://extensions.
// Only on install: doing it on every update would take over a tab for news nobody asked for.
chrome.runtime.onInstalled?.addListener(({ reason }) => {
  if (reason === "install") chrome.runtime.openOptionsPage();
});

const HANDLERS = { translate: handleTranslate, ocr: handleOcr };

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = HANDLERS[message?.type];
  if (!handler) return undefined;
  handler(message)
    .then(sendResponse)
    .catch((error) => sendResponse({ error: error?.message || String(error) }));
  return true;
});
