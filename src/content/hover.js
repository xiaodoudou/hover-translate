// Tracks what the pointer is over and decides when a key means "translate this".
//
// Two things a key can mean here. The trigger acts on the block under the pointer; quick translate
// acts on the selection instead. By default they are the same key, and the pointer says which was
// meant: over a selection a press takes that, anywhere else it takes the block. Quick translate can
// be given a key of its own, which then always means the selection wherever it is; that key cannot
// be the trigger's own, since a double tap contains a single one and whichever was the shorter would
// swallow the other before it finished.
//
// Nothing happens until the key is released. While it is down the block under the pointer is only
// outlined, so holding the key is how you aim and letting go is how you commit: the two cannot be
// confused, and a press you think better of costs nothing as long as another key goes down first.
// Shortcuts stay safe because what actually distinguishes Ctrl+C from a bare Ctrl is the second key,
// not how long the key was held: any other keydown, a click or a wheel while the key is down cancels
// the press outright.
//
// With two taps the key must be tapped twice within doubleTapMs. Only the second press acts: the
// first is remembered and does nothing, so the modifier keeps its ordinary meaning until the user
// asks for it twice. Everything after that is identical, holding the second press included.
import { SHARED } from "../lib/settings.js";

export function installHover({ getConfig, onTrigger, onAim, onEscape, onQuick }) {
  let hovered = null;
  let pointer = null;
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

  // One press counter per key that means something. The key is read on every event rather than kept,
  // so changing it in the popup takes effect on the next press instead of the next page load.
  function counter({ keyOf, tapsOf, onArm, onCommit, onDrop }) {
    let keyHeld = false;
    let cancelled = false;
    // Whether this press is the one that acts. Always true on a single-tap key; on a double-tap key
    // only the press that follows a clean tap in time.
    let armed = false;
    let lastTapAt = 0;

    const reset = () => {
      keyHeld = false;
      cancelled = false;
      armed = false;
      onDrop?.();
    };

    // Keeps keyHeld true so the pending keyup is swallowed rather than treated as a tap.
    const abort = () => {
      if (!keyHeld) return;
      cancelled = true;
      onDrop?.();
    };

    return {
      get live() {
        return keyHeld && armed && !cancelled;
      },
      reset,
      // A half-finished pair must not survive the user leaving: coming back to the tab and pressing
      // the key once would otherwise act on whatever is under the pointer or selected.
      forget() {
        lastTapAt = 0;
        reset();
      },
      abort,
      keyDown(event) {
        const key = keyOf();
        if (!key) return;
        if (event.key !== key) {
          abort();
          // A key in between is a shortcut being typed, not a pair being completed.
          lastTapAt = 0;
          return;
        }
        if (event.repeat || keyHeld) return;
        reset();
        keyHeld = true;
        armed = tapsOf() !== 2 || Date.now() - lastTapAt < getConfig().doubleTapMs;
        if (armed) onArm?.();
      },
      keyUp(event) {
        if (event.key !== keyOf()) return;
        const clean = keyHeld && !cancelled;
        // A clean tap that was not the acting press is the first half of a pair: remember when it
        // ended so the next press can pair with it. Anything else starts the count over.
        lastTapAt = clean && !armed ? Date.now() : 0;
        const act = clean && armed;
        if (act) onCommit();
        reset();
      },
    };
  }

  // What a release right now would act on, so the user can see it before committing. Only while the
  // press is armed: on a double-tap trigger the first press does nothing, and showing a target for
  // it would promise something that is not going to happen.
  const showAim = () => onAim?.(trigger.live && inThisFrame() ? hovered : null, pointer);

  const fire = (target) => {
    if (!target || !inThisFrame()) return;
    // Handed over to the loading state: two markers on one block is noise.
    onAim?.(null);
    onTrigger(target);
  };

  const shares = () => getConfig().quickKey === SHARED;

  const trigger = counter({
    keyOf: () => getConfig().triggerKey,
    tapsOf: () => getConfig().triggerTaps,
    onArm: showAim,
    // Sharing the key, the selection is asked first: it is the more exact of the two instructions,
    // and it answers only for a selection the pointer is actually on.
    onCommit: () => {
      if (shares() && inThisFrame() && onQuick?.(pointer)) return;
      fire(hovered);
    },
    onDrop: () => onAim?.(null),
  });

  // Silent whenever it would answer to the trigger's key: that press is already counted above, and
  // counting it twice would fire both meanings at once.
  const quick = counter({
    keyOf: () => {
      const { quickKey, triggerKey } = getConfig();
      return quickKey && quickKey !== SHARED && quickKey !== triggerKey ? quickKey : "";
    },
    tapsOf: () => getConfig().quickTaps,
    onCommit: () => onQuick?.(),
  });

  const counters = [trigger, quick];

  document.addEventListener(
    "mousemove",
    (event) => {
      // composedPath sees through an open shadow root; event.target alone is retargeted to the host,
      // whose own text is empty, so a shadow-rendered message would never resolve to anything.
      hovered = event.composedPath?.()[0] || event.target;
      pointer = { x: event.clientX, y: event.clientY };
      if (!trigger.live || queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        if (trigger.live) showAim();
      });
    },
    { passive: true, capture: true },
  );

  const onKeyDown = (event) => {
    if (event.key === "Escape") {
      onEscape();
      return;
    }
    for (const press of counters) press.keyDown(event);
  };

  const onKeyUp = (event) => {
    for (const press of counters) press.keyUp(event);
  };

  // Ctrl+click opens a link and Ctrl+wheel zooms; neither is a translate request.
  const onAbort = () => {
    for (const press of counters) press.abort();
  };
  const onForget = () => {
    for (const press of counters) press.forget();
  };

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
    target.addEventListener("mousedown", onAbort, { capture: true });
    target.addEventListener("wheel", onAbort, { passive: true, capture: true });
  }

  window.addEventListener("blur", onForget);
  document.addEventListener("visibilitychange", onForget);
}
