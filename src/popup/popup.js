import { getSettings, setSettings } from "../lib/settings.js";

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
};

const ALL_PROVIDERS = ["tencent", "google", "mymemory"];
// Filled in by the Test button: id -> { ok, detail }
const verdicts = new Map();

const $ = (id) => document.getElementById(id);
const setKeyHint = (label) => {
  for (const el of document.querySelectorAll("#key-hint, .key-hint")) el.textContent = label;
};
const KEY_LABELS = { Control: "Ctrl", Alt: "Alt", Shift: "Shift" };

// The list is the failover order: enabled ids first, in the user's order, disabled ones after.
function renderProviders(order, onChange) {
  const enabled = order.filter((id) => ALL_PROVIDERS.includes(id));
  const rows = [...enabled, ...ALL_PROVIDERS.filter((id) => !enabled.includes(id))];
  const list = $("providers");
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

async function refreshLastBlock() {
  const { status } = await chrome.storage.local.get("status");
  if (!status) return;
  // Seconds would push the line past the popup width, and they add nothing here.
  const when = new Date(status.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  if (status.error) {
    setStat($("stat-last"), `Failed at ${when}`, "bad");
    $("stat-last").title = status.error;
    return;
  }

  const provider = PROVIDER_LABELS[status.engine] || status.engine;
  const took = typeof status.ms === "number" ? `, took ${formatDuration(status.ms)}` : "";
  setStat($("stat-last"), `${provider} at ${when}${took}`, "ok");
  $("stat-last").title = [status.host, status.sourceLang && `detected ${status.sourceLang}`]
    .filter(Boolean)
    .join(" ");
}

async function main() {
  for (const [code, name] of LANGUAGES) $("target").append(new Option(`${name} (${code})`, code));

  const settings = await getSettings();
  $("target").value = settings.targetLang;
  $("mode").value = settings.displayMode;
  $("trigger").value = settings.triggerKey;

  let currentOrder = settings.providerOrder;
  const paint = (order) => {
    currentOrder = order;
    renderProviders(order, (next) => {
      setSettings({ providerOrder: next });
      paint(next);
    });
  };
  paint(currentOrder);

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
  $("minloading").value = settings.minLoadingMs;
  $("minloading-value").textContent = `${settings.minLoadingMs} ms`;
  $("toasts").value = settings.toastPosition;
  setKeyHint(KEY_LABELS[settings.triggerKey]);

  await refreshLastBlock();

  $("target").addEventListener("change", (e) => setSettings({ targetLang: e.target.value }));
  $("mode").addEventListener("change", (e) => setSettings({ displayMode: e.target.value }));
  $("trigger").addEventListener("change", (e) => {
    setSettings({ triggerKey: e.target.value });
    setKeyHint(KEY_LABELS[e.target.value]);
  });
  $("minloading").addEventListener("input", (e) => {
    $("minloading-value").textContent = `${e.target.value} ms`;
    setSettings({ minLoadingMs: Number(e.target.value) });
  });
  $("toasts").addEventListener("change", (e) => setSettings({ toastPosition: e.target.value }));
}

main();
