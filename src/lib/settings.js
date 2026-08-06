export const DEFAULTS = {
  targetLang: "en",
  // replace | outlined | underlined | dashed: rewrite the text in place, touching no nodes.
  //   The last three add a purely visual marker that costs no layout.
  // both:   keep the original and add the translation underneath it
  // bubble: leave the page alone and show the translation in an overlay
  displayMode: "replace",
  triggerKey: "Control", // Control | Alt | Shift
  // 1 fires on a single tap, 2 requires the key tapped twice. Two taps are far harder to hit by
  // accident, which is the point: a modifier gets pressed constantly for reasons of its own.
  triggerTaps: 1,
  // Not exposed: how long the second tap may arrive after the first.
  doubleTapMs: 400,
  // Off until asked for: reading images needs a host permission the extension does not install
  // with, so this is turned on from the popup, where that permission can be requested.
  translateImages: false,
  // Which recogniser reads an image, in failover order. Youdao translates as it reads and hands
  // back a finished picture; the other two return lines, which providerOrder above then translates.
  imageOcrOrder: ["youdao", "lens", "yandex"],
  // Not exposed: how long the key must be held before sweep mode starts.
  holdDelay: 200,
  // The request is never slowed; the loading gradient is simply held this long so it is visible.
  // On-device translations come back in about 35ms, which would otherwise be a single frame flash.
  minLoadingMs: 400,
  // Tried top to bottom until one answers. Reorder or shorten it in the popup.
  providerOrder: ["tencent", "google", "mymemory"],
  // Where notices appear, or "off" to silence them.
  toastPosition: "bottom-center",
};

export async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
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
