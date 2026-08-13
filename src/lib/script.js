// Writing-system checks, used to overrule a language detector that gets it wrong.
//
// Detectors report "en" for text that is mostly Latin brand names or digits even when it is plainly
// Chinese, for example "奥丁2掌机Odin2游戏机专用DOCK充电扩展坞支持4K60帧输出金属外壳" or
// "2026-07-18订单号: 3312870351913019697". Acting on that skipped the block as "already in English".
// A script check settles it: Han characters mean the text is not English, whatever a detector says.

const SCRIPTS = [
  ["han", /[㐀-䶿一-鿿豈-﫿]/],
  ["kana", /[぀-ゟ゠-ヿ]/],
  ["hangul", /[ᄀ-ᇿ가-힯]/],
  ["cyrillic", /[Ѐ-ӿ]/],
  ["greek", /[Ͱ-Ͽ]/],
  ["arabic", /[؀-ۿݐ-ݿﭐ-﷿]/],
  ["hebrew", /[֐-׿]/],
  ["thai", /[฀-๿]/],
  ["devanagari", /[ऀ-ॿ]/],
];

// Non-Latin scripts each language legitimately uses. Latin is omitted on purpose: it turns up in
// every language as brand names, model numbers and dates, so it is never evidence of anything.
const ALLOWED = {
  zh: ["han"], ja: ["han", "kana"], ko: ["hangul", "han"],
  ru: ["cyrillic"], uk: ["cyrillic"], be: ["cyrillic"], bg: ["cyrillic"],
  sr: ["cyrillic"], mk: ["cyrillic"], kk: ["cyrillic"], mn: ["cyrillic"],
  el: ["greek"], ar: ["arabic"], fa: ["arabic"], ur: ["arabic"], ps: ["arabic"],
  he: ["hebrew"], yi: ["hebrew"], th: ["thai"],
  hi: ["devanagari"], mr: ["devanagari"], ne: ["devanagari"],
};

const FALLBACK_LANGUAGE = {
  han: "zh", kana: "ja", hangul: "ko", cyrillic: "ru",
  greek: "el", arabic: "ar", hebrew: "he", thai: "th", devanagari: "hi",
};

const base = (lang) => String(lang || "").split("-")[0].toLowerCase();

export function scriptsIn(text) {
  return SCRIPTS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

// True when the text is written in a system the language does not use, so it cannot be in it.
export function hasScriptForeignTo(text, lang) {
  const allowed = ALLOWED[base(lang)] || [];
  return scriptsIn(text).some((script) => !allowed.includes(script));
}

export function languageFromScript(text) {
  const found = scriptsIn(text);
  // Any kana settles Japanese, even when Han characters outnumber it.
  if (found.includes("kana")) return "ja";
  for (const script of found) if (FALLBACK_LANGUAGE[script]) return FALLBACK_LANGUAGE[script];
  return null;
}

// Which row of the quick-translate mapping a stretch of text belongs to. The writing system is all
// that can be read off the text itself, and it is free and certain as far as it goes: it separates
// Chinese from Russian from English without a detector. It stops where an alphabet is shared, so
// French and English are one group, and so are Mandarin and Cantonese.
//
// The most-used script wins rather than the first one found, since a Korean sentence with two hanja
// in it is Korean. Kana is the exception: Japanese prose has more kanji than kana and is still
// Japanese, so any kana at all settles it.
export function scriptGroup(text) {
  const tally = new Map();
  for (const char of text) {
    for (const [name, pattern] of SCRIPTS) {
      if (!pattern.test(char)) continue;
      tally.set(name, (tally.get(name) || 0) + 1);
      break;
    }
  }
  if (!tally.size) return "latin";
  if (tally.has("kana")) return "kana";
  return [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

// Picks the best detector candidate the text's own writing system actually supports.
export function pickLanguage(candidates, text, minConfidence = 0.4) {
  const ranked = (candidates || []).filter((c) => c.detectedLanguage && c.detectedLanguage !== "und");
  if (!scriptsIn(text).length) {
    const top = ranked[0];
    return top && top.confidence >= minConfidence ? top.detectedLanguage : null;
  }
  const compatible = ranked.find((c) => !hasScriptForeignTo(text, c.detectedLanguage));
  return compatible?.detectedLanguage || languageFromScript(text);
}
