// An overlay anchored under the block, for the display mode that must not touch the page at all.
// Lives in a closed shadow root so no page stylesheet can reach it and nothing leaks the other way.

let host = null;
let box = null;

function ensure() {
  if (host?.isConnected) return box;
  host = document.createElement("div");
  host.setAttribute("data-ht-ui", "");
  host.style.cssText = "all:initial;position:absolute;z-index:2147483646;top:0;left:0;";
  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `
    .b {
      font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
      background: #0f172a; color: #f1f5f9;
      padding: 10px 12px; border-radius: 8px;
      box-shadow: 0 8px 28px rgba(0,0,0,.35);
      border-left: 3px solid #0ea5e9;
      /* Sized by its own text, not by the block: a narrow cell used to give a narrow bubble that
         wrapped a short translation over many lines. */
      width: max-content; max-width: min(460px, 90vw);
      white-space: pre-wrap; overflow-wrap: break-word;
    }
    @media (prefers-color-scheme: light) {
      .b { background: #ffffff; color: #0f172a; box-shadow: 0 8px 28px rgba(15,23,42,.18); }
    }
  `;
  box = document.createElement("div");
  box.className = "b";
  shadow.append(style, box);
  (document.body || document.documentElement).append(host);
  return box;
}

// The pointer is still on the block when the bubble appears, and the trigger itself follows a
// mousemove, so dismissal is armed on a short delay rather than firing on the very next event.
let armed = false;
let armTimer = null;

function onMove() {
  if (armed) hideBubble();
}

export function showBubble(block, text) {
  const target = ensure();
  target.textContent = text;

  // Placed at the origin first so the shrink-wrapped width can be measured, then nudged back inside
  // the viewport if anchoring to the block would push it off the right edge.
  const rect = block.getBoundingClientRect();
  host.style.left = "0px";
  host.style.top = "0px";
  const width = host.getBoundingClientRect().width;
  const limit = scrollX + document.documentElement.clientWidth - width - 8;
  host.style.left = `${Math.round(Math.max(scrollX + 4, Math.min(rect.left + scrollX, limit)))}px`;
  host.style.top = `${Math.round(rect.bottom + scrollY + 6)}px`;

  armed = false;
  clearTimeout(armTimer);
  armTimer = setTimeout(() => {
    armed = true;
  }, 250);
  document.addEventListener("mousemove", onMove, { capture: true, passive: true });
  window.addEventListener("scroll", hideBubble, { capture: true, passive: true, once: true });
}

export function hideBubble() {
  clearTimeout(armTimer);
  armed = false;
  document.removeEventListener("mousemove", onMove, { capture: true });
  host?.remove();
  host = null;
  box = null;
}

export const bubbleVisible = () => Boolean(host?.isConnected);
