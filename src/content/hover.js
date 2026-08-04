// Tracks what the pointer is over and decides when the trigger key means "translate this".
//
// A tap fires on key release, so a quick press works. Shortcuts stay safe because what actually
// distinguishes Ctrl+C from a bare Ctrl is the second key, not how long the key was held: any other
// keydown, a click or a wheel while the key is down cancels the press outright.
// Holding the key past holdDelay starts sweep mode, where each block the pointer lands on translates.
export function installHover({ getConfig, onTrigger, onEscape }) {
  let hovered = null;
  let keyHeld = false;
  let firedThisPress = false;
  let cancelled = false;
  let timer = null;
  let lastFired = null;
  let queued = false;

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
    if (!target) return;
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
      hovered = event.target;
      if (!keyHeld || cancelled || queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        if (keyHeld && !cancelled && hovered !== lastFired) schedule();
      });
    },
    { passive: true, capture: true },
  );

  document.addEventListener(
    "keydown",
    (event) => {
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
    },
    { capture: true },
  );

  document.addEventListener(
    "keyup",
    (event) => {
      if (event.key !== getConfig().triggerKey) return;
      if (keyHeld && !cancelled && !firedThisPress) fire(hovered);
      reset();
    },
    { capture: true },
  );

  // Ctrl+click opens a link and Ctrl+wheel zooms; neither is a translate request.
  document.addEventListener("mousedown", () => keyHeld && abort(), { capture: true });
  document.addEventListener("wheel", () => keyHeld && abort(), { passive: true, capture: true });

  window.addEventListener("blur", reset);
  document.addEventListener("visibilitychange", reset);
}
