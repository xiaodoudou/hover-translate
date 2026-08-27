// Tracks what the pointer is over and decides when a key means "translate this".
//
// Two things a key can mean here. The trigger acts on the block under the pointer; quick translate
// acts on the selection instead. By default they are the same key, and the pointer says which was
// meant: over a selection, or in a field holding one, a press takes that, and anywhere else it takes
// the block. The two counts can differ on that one key, since the press is handed to one counter or
// the other before either of them counts it. Quick translate can also be given a key of its own,
// which then means the selection wherever it is.
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
//
// Frames are the awkward part. Mouse events go to the innermost frame under the pointer; key events
// go to whichever frame has focus. On a page whose chat sits two or three frames deep those are
// never the same document, and a cross-origin ancestor cannot be reached to listen on at all. So
// each frame handles what its own document gets and then passes it to its neighbours by postMessage,
// hop by hop, until the whole tree has seen the press. Every frame then asks whether it owns the
// press, and exactly one of them does.
import { SHARED } from "../lib/settings.js";

const FRAME_TAGS = /^(?:IFRAME|FRAME)$/;

// Enough of a press to replay it in another frame, and no more.
const RELAY = "hover-translate:key";
const KINDS = new Set(["keydown", "keyup", "abort", "forget", "restored", "pointer"]);
// Ceiling on what a page can spend by forging the payload. Nothing here is authentication: message
// events reach the isolated world, and any frame on the page can post one. What actually decides
// whether a press does anything is owns(), which answers to the pointer and to focus rather than to
// anything in the message.
const BURST = 50;
const BURST_MS = 100;
// Long enough for the frames below to report what they restored, short enough not to read as lag.
const ESCAPE_SETTLE = 80;
const SEEN_MAX = 64;

export function installHover({
  getConfig, onTrigger, onAim, onEscape, onRestored, onQuick, quickReady,
}) {
  let hovered = null;
  let pointer = null;
  let queued = false;

  // --- the relay ----------------------------------------------------------
  const nonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  let sent = 0;
  const seen = new Set();
  let burst = 0;
  let burstAt = 0;

  // Unique paths through a frame tree already deliver each message once. This covers the case they
  // do not: event.source reads null when the sender has detached, so the message is passed back the
  // way it came. A Set keeps insertion order, so deleting the first entry evicts the oldest.
  const fresh = (id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value);
    return true;
  };

  const post = (target, payload) => {
    try {
      target?.postMessage(payload, "*");
    } catch {
      /* frame torn down between the snapshot and the send */
    }
  };

  // Every neighbour but the one it arrived from. Reaching parent and frames needs no guard of its
  // own: both are readable across origins, which is the whole reason the relay goes through them
  // rather than through the top document.
  const spread = (payload, from) => {
    if (window !== window.top && window.parent !== from) post(window.parent, payload);
    const children = window.length;
    for (let i = 0; i < children; i++) {
      const child = window.frames[i];
      if (child && child !== from) post(child, payload);
    }
  };

  const relay = (payload) => {
    const full = { ht: RELAY, id: `${nonce}:${++sent}`, ...payload };
    fresh(full.id);
    spread(full, null);
  };

  // --- press counters -----------------------------------------------------

  // One press counter per key that means something. The key is read on every event rather than kept,
  // so changing it in the popup takes effect on the next press instead of the next page load.
  //
  // `at` is when the press happened in the frame it happened in, not when this frame got to it. A
  // pair of taps is measured against doubleTapMs, and a frame busy enough to deliver the relay late
  // would otherwise fail to pair two taps that were well inside the window.
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
      get pressing() {
        return keyHeld;
      },
      // Half of a pair, waiting for the second tap.
      get pending() {
        return lastTapAt > 0;
      },
      reset,
      // A half-finished pair must not survive the user leaving: coming back to the tab and pressing
      // the key once would otherwise act on whatever is under the pointer or selected.
      forget() {
        lastTapAt = 0;
        reset();
      },
      abort,
      keyDown(key, repeat, at) {
        const want = keyOf();
        if (!want) return;
        if (key !== want) {
          abort();
          // A key in between is a shortcut being typed, not a pair being completed.
          lastTapAt = 0;
          return;
        }
        if (repeat || keyHeld) return;
        reset();
        keyHeld = true;
        armed = tapsOf() !== 2 || at - lastTapAt < getConfig().doubleTapMs;
        if (armed) onArm?.();
      },
      keyUp(key, at) {
        if (key !== keyOf()) return;
        const clean = keyHeld && !cancelled;
        // A clean tap that was not the acting press is the first half of a pair: remember when it
        // ended so the next press can pair with it. Anything else starts the count over.
        lastTapAt = clean && !armed ? at : 0;
        const act = clean && armed;
        if (act) onCommit();
        reset();
      },
    };
  }

  // --- which frame owns the press ----------------------------------------

  // The pointer is over this frame, and over content of its own rather than a frame nested in it.
  const inThisFrame = () => {
    if (!pointer) return false;
    const at = document.elementFromPoint(pointer.x, pointer.y);
    return Boolean(at) && !FRAME_TAGS.test(at.tagName);
  };

  // document.hasFocus() is true in every ancestor of the focused frame as well, so it names several
  // documents at once; the innermost is the one whose activeElement is not itself a frame.
  const focusedHere = () =>
    document.hasFocus() && !FRAME_TAGS.test(document.activeElement?.tagName || "");

  // On the shared key the pointer decides, exactly as it decides which of the two meanings a press
  // has. On a key of its own quick translate takes the selection wherever it is, which is the frame
  // holding focus rather than the one under the pointer.
  const owns = () => (sharing() ? inThisFrame() : focusedHere());

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

  // SHARED is the trigger's own key and its own count, so the two are told apart by what is under
  // the pointer rather than by which key was pressed. Naming that key outright does the same, and
  // then the counts may differ: one tap for the block, two for the selection, on the one modifier.
  const quickKeyOf = () => {
    const { quickKey, triggerKey } = getConfig();
    return quickKey === SHARED ? triggerKey : quickKey || "";
  };
  const quickTapsOf = () => {
    const { quickKey, quickTaps, triggerTaps } = getConfig();
    return quickKey === SHARED ? triggerTaps : quickTaps;
  };
  const sharing = () => Boolean(quickKeyOf()) && quickKeyOf() === getConfig().triggerKey;

  const trigger = counter({
    keyOf: () => getConfig().triggerKey,
    tapsOf: () => getConfig().triggerTaps,
    onArm: showAim,
    onCommit: () => fire(hovered),
    onDrop: () => onAim?.(null),
  });

  const quick = counter({
    keyOf: quickKeyOf,
    tapsOf: quickTapsOf,
    onCommit: () => {
      if (!owns()) return;
      // On a key of its own there is no pointer in the question: pressing it could not have meant
      // anything else, so the selection is taken wherever it is.
      onQuick?.(sharing() ? pointer : undefined);
    },
  });

  const counters = [trigger, quick];

  // A press on a key both answer to belongs to one of them. Which one is asked when the key goes
  // down and kept until it comes up, so a pair is counted from start to finish by the same one: a
  // selection where the pointer is means quick translate, and everything else means the block. That
  // covers a field on its own, where the trigger never had anything to say.
  let held = null;
  const route = (key) => {
    if (!sharing() || key !== getConfig().triggerKey) return null;
    if (!held) held = quickReady?.(pointer) ? quick : trigger;
    return held;
  };

  // --- what a press does, wherever it came from ---------------------------

  const press = (key, repeat, at) => {
    if (key === "Escape") {
      escaped();
      return;
    }
    const owner = route(key);
    if (owner) {
      owner.keyDown(key, repeat, at);
      return;
    }
    for (const each of counters) each.keyDown(key, repeat, at);
  };

  const release = (key, at) => {
    if (held && key === getConfig().triggerKey) {
      const owner = held;
      held = null;
      owner.keyUp(key, at);
      return;
    }
    for (const each of counters) each.keyUp(key, at);
  };

  // Ctrl+click opens a link and Ctrl+wheel zooms; neither is a translate request.
  const abortAll = () => {
    for (const each of counters) each.abort();
  };
  const forget = () => {
    held = null;
    for (const each of counters) each.forget();
  };
  const pressing = () => counters.some((each) => each.pressing);
  const pending = () => counters.some((each) => each.pending);

  // Which presses the other frames need to hear about. Typing a message in a chat is the common case
  // and none of it is: the counters ignore a key that is neither theirs nor Escape, unless something
  // is held or half a pair is waiting, in which case any key at all cancels it.
  const interesting = (key) => {
    if (key === "Escape") return true;
    return Boolean(key) && (key === getConfig().triggerKey || key === quickKeyOf());
  };

  // Escape is a global undo, so it reaches every frame. The notice is not: three frames each
  // announcing their own count, one of them a chat pane a couple of hundred pixels tall, is three
  // notices for one press. The frames below report their number instead and the top frame says it
  // once.
  let restored = 0;
  let counting = null;

  const collect = (count) => {
    if (counting) restored += count;
  };

  const escaped = () => {
    const count = onEscape() || 0;
    if (window !== window.top) {
      if (count) relay({ kind: "restored", count });
      return;
    }
    restored += count;
    clearTimeout(counting);
    counting = setTimeout(() => {
      counting = null;
      const total = restored;
      restored = 0;
      onRestored?.(total);
    }, ESCAPE_SETTLE);
  };

  function apply({ kind, key, at, count }) {
    const when = Number(at) || Date.now();
    if (kind === "keydown") {
      if (typeof key === "string") press(key, false, when);
    } else if (kind === "keyup") {
      if (typeof key === "string") release(key, when);
    } else if (kind === "abort") {
      abortAll();
    } else if (kind === "forget") {
      forget();
    } else if (kind === "pointer") {
      dropPointer();
    } else if (kind === "restored") {
      collect(Number(count) || 0);
    }
  }

  // --- listeners ----------------------------------------------------------

  // A frame holds its last pointer position for as long as the pointer is in it, since aiming means
  // holding still and there is no telling how long for. It has to be told when that stops being
  // true, or an ancestor goes on answering for a pointer that moved down into a child: the last
  // position it saw is just inside its own content, where elementFromPoint happily finds a block,
  // and it would translate that instead of the message being pointed at.
  //
  // Saying so is the frame that has the pointer: it announces itself the first time the pointer
  // arrives, and every other frame lets go. Told rather than worked out, because the events that
  // would let a frame work it out for itself are not dependable across a process boundary, and
  // because two frames each deciding for themselves is exactly the situation to avoid.
  let owning = false;

  const dropPointer = () => {
    owning = false;
    pointer = null;
    hovered = null;
    onAim?.(null);
  };

  document.addEventListener(
    "mousemove",
    (event) => {
      // composedPath sees through an open shadow root; event.target alone is retargeted to the host,
      // whose own text is empty, so a shadow-rendered message would never resolve to anything.
      hovered = event.composedPath?.()[0] || event.target;
      pointer = { x: event.clientX, y: event.clientY };
      if (!owning) {
        owning = true;
        relay({ kind: "pointer" });
      }
      if (!trigger.live || queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        if (trigger.live) showAim();
      });
    },
    { passive: true, capture: true },
  );

  // The pointer left this frame for somewhere that will not announce itself: browser chrome, or a
  // frame with no content script in it. Local, and immediate, where the announcement is a message.
  document.addEventListener(
    "mouseout",
    (event) => {
      if (event.isTrusted && !event.relatedTarget) dropPointer();
    },
    { passive: true, capture: true },
  );

  // Passed on before it is acted on, both here and on the way in, so a frame whose handler throws
  // does not cut the flood, and so the messages one press produces stay in the order it produced
  // them.
  document.addEventListener(
    "keydown",
    (event) => {
      const at = Date.now();
      // Auto-repeat is discarded by every counter anyway, and holding the key to aim would otherwise
      // put thirty messages a second through every frame on the page.
      if (!event.repeat && (interesting(event.key) || pressing() || pending())) {
        relay({ kind: "keydown", key: event.key, at });
      }
      press(event.key, event.repeat, at);
    },
    { capture: true },
  );

  document.addEventListener(
    "keyup",
    (event) => {
      const at = Date.now();
      // A keyup on anything else is a no-op in every counter, so it is not worth a message.
      if (interesting(event.key)) relay({ kind: "keyup", key: event.key, at });
      release(event.key, at);
    },
    { capture: true },
  );

  // Only while something is actually held: wheel is passive and fires continuously, and relaying
  // every scroll would flood the tree to cancel a press nobody made.
  const abortHere = () => {
    if (pressing()) relay({ kind: "abort" });
    abortAll();
  };
  document.addEventListener("mousedown", abortHere, { capture: true });
  document.addEventListener("wheel", abortHere, { passive: true, capture: true });

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.ht !== RELAY || typeof data.id !== "string") return;
    // The top frame's parent is itself, so without this it would answer its own post.
    if (event.source === window) return;
    if (!KINDS.has(data.kind)) return;
    const now = Date.now();
    if (now - burstAt > BURST_MS) {
      burstAt = now;
      burst = 0;
    }
    if (++burst > BURST) return;
    if (!fresh(data.id)) return;
    spread(data, event.source);
    apply(data);
  });

  // Focus moving inside the page is not the user leaving: clicking from the page into the chat blurs
  // the top window too, and every frame holds the pair state now, so treating that as leaving would
  // drop a half-finished double-tap in the frame the pointer is over. The document still has focus
  // when it only moved into a frame below.
  if (window === window.top) {
    window.addEventListener("blur", () => {
      if (document.hasFocus()) return;
      relay({ kind: "forget" });
      forget();
    });
  }
  // Fires in every frame when the tab is hidden, which is exactly what is meant by leaving.
  document.addEventListener("visibilitychange", forget);
}
