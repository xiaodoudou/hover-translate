// Tracks what the pointer is over and decides when the trigger key means "translate this".
//
// A tap fires on key release, so a quick press works. Shortcuts stay safe because what actually
// distinguishes Ctrl+C from a bare Ctrl is the second key, not how long the key was held: any other
// keydown, a click or a wheel while the key is down cancels the press outright.
// Holding the key past holdDelay starts sweep mode, where each block the pointer lands on translates.
//
// With triggerTaps at 2 the key must be tapped twice within doubleTapMs. Only the second press acts:
// the first is remembered and does nothing, so the modifier keeps its ordinary meaning until the
// user asks for it twice. Everything after that is identical, holding the second press included.
export function installHover({ getConfig, onTrigger, onEscape }) {
  let hovered = null;
  let pointer = null;
  let keyHeld = false;
  let firedThisPress = false;
  let cancelled = false;
  // Whether this press is the one that acts. Always true on a single-tap trigger; on a double-tap
  // trigger only the press that follows a clean tap in time.
  let armed = false;
  let lastTapAt = 0;
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
    armed = false;
    lastFired = null;
    clearTimeout(timer);
    timer = null;
  };

  // A half-finished pair must not survive the user leaving: coming back to the tab and pressing the
  // key once would otherwise translate whatever happens to be under the pointer.
  const forget = () => {
    lastTapAt = 0;
    reset();
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
      if (!keyHeld || !armed || cancelled || queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        if (keyHeld && armed && !cancelled && hovered !== lastFired) schedule();
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
      // A key in between is a shortcut being typed, not a pair being completed.
      lastTapAt = 0;
      return;
    }
    if (event.repeat || keyHeld) return;
    const { triggerTaps, doubleTapMs } = getConfig();
    const paired = Date.now() - lastTapAt < doubleTapMs;
    reset();
    keyHeld = true;
    armed = triggerTaps !== 2 || paired;
    if (armed) schedule();
  };

  const onKeyUp = (event) => {
    if (event.key !== getConfig().triggerKey) return;
    const clean = keyHeld && !cancelled && !firedThisPress;
    // A clean tap that was not the acting press is the first half of a pair: remember when it ended
    // so the next press can pair with it. Anything else, sweeping included, starts the count over.
    lastTapAt = clean && !armed ? Date.now() : 0;
    if (clean && armed) fire(hovered);
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

  window.addEventListener("blur", forget);
  document.addEventListener("visibilitychange", forget);
}
