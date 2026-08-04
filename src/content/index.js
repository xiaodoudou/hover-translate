import { resolveBlock } from "./block.js";
import { serialize, applyInPlace, rebuild } from "./richtext.js";
import { installHover } from "./hover.js";
import { toast } from "./toast.js";
import { showBubble, hideBubble } from "./bubble.js";
import * as render from "./render.js";
import { translateTexts } from "../engine/index.js";
import { getSettings, onSettingsChanged, DEFAULTS } from "../lib/settings.js";

const settings = { ...DEFAULTS, ...(await getSettings().catch(() => ({}))) };
render.setMarker(settings.displayMode);
onSettingsChanged((patch) => {
  Object.assign(settings, patch);
  if ("displayMode" in patch) render.setMarker(patch.displayMode);
});

const inFlight = new WeakSet();

const stripTags = (text) => text.replace(/<\/?b\d+>/g, "").replace(/\s{2,}/g, " ").trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function reportStatus(patch) {
  chrome.storage.local
    .set({ status: { ...patch, at: Date.now(), host: location.host } })
    .catch(() => {});
}

async function translatePlain(block) {
  const text = block.innerText || "";
  const result = await translateTexts([text], settings.targetLang, settings.providerOrder, text);
  if (result.same) return result;
  return { ...result, content: document.createTextNode(stripTags(result.texts[0])) };
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
    render.markError(block);
    const message = String(error?.message || error);
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
    const count = render.revertAll();
    if (count) toast(`Restored ${count} block${count === 1 ? "" : "s"}.`, { position: settings.toastPosition });
  },
});
