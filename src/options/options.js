import { getSettings, setSettings, DEFAULTS, KEYS, SHARED, targetForGroup } from "../lib/settings.js";

const LANGUAGES = [
  ["en", "English"], ["zh", "Chinese"], ["zh-Hant", "Chinese (traditional)"], ["ja", "Japanese"],
  ["ko", "Korean"], ["ru", "Russian"], ["ar", "Arabic"], ["hi", "Hindi"], ["bn", "Bengali"],
  ["es", "Spanish"], ["fr", "French"], ["de", "German"], ["it", "Italian"], ["pt", "Portuguese"],
  ["nl", "Dutch"], ["pl", "Polish"], ["tr", "Turkish"], ["vi", "Vietnamese"], ["th", "Thai"],
  ["id", "Indonesian"], ["uk", "Ukrainian"], ["sv", "Swedish"], ["he", "Hebrew"], ["fa", "Persian"],
];

const PROVIDER_LABELS = {
  google: "Google",
  tencent: "Tencent",
  mymemory: "MyMemory",
  cache: "Cached",
  skipped: "Skipped",
  yandex: "Yandex",
  youdao: "Youdao",
  lens: "Google Lens",
};

const ALL_PROVIDERS = ["tencent", "google", "mymemory"];
const ALL_OCR_PROVIDERS = ["youdao", "lens", "yandex"];
// Filled in by the Test button: id -> { ok, detail }
const verdicts = new Map();

const $ = (id) => document.getElementById(id);
const setKeyHint = (label) => {
  for (const el of document.querySelectorAll("#key-hint, .key-hint")) el.textContent = label;
};
const KEY_LABELS = { Control: "Ctrl", Shift: "Shift" };
// The select carries both halves of the trigger in one value, because "Ctrl twice" is one choice to
// the user even though it is two settings underneath.
const triggerValue = (key, taps) => `${key}:${taps === 2 ? 2 : 1}`;
const triggerLabel = (key, taps) => (taps === 2 ? `${KEY_LABELS[key]} twice` : KEY_LABELS[key]);
// Both selects are filled from the one list of keys that can actually be counted, so neither can
// offer a key the rest of the extension refuses.
const KEY_CHOICES = [...KEYS.map((key) => [key, 1]), ...KEYS.map((key) => [key, 2])];
const fillKeys = (select) => {
  for (const [key, taps] of KEY_CHOICES) select.append(new Option(triggerLabel(key, taps), triggerValue(key, taps)));
};
// The quick select carries a third kind of answer beside a key and off: riding the trigger's press.
const quickChoice = (key, taps) => (key && key !== SHARED ? triggerValue(key, taps) : key);

// Named by writing system rather than by language, because that is what a selection can be sorted by
// without asking anyone: the popup should not promise a distinction the code cannot make.
const QUICK_LABELS = {
  latin: "Latin (EN, FR, ES)",
  han: "Han (Chinese)",
  kana: "Japanese",
  hangul: "Korean",
  cyrillic: "Cyrillic (RU, UK)",
  arabic: "Arabic",
  other: "Everything else",
};

// The list is the failover order: enabled ids first, in the user's order, disabled ones after.
function renderProviders(order, onChange, listId = "providers", all = ALL_PROVIDERS) {
  const enabled = order.filter((id) => all.includes(id));
  const rows = [...enabled, ...all.filter((id) => !enabled.includes(id))];
  const list = $(listId);
  list.replaceChildren();

  for (const [index, id] of rows.entries()) {
    const on = enabled.includes(id);
    const item = document.createElement("li");

    const tick = document.createElement("input");
    tick.type = "checkbox";
    tick.checked = on;
    tick.addEventListener("change", () =>
      onChange(tick.checked ? [...enabled, id] : enabled.filter((x) => x !== id)),
    );

    const name = document.createElement("span");
    name.className = "provider-name";
    name.textContent = PROVIDER_LABELS[id];
    if (!on) name.classList.add("off");

    const note = document.createElement("small");
    const verdict = verdicts.get(id);
    if (verdict) {
      note.textContent = verdict.ok ? `✓ ${verdict.detail}` : `✗ ${verdict.detail}`;
      note.className = verdict.ok ? "ok" : "bad";
      note.title = verdict.title || "";
    }

    const up = document.createElement("button");
    up.textContent = "↑";
    up.title = "Move up";
    up.disabled = !on || enabled.indexOf(id) < 1;
    up.addEventListener("click", () => {
      const next = [...enabled];
      const at = next.indexOf(id);
      [next[at - 1], next[at]] = [next[at], next[at - 1]];
      onChange(next);
    });

    const down = document.createElement("button");
    down.textContent = "↓";
    down.title = "Move down";
    down.disabled = !on || enabled.indexOf(id) === enabled.length - 1;
    down.addEventListener("click", () => {
      const next = [...enabled];
      const at = next.indexOf(id);
      [next[at], next[at + 1]] = [next[at + 1], next[at]];
      onChange(next);
    });

    const rank = document.createElement("b");
    rank.className = "rank";
    rank.textContent = on ? `${enabled.indexOf(id) + 1}` : "";

    item.append(tick, rank, name, note, up, down);
    item.dataset.index = String(index);
    list.append(item);
  }
}

function setStat(el, text, tone) {
  el.textContent = text;
  el.className = tone || "";
}

const formatDuration = (ms) =>
  ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;

// An engine can be a pair, "lens+google", when one reads the image and another translates it.
const engineLabel = (engine) =>
  String(engine || "")
    .split("+")
    .map((id) => PROVIDER_LABELS[id] || id)
    .join(" + ");

function showStat(el, status) {
  if (!status) return;
  // Seconds would push the line past the popup width, and they add nothing here.
  const when = new Date(status.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  if (status.error) {
    setStat(el, `Failed at ${when}`, "bad");
    el.title = status.error;
    return;
  }

  const took = typeof status.ms === "number" ? `, took ${formatDuration(status.ms)}` : "";
  setStat(el, `${engineLabel(status.engine)} at ${when}${took}`, "ok");
  el.title = [status.host, status.sourceLang && `detected ${status.sourceLang}`]
    .filter(Boolean)
    .join(" ");
}

async function refreshLastBlock() {
  const { status, imageStatus } = await chrome.storage.local.get(["status", "imageStatus"]);
  showStat($("stat-text"), status);
  showStat($("stat-image"), imageStatus);
}

async function main() {
  for (const [code, name] of LANGUAGES) $("target").append(new Option(`${name} (${code})`, code));

  const settings = await getSettings();
  $("target").value = settings.targetLang;
  $("mode").value = settings.displayMode;
  $("clipped").value = settings.clippedLines;
  // Anyone still holding the "always slide" setting that was dropped lands on the default rather
  // than on a select showing nothing.
  if (!$("clipped").value) $("clipped").value = DEFAULTS.clippedLines;
  fillKeys($("trigger"));
  $("trigger").value = triggerValue(settings.triggerKey, settings.triggerTaps);
  $("aim").value = settings.aimOutline ? "yes" : "no";

  $("quick").append(new Option("With the trigger key (default)", SHARED));
  $("quick").append(new Option("Off", ""));
  fillKeys($("quick"));
  $("quick").value = quickChoice(settings.quickKey, settings.quickTaps);

  let quickOrder = settings.quickOrder;
  const saveOrder = (next) => {
    // The row that ends up on top has nothing above it to mean, so it keeps the language it was
    // resolving to a moment ago rather than silently becoming the whole list's answer.
    if (!next[0].lang) next[0].lang = targetForGroup(quickOrder, next[0].group, $("target").value);
    quickOrder = next;
    setSettings({ quickOrder });
    renderQuickRows();
  };

  function renderQuickRows() {
    const list = $("quick-rows");
    list.replaceChildren();
    for (const [index, row] of quickOrder.entries()) {
      const item = document.createElement("li");

      const name = document.createElement("span");
      name.className = "provider-name";
      name.textContent = QUICK_LABELS[row.group] || row.group;

      const select = document.createElement("select");
      // Only ever an answer for a row with something above it to point at.
      if (index > 0) select.append(new Option("Same as above", ""));
      for (const [code, language] of LANGUAGES) select.append(new Option(`${language} (${code})`, code));
      select.value = row.lang || "";
      select.addEventListener("change", () => {
        quickOrder = quickOrder.map((r) => (r.group === row.group ? { ...r, lang: select.value } : r));
        setSettings({ quickOrder });
      });

      const up = document.createElement("button");
      up.textContent = "↑";
      up.title = "Move up";
      up.disabled = index === 0;
      up.addEventListener("click", () => {
        const next = quickOrder.map((r) => ({ ...r }));
        [next[index - 1], next[index]] = [next[index], next[index - 1]];
        saveOrder(next);
      });

      const down = document.createElement("button");
      down.textContent = "↓";
      down.title = "Move down";
      down.disabled = index === quickOrder.length - 1;
      down.addEventListener("click", () => {
        const next = quickOrder.map((r) => ({ ...r }));
        [next[index], next[index + 1]] = [next[index + 1], next[index]];
        saveOrder(next);
      });

      item.append(name, select, up, down);
      list.append(item);
    }
  }
  renderQuickRows();

  const showQuick = (value) => {
    $("quick-map").hidden = !value;
    $("quick-step").hidden = !value;
    if (!value) return;
    const [key, taps] = value === SHARED ? $("trigger").value.split(":") : value.split(":");
    $("quick-hint").textContent = triggerLabel(key, Number(taps));
  };
  showQuick($("quick").value);

  let currentOrder = settings.providerOrder;
  const paint = (order) => {
    currentOrder = order;
    renderProviders(order, (next) => {
      setSettings({ providerOrder: next });
      paint(next);
    });
  };
  paint(currentOrder);

  // Reading an image on another site is a cross-origin fetch, so it needs a host permission. That
  // is asked for at the moment images are switched on, which is both the only place a click can
  // carry the request and the only place the reason for it is obvious.
  const imageOn = $("image-on");
  const granted = () => chrome.permissions.contains({ origins: ["<all_urls>"] });

  const showImageSettings = async (on) => {
    imageOn.value = on ? "yes" : "no";
    $("image-settings").hidden = !on;
    // Only ever shown to repair a permission that was refused or later revoked.
    $("grant").hidden = !on || (await granted().catch(() => true));
  };
  await showImageSettings(settings.translateImages);

  imageOn.addEventListener("change", async (e) => {
    if (e.target.value !== "yes") {
      setSettings({ translateImages: false });
      // Handing the permission back when the feature is off, rather than keeping it for nothing.
      await chrome.permissions.remove({ origins: ["<all_urls>"] }).catch(() => false);
      await showImageSettings(false);
      return;
    }
    const ok = (await granted().catch(() => false)) ||
      (await chrome.permissions.request({ origins: ["<all_urls>"] }).catch(() => false));
    // Refused: almost every image on a page would fail to load, so this stays off rather than
    // being switched on into something that cannot work.
    setSettings({ translateImages: ok });
    await showImageSettings(ok);
  });

  $("grant").addEventListener("click", async () => {
    await chrome.permissions.request({ origins: ["<all_urls>"] }).catch(() => false);
    await showImageSettings(true);
  });

  let ocrOrder = settings.imageOcrOrder;
  const paintOcr = (order) => {
    ocrOrder = order;
    renderProviders(
      order,
      (next) => {
        setSettings({ imageOcrOrder: next });
        paintOcr(next);
      },
      "ocr-providers",
      ALL_OCR_PROVIDERS,
    );
  };
  paintOcr(ocrOrder);

  // Each recogniser gets the same drawn-on-the-spot sign rather than a bundled asset: no binary to
  // ship, and it exercises the very path a page image takes.
  const probeImage = () => {
    const canvas = document.createElement("canvas");
    canvas.width = 420;
    canvas.height = 150;
    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#111111";
    context.font = '44px "Microsoft YaHei", "SimHei", system-ui, sans-serif';
    context.fillText("欢迎光临本店", 30, 62);
    context.font = '34px "Microsoft YaHei", "SimHei", system-ui, sans-serif';
    context.fillText("请勿吸烟", 30, 120);
    return canvas.toDataURL("image/png");
  };

  $("test-image").addEventListener("click", async () => {
    const button = $("test-image");
    button.disabled = true;
    button.textContent = "Testing...";
    for (const id of ALL_OCR_PROVIDERS) verdicts.delete(id);
    paintOcr(ocrOrder);

    const image = probeImage();
    for (const id of ALL_OCR_PROVIDERS) {
      try {
        const started = Date.now();
        const response = await chrome.runtime.sendMessage({
          type: "ocr",
          image,
          order: [id],
          targetLang: $("target").value,
        });
        if (response?.error) throw new Error(response.error);
        const took = Date.now() - started;
        // A recogniser answers with either laid-out lines or a picture of its own; both count.
        const lines = response?.lines?.length || 0;
        const served = response?.engine === id && (lines > 0 || Boolean(response?.image));
        verdicts.set(id, {
          ok: served,
          detail: served ? `${took} ms` : "no text found",
          title: response?.image
            ? "returned its own translated picture"
            : (response?.lines || []).map((line) => line.text).join(" / "),
        });
      } catch (error) {
        verdicts.set(id, { ok: false, detail: "failed", title: String(error?.message || error) });
      }
      paintOcr(ocrOrder);
    }

    button.disabled = false;
    button.textContent = "Test providers";
  });

  // Asks each provider for one short translation on its own, so a failure is attributed to the
  // provider that actually failed rather than hidden by the failover.
  $("test").addEventListener("click", async () => {
    const button = $("test");
    button.disabled = true;
    button.textContent = "Testing...";
    verdicts.clear();
    paint(currentOrder);

    for (const id of ALL_PROVIDERS) {
      try {
        const started = Date.now();
        const response = await chrome.runtime.sendMessage({
          type: "translate",
          texts: ["你好，世界"],
          targetLang: $("target").value,
          order: [id],
        });
        if (response?.error) throw new Error(response.error);
        const took = Date.now() - started;
        verdicts.set(id, {
          ok: response?.engine === id,
          detail: response?.engine === id ? `${took} ms` : "wrong provider",
          title: response?.texts?.[0] || "",
        });
      } catch (error) {
        verdicts.set(id, { ok: false, detail: "failed", title: String(error?.message || error) });
      }
      paint(currentOrder);
    }

    button.disabled = false;
    button.textContent = "Test providers";
  });
  $("version").textContent = `Version ${chrome.runtime.getManifest().version}`;
  $("minloading").value = settings.minLoadingMs;
  $("minloading-value").textContent = `${settings.minLoadingMs} ms`;
  $("toasts").value = settings.toastPosition;
  setKeyHint(triggerLabel(settings.triggerKey, settings.triggerTaps));

  await refreshLastBlock();

  $("target").addEventListener("change", (e) => setSettings({ targetLang: e.target.value }));
  $("mode").addEventListener("change", (e) => setSettings({ displayMode: e.target.value }));
  $("clipped").addEventListener("change", (e) => setSettings({ clippedLines: e.target.value }));
  $("trigger").addEventListener("change", (e) => {
    const [key, taps] = e.target.value.split(":");
    setSettings({ triggerKey: key, triggerTaps: Number(taps) });
    setKeyHint(triggerLabel(key, Number(taps)));
    showQuick($("quick").value);
  });
  $("quick").addEventListener("change", (e) => {
    const value = e.target.value;
    const [key = "", taps] = value.split(":");
    setSettings(value === SHARED ? { quickKey: SHARED } : { quickKey: key, quickTaps: Number(taps) || 2 });
    showQuick(value);
  });
  $("aim").addEventListener("change", (e) => setSettings({ aimOutline: e.target.value === "yes" }));
  $("minloading").addEventListener("input", (e) => {
    $("minloading-value").textContent = `${e.target.value} ms`;
    setSettings({ minLoadingMs: Number(e.target.value) });
  });
  $("toasts").addEventListener("change", (e) => setSettings({ toastPosition: e.target.value }));
}

main();
