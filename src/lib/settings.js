export const DEFAULTS = {
  targetLang: "en",
  // replace | outlined | underlined | dashed: rewrite the text in place, touching no nodes.
  //   The last three add a purely visual marker that costs no layout.
  // both:   keep the original and add the translation underneath it
  // bubble: leave the page alone and show the translation in an overlay
  displayMode: "replace",
  triggerKey: "Control", // Control | Alt | Shift
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
