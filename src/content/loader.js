// Content scripts cannot be declared as ES modules, so the real entry point is imported dynamically.
// Everything it pulls in stays in the isolated world, out of reach of the page.
if (!window.__hoverTranslateLoaded) {
  window.__hoverTranslateLoaded = true;
  import(chrome.runtime.getURL("src/content/index.js")).catch((error) => {
    console.error("[Hover Translate] failed to start:", error);
  });
}
