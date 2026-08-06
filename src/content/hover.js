// Tracks what the pointer is over and decides when the trigger key means "translate this".
//
// A tap fires on key release, so a quick press works. Shortcuts stay safe because what actually
// distinguishes Ctrl+C from a bare Ctrl is the second key, not how long the key was held: any other
// keydown, a click or a wheel while the key is down cancels the press outright.
// Holding the key past holdDelay starts sweep mode, where each block the pointer lands on translates.
export function installHover({ getConfig, onTrigger, onEscape }) {
  let hovered = null;
  let pointer = null;
  let keyHeld = false;
  let firedThisPress = false;
  let cancelled = false;
  let timer = null;
  let lastFired = null;
  let queued = false;

  // Mouse events go to the innermost frame under the pointer; key events go to whichever frame has
  // focus. In a page whose content sits in an iframe those are two different documents, so the frame
  // holding the chat never hears the key and the focused frame fires on something the pointer left
  // long ago. Every frame therefore listens on the top document as well when it can reach it, and
  // each one checks the pointer is really over itself before acting.
  const inThisFrame = () => {
    if (!pointer) return false;
    const at = document.elementFromPoint(pointer.x, pointer.y);
    // Outside this frame's viewport, or over a nested frame that owns the pointer instead.
    return Boolean(at) && at.tagName !== "IFRAME" && at.tagName !== "FRAME";
  };

  const reset = () => {
    keyHeld = false;
    firedThisPress = false;
    cancelled = false;
    lastFired = null;
    clearTimeout(timer);
    timer = null;
  };

  // Keeps keyHeld true so the pending keyup is swallowed rather than treated as a tap.
  const abort = () => {
    cancelled = true;
    clearTimeout(timer);
    timer = null;
  };

  const fire = (target) => {
    if (!target || !inThisFrame()) return;
    firedThisPress = true;
    lastFired = target;
    onTrigger(target);
  };

  const schedule = () => {
    clearTimeout(timer);
    const target = hovered;
    timer = setTimeout(() => {
      if (keyHeld && !cancelled) fire(target);
    }, getConfig().holdDelay);
  };

  document.addEventListener(
    "mousemove",
    (event) => {
      // composedPath sees through an open shadow root; event.target alone is retargeted to the host,
      // whose own text is empty, so a shadow-rendered message would never resolve to anything.
      hovered = event.composedPath?.()[0] || event.target;
      pointer = { x: event.clientX, y: event.clientY };
      if (!keyHeld || cancelled || queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        if (keyHeld && !cancelled && hovered !== lastFired) schedule();
      });
    },
    { passive: true, capture: true },
  );

  const onKeyDown = (event) => {
    if (event.key === "Escape") {
      onEscape();
      return;
    }
    if (event.key !== getConfig().triggerKey) {
      if (keyHeld) abort();
      return;
    }
    if (event.repeat || keyHeld) return;
    reset();
    keyHeld = true;
    schedule();
  };

  const onKeyUp = (event) => {
    if (event.key !== getConfig().triggerKey) return;
    if (keyHeld && !cancelled && !firedThisPress) fire(hovered);
    reset();
  };

  // Ctrl+click opens a link and Ctrl+wheel zooms; neither is a translate request.
  const onMouseDown = () => keyHeld && abort();
  const onWheel = () => keyHeld && abort();

  // Key events reach only the focused document, so a framed page needs the listeners on the top one
  // too. Cross-origin frames cannot reach it and simply keep their own; those still work whenever
  // the user has clicked inside the frame, which is what gives it focus.
  const keyTargets = [document];
  try {
    if (window !== window.top && window.top.document !== document) keyTargets.push(window.top.document);
  } catch {
    /* cross-origin top: unreachable, and nothing to do about it from here */
  }

  for (const target of keyTargets) {
    target.addEventListener("keydown", onKeyDown, { capture: true });
    target.addEventListener("keyup", onKeyUp, { capture: true });
    target.addEventListener("mousedown", onMouseDown, { capture: true });
    target.addEventListener("wheel", onWheel, { passive: true, capture: true });
  }

  window.addEventListener("blur", reset);
  document.addEventListener("visibilitychange", reset);
}
