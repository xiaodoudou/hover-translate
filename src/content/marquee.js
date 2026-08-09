import {
  CLASS_MARQUEE,
  CLASS_MARQUEE_LINE,
  CLASS_MARQUEE_MOVING,
  CLASS_UNCLIPPED,
} from "../lib/rules.js";

// A page cuts its one-line boxes to fit the language it shipped with: the width, the nowrap and the
// ellipsis are all measured against that string. The same sentence in another language is usually
// wider, so the tail lands outside the box and the ellipsis hides it. There are only two honest ways
// to show it: keep the box and move the line inside it, or keep the line and let the box grow. The
// setting picks, and "fit" asks the page which one it has room for.

// text-indent moves the first line of a block container. Inside a flex or grid box it would indent
// each item's own text instead of sliding the row, so those keep their ellipsis.
const SLIDABLE = new Set(["block", "inline-block", "flow-root", "list-item", "table-cell"]);
// Only where the page has taken the text away. A scrollable box can already be read by dragging it.
const CLIPPED = new Set(["hidden", "clip"]);
// Wrapping text only overflows sideways on an unbreakable word, and moving the first line alone
// would leave it out of step with the rest.
const ONE_LINE = new Set(["nowrap", "pre"]);

// Below this the ellipsis is covering a character or two and the movement costs more attention than
// it saves.
const MIN_HIDDEN = 12;
// Reading pace, and the same pace the whole way. Easing a marquee spends the start of it moving a
// fraction of a pixel per frame, which does not read as slow, it reads as the text shivering.
const PX_PER_SECOND = 50;
const MIN_SECONDS = 1;
const MAX_SECONDS = 30;
// A row is 24px tall, so a pointer resting near its edge crosses in and out of it. Without this the
// line would start over on every one of those crossings.
const LEAVE_GRACE = 300;
// Long enough to take in the beginning before it goes anywhere, short enough not to be a wait. A
// line that sets off the instant the pointer lands makes the reader chase the words they were
// already looking at.
const START_DELAY = 1000;

const MARKED = `.${CLASS_MARQUEE}, .${CLASS_UNCLIPPED}`;
// The animation and the two listeners that drive it, per moving box.
const sliding = new WeakMap();

// fit | grow, as described in settings.js.
let mode = "fit";

export function setClippedLines(next) {
  mode = next === "grow" ? "grow" : "fit";
}

function stopSliding(el) {
  const state = sliding.get(el);
  if (!state) return;
  state.timer();
  state.animation.cancel();
  state.host.removeEventListener("pointerenter", state.start);
  state.host.removeEventListener("pointerleave", state.stop);
  sliding.delete(el);
}

// The wrapper exists only to be moved. Putting the nodes back and merging the text leaves the box
// exactly as it was found, which is what the revert path expects to be handed.
function unwrap(el) {
  for (const line of el.querySelectorAll(`:scope > .${CLASS_MARQUEE_LINE}`)) {
    line.replaceWith(...line.childNodes);
  }
  el.normalize();
}

function strip(el) {
  stopSliding(el);
  unwrap(el);
  el.classList.remove(CLASS_MARQUEE, CLASS_MARQUEE_MOVING, CLASS_UNCLIPPED);
}

// Handles every box in the block whose translated line no longer fits.
export function markOverflow(block) {
  // Widths are read for every box first: the first read pays for the layout the new text
  // invalidated and the rest are answered from it, so getComputedStyle is only asked about the few
  // boxes that actually overflow.
  const boxes = [block, ...block.querySelectorAll("*")];
  const overflowing = boxes.filter((el) => el.scrollWidth - el.clientWidth >= MIN_HIDDEN);

  for (const el of overflowing) {
    // A clipped line inside another one: only the outer box is handled, and it carries the inner
    // one with it.
    if (el.parentElement?.closest(MARKED)) continue;

    let style;
    try {
      style = getComputedStyle(el);
    } catch {
      continue;
    }
    if (!CLIPPED.has(style.overflowX)) continue;
    if (!ONE_LINE.has(style.whiteSpace)) continue;
    if (!SLIDABLE.has(style.display)) continue;

    // Preformatted text is left to slide: wrapping it would collapse the spacing it was written for.
    if (style.whiteSpace === "nowrap" && grow(el, block)) continue;
    slide(el, style, block);
  }
}

// Lets the line wrap inside the width the page gave the box, so the column keeps its place and only
// the height changes. Growing sideways is what would push the rest of the page around.
function grow(el, block) {
  // Read before the class goes on: whether the block ends where it used to is the whole question.
  const bottom = block.getBoundingClientRect().bottom;
  el.classList.add(CLASS_UNCLIPPED);
  if (mode === "grow" || roomFor(el, block, bottom)) return true;
  el.classList.remove(CLASS_UNCLIPPED);
  return false;
}

// Whether the page had the room already, rather than making it. A sidebar row is as tall as its one
// line, so growing it is not free: every row below moves down and the column the reader is looking
// at reflows under them. Room means slack the page had spare, so nothing else moves at all.
// What this cannot see is an ancestor that neither clips nor grows, where the new lines are drawn
// over whatever sits below; keeping the page's size is the setting for anyone who would rather
// never risk that.
function roomFor(el, block, bottom) {
  // Something in the line cannot be broken, so part of it is still outside the box.
  if (el.scrollWidth - el.clientWidth >= 1) return false;
  if (el.scrollHeight - el.clientHeight >= 1) return false;
  // The block ends where it did: the extra lines cost the page nothing.
  if (block.getBoundingClientRect().bottom > bottom + 1) return false;

  const box = el.getBoundingClientRect();
  // And they are inside it, rather than hanging below its own bottom.
  if (box.bottom > block.getBoundingClientRect().bottom + 1) return false;

  for (let n = el.parentElement; n && n !== document.documentElement; n = n.parentElement) {
    let style;
    try {
      style = getComputedStyle(n);
    } catch {
      return false;
    }
    if (!CLIPPED.has(style.overflowX) && !CLIPPED.has(style.overflowY)) continue;
    const inside = n.getBoundingClientRect();
    if (box.bottom > inside.bottom + 1 || box.right > inside.right + 1) return false;
  }
  return true;
}

// A marquee, in the plain sense: the line travels across the box at one steady speed and keeps
// going. A lap runs from the line waiting off the right edge to the line gone past the left one, so
// the wrap happens with nothing on screen and the loop has no seam to see. Moving only by what the
// ellipsis hides was the wrong idea twice over: on a menu label that is forty pixels, which is over
// before the eye finds it, and whatever it does at the end of those forty pixels, stop or spring
// back, is the only thing the reader ends up noticing.
//
// It moves a wrapper by transform rather than moving the line by text-indent. text-indent is a
// layout property: every frame of it is a relayout on the main thread, so anything else busy there
// holds the line still and it arrives late in one jump. A transform on its own layer is handed to
// the compositor and page script cannot stall it.
//
// The line moves while the pointer is in the block it belongs to, not only while it is on the box
// itself: a menu row is 130px wide and 24px tall, and asking a reader to hold the pointer inside
// that is asking for the movement to stop every time their hand drifts. That is also why this is
// driven from here rather than by a :hover rule: a CSS animation starts over every time its selector
// matches again, so a pointer crossing the edge of the box would jump the line back to the start.
function slide(el, style, block) {
  const view = el.clientWidth;
  const line = el.scrollWidth;
  const lap = view + line;
  const seconds = Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, lap / PX_PER_SECOND));

  el.classList.add(CLASS_MARQUEE);
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const runner = document.createElement("span");
  runner.className = CLASS_MARQUEE_LINE;
  runner.append(...el.childNodes);
  el.append(runner);

  // Zero is where the page drew the line, so nothing here has to know about its own indent.
  const animation = runner.animate(
    [
      { offset: 0, transform: `translateX(${view}px)`, easing: "linear" },
      { offset: 1, transform: `translateX(${-line}px)` },
    ],
    { duration: seconds * 1000, iterations: Infinity },
  );
  animation.id = CLASS_MARQUEE;
  // Where in the lap the line sits exactly where the page drew it. Every start is from there, so the
  // first thing the reader sees is the line they pointed at moving off, not an empty box filling up.
  // It waits there too: parked at offset zero it would be holding the line off the right edge, and
  // the box would sit empty until someone pointed at it.
  const rest = (view / lap) * seconds * 1000;
  animation.currentTime = rest;
  animation.pause();

  let leaving = 0;
  let waiting = 0;
  const start = () => {
    clearTimeout(leaving);
    // A lap already under way is left alone: coming back from a wobble over the edge of the row has
    // to pick up where the line was, not sit through the wait again.
    if (animation.playState === "running") return;
    animation.currentTime = rest;
    clearTimeout(waiting);
    waiting = setTimeout(() => {
      // The ellipsis stays until it actually sets off: the line is still where the page drew it.
      el.classList.add(CLASS_MARQUEE_MOVING);
      animation.play();
    }, START_DELAY);
  };
  // Cancelling rather than pausing: a line left standing part way through its lap has its beginning
  // off screen and no reason a reader could see for it. Off the block, the page gets its line back.
  const stop = () => {
    clearTimeout(waiting);
    leaving = setTimeout(() => {
      animation.cancel();
      el.classList.remove(CLASS_MARQUEE_MOVING);
    }, LEAVE_GRACE);
  };
  block.addEventListener("pointerenter", start);
  block.addEventListener("pointerleave", stop);
  sliding.set(el, {
    animation,
    host: block,
    start,
    stop,
    timer: () => {
      clearTimeout(leaving);
      clearTimeout(waiting);
    },
  });

  // The pointer is on the block already: it is what asked for this translation.
  if (block.matches(":hover")) start();
}

// Must run before the block is put back: the rebuild path restores the original children, and the
// marked boxes are among the ones it replaces.
export function clearOverflow(block) {
  for (const el of [block, ...block.querySelectorAll(MARKED)]) {
    if (el.matches(MARKED)) strip(el);
  }
}
