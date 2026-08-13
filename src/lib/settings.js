// The modifiers a press can be counted on. Alt is not among them: the browser answers a bare Alt by
// moving focus to its own toolbar, which takes the keys with it and blurs the page, so a tap of it
// is one the page hears the beginning of and never the end.
export const KEYS = ["Control", "Shift"];

// Not a key: quick translate riding the trigger's own press. The two cannot be confused, because the
// pointer says which was meant. Over a selection a press takes that; anywhere else it takes the
// block, and the trigger never had anything to say inside a field to begin with.
export const SHARED = "trigger";

export const DEFAULTS = {
  targetLang: "en",
  // replace | outlined | underlined | dashed: rewrite the text in place, touching no nodes.
  //   The last three add a purely visual marker that costs no layout.
  // both:   keep the original and add the translation underneath it
  // bubble: leave the page alone and show the translation in an overlay
  displayMode: "replace",
  // A page clips its one-line boxes to fit its own language, so a longer translation ends up behind
  // the ellipsis. Either the box keeps its size and the line moves, or the line stays put and the
  // box grows; there is no third answer, and this picks between them.
  // fit:  slide the line, except where the page left room around the box, which it takes instead
  // grow: always grow the box, never move the line
  // Anything else reads as fit, which is how the "always slide" setting this once had retires: it
  // only ever differed where a page left slack, and taking slack costs the page nothing.
  clippedLines: "fit",
  triggerKey: "Control", // one of KEYS
  // 1 fires on a single tap, 2 requires the key tapped twice. Two taps are far harder to hit by
  // accident, which is the point: a modifier gets pressed constantly for reasons of its own.
  triggerTaps: 1,
  // Whether holding the key outlines the block it would act on. Off by default: the key is held
  // before every translation, so an outline that is always on is a box drawn on the page nearly
  // every time. Worth having while learning what a tap takes, and worth turning off after that.
  aimOutline: false,
  // Not exposed: how long the second tap may arrive after the first.
  doubleTapMs: 400,
  // Quick translate: a key of its own that turns the current selection over where it sits, for the
  // text the pointer cannot single out, such as one sentence of a paragraph or a phrase spanning
  // two. Two taps by default because a bare modifier gets pressed for a hundred other reasons.
  // Empty turns it off. It can never share the trigger's key: a double tap contains a single one,
  // so whichever was the shorter would swallow the other before it finished.
  quickKey: SHARED, // SHARED, one of KEYS, or "" for off
  // Only when it has a key of its own. Riding the trigger, it is counted however the trigger is.
  quickTaps: 2,
  // Where a selection goes, keyed by the writing system it is in. Empty means the target language
  // above, so only the direction that differs from it needs setting, which is usually your own
  // language going back out. A script with no row of its own lands in "other".
  quickMap: { latin: "", han: "", kana: "", hangul: "", cyrillic: "", arabic: "", other: "" },
  // Off until asked for: reading images needs a host permission the extension does not install
  // with, so this is turned on from the popup, where that permission can be requested.
  translateImages: false,
  // Which recogniser reads an image, in failover order. Youdao translates as it reads and hands
  // back a finished picture; the other two return lines, which providerOrder above then translates.
  imageOcrOrder: ["youdao", "lens", "yandex"],
  // The request is never slowed; the loading gradient is simply held this long so it is visible.
  // On-device translations come back in about 35ms, which would otherwise be a single frame flash.
  minLoadingMs: 400,
  // Tried top to bottom until one answers. Reorder or shorten it in the popup.
  providerOrder: ["tencent", "google", "mymemory"],
  // Where notices appear, or "off" to silence them.
  toastPosition: "bottom-center",
};

// Read here rather than only in the popup, so a key that is no longer offered stops answering at
// once instead of on the next visit to the settings.
const usableKey = (key, fallback) => (KEYS.includes(key) ? key : fallback);

// A quick key the trigger is already using is the same press either way, which is what SHARED says
// outright, so it is read as that rather than refused.
function quickFrom(key, triggerKey) {
  if (!key) return "";
  if (key === SHARED || key === triggerKey) return SHARED;
  return usableKey(key, "");
}

export async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  const triggerKey = usableKey(stored.triggerKey, DEFAULTS.triggerKey);
  return {
    ...DEFAULTS,
    ...stored,
    // The map is stored whole, so one saved before a script had a row of its own would arrive
    // without it and read as undefined rather than as "not set".
    quickMap: { ...DEFAULTS.quickMap, ...stored.quickMap },
    triggerKey,
    quickKey: quickFrom(stored.quickKey, triggerKey),
  };
}

export async function setSettings(patch) {
  await chrome.storage.sync.set(patch);
}

export function onSettingsChanged(callback) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    const patch = {};
    for (const [key, { newValue }] of Object.entries(changes)) patch[key] = newValue;
    callback(patch);
  });
}
