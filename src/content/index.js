import { resolveBlock } from "./block.js";
import {
  resolveImage,
  imageUrl,
  readImage,
  showImageOverlay,
  hideImageOverlay,
  hideAllImageOverlays,
  showImagePending,
  hideImagePending,
} from "./image.js";
import { serialize, applyInPlace, rebuild } from "./richtext.js";
import { installHover } from "./hover.js";
import { toast } from "./toast.js";
import { showBubble, hideBubble } from "./bubble.js";
import { setClippedLines } from "./marquee.js";
import * as render from "./render.js";
import { translateTexts } from "../engine/index.js";
import { getSettings, onSettingsChanged, DEFAULTS } from "../lib/settings.js";

const settings = { ...DEFAULTS, ...(await getSettings().catch(() => ({}))) };
render.setMarker(settings.displayMode);
setClippedLines(settings.clippedLines);
onSettingsChanged((patch) => {
  Object.assign(settings, patch);
  if ("displayMode" in patch) render.setMarker(patch.displayMode);
  if ("clippedLines" in patch) {
    setClippedLines(patch.clippedLines);
    render.refreshOverflow();
  }
});

const inFlight = new WeakSet();

const stripTags = (text) => text.replace(/<\/?b\d+>/g, "").replace(/\s{2,}/g, " ").trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A content script outlives the extension that injected it. Reloading, updating or disabling Hover
// Translate leaves this copy running in an already-open tab with nothing behind it, and every
// chrome.* call from then on throws "Extension context invalidated". Nothing here can reconnect:
// only a page load gets a fresh content script. So it says that once, in words, and then goes quiet
// rather than repeating a meaningless error on every trigger.
let orphaned = false;
const contextAlive = () => Boolean(chrome.runtime?.id);
const isOrphanError = (message) =>
  /Extension context invalidated|Receiving end does not exist|message port closed/i.test(message);

function reportOrphaned() {
  if (orphaned) return;
  orphaned = true;
  toast("Hover Translate was updated. Reload this page to use it here.", {
    error: true,
    position: settings.toastPosition,
  });
}

// Text and images are reported separately: they go through different engines, and one succeeding
// says nothing about the other.
function reportStatus(patch, key = "status") {
  // Throws rather than rejecting once the context is gone, so the promise catch is not enough.
  try {
    chrome.storage.local
      .set({ [key]: { ...patch, at: Date.now(), host: location.host } })
      .catch(() => {});
  } catch {
    /* orphaned: the notice has already been shown */
  }
}
const reportImageStatus = (patch) => reportStatus(patch, "imageStatus");

async function translatePlain(block) {
  const text = block.innerText || "";
  const result = await translateTexts([text], settings.targetLang, settings.providerOrder, text);
  if (result.same) return result;
  return { ...result, content: document.createTextNode(stripTags(result.texts[0])) };
}

// The worker reads the image when it has the host permission for it; otherwise the page fetches its
// own bytes, which is enough for a same-origin image and costs nothing to try.
async function recogniseImage(img) {
  const url = imageUrl(img);
  const ask = (payload) =>
    chrome.runtime.sendMessage({
      type: "ocr",
      order: settings.imageOcrOrder,
      targetLang: settings.targetLang,
      ...payload,
    });

  let response = await ask({ url });
  if (response?.error) {
    const image = await readImage(img).catch(() => null);
    if (!image) throw new Error(response.error);
    response = await ask({ image });
  }
  if (!response) throw new Error("Background worker did not respond.");
  if (response.error) throw new Error(response.error);
  return response;
}

async function handleImage(img) {
  if (hideImageOverlay(img)) return;
  if (inFlight.has(img)) return;

  inFlight.add(img);
  // The class carries the progress cursor; the bar is what is actually visible, since the gradient
  // the text path paints would sit behind the image's own pixels.
  render.markPending(img);
  showImagePending(img);
  const startedAt = Date.now();
  try {
    const read = await recogniseImage(img);

    // A provider that translates as it reads hands back a finished picture, so the usual chain has
    // nothing left to do. Youdao is the one that works this way.
    let painted;
    let engine = read.engine;
    let sourceLang = read.sourceLang;
    let ms = read.ms;

    if (read.image) {
      painted = { image: read.image };
    } else {
      if (!read.lines?.length) {
        toast("No text found in this image.", { position: settings.toastPosition });
        reportImageStatus({ engine, sourceLang, ms });
        return;
      }
      const texts = read.lines.map((line) => line.text);
      const result = await translateTexts(
        texts, settings.targetLang, settings.providerOrder, texts.join("\n"),
      );
      if (result.same) {
        toast(`Already ${result.sourceLang || "in the target language"}.`, { position: settings.toastPosition });
        reportImageStatus({ engine: "skipped", sourceLang: result.sourceLang, ms: result.ms });
        return;
      }
      painted = {
        lines: read.lines.map((line, index) => ({
          ...line,
          text: stripTags(result.texts[index] || line.text),
        })),
      };
      engine = `${engine}+${result.engine}`;
      sourceLang = result.sourceLang || sourceLang;
      ms = result.ms;
    }

    const remaining = settings.minLoadingMs - (Date.now() - startedAt);
    if (remaining > 0) await sleep(remaining);

    if (!showImageOverlay(img, painted)) {
      toast("This image is not laid out yet.", { error: true, position: settings.toastPosition });
      return;
    }
    reportImageStatus({ engine, sourceLang, ms });
  } catch (error) {
    const message = String(error?.message || error);
    if (isOrphanError(message) || !contextAlive()) {
      reportOrphaned();
      return;
    }
    render.markError(img);
    toast(`Hover Translate: ${message}`, { error: true, position: settings.toastPosition });
    reportImageStatus({ error: message });
  } finally {
    hideImagePending(img);
    render.clearPending(img);
    inFlight.delete(img);
  }
}

async function handle(target) {
  // Restore first, and by ancestor rather than by block resolution: once the text is replaced the
  // layout shifts, so the pointer may be over a different element than the one that was translated.
  const element = target?.nodeType === Node.TEXT_NODE ? target.parentElement : target;
  const done = element?.closest?.('[data-ht-state="translated"]');
  if (done) {
    render.revert(done);
    return;
  }

  // Undoing above is pure DOM and keeps working; anything past here needs the extension behind it.
  if (orphaned) return;
  if (!contextAlive()) {
    reportOrphaned();
    return;
  }

  const img = resolveImage(target);
  if (img) {
    if (settings.translateImages) await handleImage(img);
    return;
  }

  const block = resolveBlock(target);
  if (!block) return;
  if (inFlight.has(block)) return;

  inFlight.add(block);
  render.snapshot(block);
  const parsed = serialize(block);
  render.markPending(block);
  const startedAt = Date.now();
  try {
    let result;
    let content = null;

    let plainTranslation = "";
    if (parsed) {
      // A second, untagged copy goes along for the ride whenever the block has elements. It is the
      // reference for fixing the stray capitals the engines put at every tag boundary.
      // parsed.plain also serves as the detection sample: the <bN> markers are Latin and would
      // otherwise push the detector towards English.
      const withElements = parsed.elements.length > 0;
      const texts = withElements ? [parsed.text, parsed.plain] : [parsed.text];
      result = await translateTexts(texts, settings.targetLang, settings.providerOrder, parsed.plain);
      if (withElements && !result.same) plainTranslation = result.texts[1] || "";
    } else {
      // Nothing safe to serialise: one flat string, which loses markup but drops nothing.
      result = await translatePlain(block);
      content = result.content ?? null;
    }

    // Held here, before anything is written, so the gradient is on screen long enough to read.
    // The request itself was never delayed.
    const remaining = settings.minLoadingMs - (Date.now() - startedAt);
    if (remaining > 0) await sleep(remaining);

    if (result.same) {
      toast(`Already ${result.sourceLang || "in the target language"}.`, { position: settings.toastPosition });
      reportStatus({ engine: "skipped", sourceLang: result.sourceLang, ms: result.ms });
      return;
    }

    // The page is never modified in bubble mode, so it needs neither edits nor a rebuild. The block
    // is deliberately left unmarked: the bubble dismisses itself, and marking it would leave stale
    // state behind, so the next trigger would be spent reverting a bubble that is already gone.
    if (settings.displayMode === "bubble") {
      showBubble(block, plainTranslation || stripTags(result.texts[0]));
      reportStatus({ engine: result.engine, sourceLang: result.sourceLang, ms: result.ms });
      return;
    }

    // Bilingual adds text and nothing else. Rebuilding the subtree here would append a clone of
    // every element beside the original: duplicate ids, a second copy of each form control, and
    // framework-managed nodes the page never created.
    if (settings.displayMode === "both") {
      render.applyBoth(block, plainTranslation || stripTags(result.texts[0]));
      reportStatus({ engine: result.engine, sourceLang: result.sourceLang, ms: result.ms });
      return;
    }

    if (parsed) {
      // Preferred: edit the text nodes and leave the DOM alone, so reactive pages keep their tree.
      const edits = applyInPlace(block, result.texts[0], parsed, plainTranslation);
      if (edits) {
        render.applyEdits(block, edits);
        reportStatus({ engine: result.engine, sourceLang: result.sourceLang, ms: result.ms });
        return;
      }
      // The engine reordered elements, so rebuild the subtree instead.
      content = rebuild(result.texts[0], parsed.elements, plainTranslation, parsed.text);
      if (!content) {
        result = await translatePlain(block);
        if (result.same) {
          toast(`Already ${result.sourceLang || "in the target language"}.`, { position: settings.toastPosition });
          reportStatus({ engine: "skipped", sourceLang: result.sourceLang, ms: result.ms });
          return;
        }
        content = result.content ?? null;
      }
    }

    render.apply(block, content);
    reportStatus({ engine: result.engine, sourceLang: result.sourceLang, ms: result.ms });
  } catch (error) {
    const message = String(error?.message || error);
    if (isOrphanError(message) || !contextAlive()) {
      reportOrphaned();
      return;
    }
    render.markError(block);
    toast(`Hover Translate: ${message}`, { error: true, position: settings.toastPosition });
    reportStatus({ error: message });
  } finally {
    // No-op once the block is translated; drops the snapshot on skip or failure.
    render.discardSnapshot(block);
    render.clearPending(block);
    inFlight.delete(block);
  }
}

installHover({
  getConfig: () => settings,
  onTrigger: (target) => {
    handle(target).catch(() => {});
  },
  onEscape: () => {
    hideBubble();
    const count = render.revertAll() + hideAllImageOverlays();
    if (count) toast(`Restored ${count} block${count === 1 ? "" : "s"}.`, { position: settings.toastPosition });
  },
});
