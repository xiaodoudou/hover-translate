// Lives in a closed shadow root so no page stylesheet can reach it, and nothing leaks the other way.

const POSITIONS = {
  "top-left": { top: "20px", left: "20px" },
  "top-center": { top: "20px", left: "50%", transform: "translateX(-50%)" },
  "top-right": { top: "20px", right: "20px" },
  "bottom-left": { bottom: "20px", left: "20px" },
  "bottom-center": { bottom: "20px", left: "50%", transform: "translateX(-50%)" },
  "bottom-right": { bottom: "20px", right: "20px" },
};

let host = null;
let timer = null;

function ensureHost() {
  if (host?.isConnected) return host;
  host = document.createElement("div");
  host.setAttribute("data-ht-ui", "");
  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `
    .t {
      font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
      background: #0f172a; color: #e2e8f0;
      padding: 9px 14px; border-radius: 8px;
      box-shadow: 0 6px 24px rgba(0,0,0,.35);
      max-width: 380px; white-space: pre-wrap;
      opacity: 0; transition: opacity .16s ease;
    }
    .t.show { opacity: 1; }
    .t.err { background: #7f1d1d; color: #fee2e2; }
  `;
  const box = document.createElement("div");
  box.className = "t";
  shadow.append(style, box);
  (document.body || document.documentElement).append(host);
  host.__box = box;
  return host;
}

export function toast(message, { error = false, duration = 2600, position = "bottom-center" } = {}) {
  if (position === "off" || !POSITIONS[position]) return;

  const box = ensureHost().__box;
  const place = POSITIONS[position];
  host.style.cssText = "all:initial;position:fixed;z-index:2147483647;";
  for (const [property, value] of Object.entries(place)) host.style[property] = value;

  box.textContent = message;
  box.classList.toggle("err", error);
  requestAnimationFrame(() => box.classList.add("show"));

  clearTimeout(timer);
  timer = setTimeout(() => {
    box.classList.remove("show");
    setTimeout(() => host?.remove(), 250);
  }, duration);
}
