import {
  CLASS_MARQUEE,
  CLASS_MARQUEE_COLUMN,
  CLASS_MARQUEE_FLAT,
  CLASS_MARQUEE_LINE,
  CLASS_MARQUEE_MOVING,
  CLASS_UNCLIPPED,
} from "../lib/rules.js";

// A page sizes its text boxes for the language it shipped with, and the same sentence is longer in
// most others, so part of a translation ends up where the page never meant to paint. It cuts two
// ways. Sideways: nowrap, hidden, and an ellipsis where the words ran out of width, which is what a
// sidebar menu does. Downwards: the text wraps as it should and the box is given the height its own
// language needed, so the second line exists, is laid out, and is painted nowhere, which is what a
// card does to a title. Neither cut is necessarily on the box holding the words, since a card sizes
// the row rather than the title inside it, and an inline title cannot be measured for a cut at all:
// clientWidth and clientHeight are both zero on an inline box.
//
// There are only two honest answers to either cut: keep the box and move the text inside it, or keep
// the text and let the box grow. The setting picks, and "fit" asks the page which one it has room
// for.

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
// How far above a block its cut can be. Deep enough for the fixed-height row a card wraps its title
// in, shallow enough never to reach the page's own scrolling container.
const MAX_CLIP_CLIMB = 4;
// How many lines tall a box can be and still be read as a capped line of text rather than a region.
const MAX_CLIPPED_LINES = 6;
// Reading pace, and the same pace the whole way. Easing a marquee spends the start of it moving a
// fraction of a pixel per frame, which does not read as slow, it reads as the text shivering.
const PX_PER_SECOND = 50;
// Downwards the reader is not tracking anything: they wait for the next line and read it where it
// lands. So that pace is one line at a time rather than so many pixels a second.
const SECONDS_PER_LINE = 1.8;
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
// What was touched on behalf of each block. A box above the block cannot be found again by looking
// inside it, so putting the page back has to be done from a record rather than from a selector.
const marked = new WeakMap();

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

// Handles every box whose translated text no longer fits, inside the block or above it.
export function markOverflow(block) {
  // Sizes are read for every box first: the first read pays for the layout the new text invalidated
  // and the rest are answered from it, so getComputedStyle is only asked about the few boxes that
  // actually overflow.
  const boxes = [block, ...block.querySelectorAll("*")];
  const touched = [];
  const record = (el, handled) => handled && touched.push(el);

  for (const el of boxes) {
    if (el.scrollWidth - el.clientWidth >= MIN_HIDDEN) record(el, handleWide(el, block));
    else if (el.scrollHeight - el.clientHeight >= MIN_HIDDEN) record(el, handleTall(el, block));
  }

  const outer = clipper(block);
  if (outer) record(outer, handleWide(outer, block) || handleTall(outer, block));

  marked.set(block, touched);
}

// The nearest box above the block that cuts its text off. Only the nearest: if that one holds the
// block whole then nothing further out can be cutting this text, whatever else it clips.
function clipper(block) {
  const box = block.getBoundingClientRect();
  let el = block.parentElement;
  for (let climbed = 0; el && climbed < MAX_CLIP_CLIMB; climbed++, el = el.parentElement) {
    if (el === document.body || el === document.documentElement) return null;
    let style;
    try {
      style = getComputedStyle(el);
    } catch {
      return null;
    }
    if (!CLIPPED.has(style.overflowX) && !CLIPPED.has(style.overflowY)) continue;
    const inside = el.getBoundingClientRect();
    return box.bottom > inside.bottom + 1 || box.right > inside.right + 1 ? el : null;
  }
  return null;
}

// Cut sideways: one long line with its tail behind the ellipsis.
function handleWide(el, block) {
  // A clipped line inside another one: only the outer box is handled, and it carries the inner one
  // with it.
  if (el.matches(MARKED) || el.parentElement?.closest(MARKED)) return false;
  if (el.scrollWidth - el.clientWidth < MIN_HIDDEN) return false;

  let style;
  try {
    style = getComputedStyle(el);
  } catch {
    return false;
  }
  if (!CLIPPED.has(style.overflowX)) return false;
  if (!ONE_LINE.has(style.whiteSpace)) return false;
  if (!SLIDABLE.has(style.display)) return false;

  // Preformatted text is left to slide: wrapping it would collapse the spacing it was written for.
  if (style.whiteSpace === "nowrap" && grow(el, block)) return true;
  slide(el, block, "x");
  return true;
}

// Cut downwards: the text wraps as it should and the box stops after the number of lines the page's
// own language needed. Nothing is missing from the layout, only from the paint.
function handleTall(el, block) {
  if (el.matches(MARKED) || el.parentElement?.closest(MARKED)) return false;
  if (el.scrollHeight - el.clientHeight < MIN_HIDDEN) return false;

  let style;
  try {
    style = getComputedStyle(el);
  } catch {
    return false;
  }
  if (!CLIPPED.has(style.overflowY)) return false;
  // Measured on whichever of the two holds the text, since a row and the title inside it can be set
  // in different sizes, and the question here is always how many lines of the text the box shows.
  const line = lineHeight(el.contains(block) ? block : el);
  // A box a few pixels shorter than its content is rounding, or a descender under the edge. A line
  // of a sentence is what this is for.
  if (el.scrollHeight - el.clientHeight < line * 0.6) return false;
  // And a box measured in lines is a title the page capped. A tall one is a region of the page that
  // happens to hide its overflow, and moving a whole region past a window, or growing one, would be
  // a far stranger thing to do than leaving it as the page has it.
  if (el.clientHeight > line * MAX_CLIPPED_LINES) return false;

  if (growTall(el)) return true;
  // A window one line tall is a line the page cut, whichever way it did the cutting, so it reads
  // across like every other one: the wrap is undone and the sentence moves sideways through the box
  // it always had. A taller window is a paragraph cut short, where the reading order is down the
  // lines and undoing the wrap would leave the rest of the box empty. A box that hides what runs
  // past its bottom but not what runs past its side is left to rise as well, since one long line
  // there is a line it would have to grow a scrollbar for.
  const across = CLIPPED.has(style.overflowX) && el.clientHeight <= line * 1.5;
  slide(el, block, across ? "flat" : "y");
  return true;
}

function lineHeight(el, style = getComputedStyle(el)) {
  // "normal" is the usual answer and parses to nothing, so the font size stands in for it.
  return parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2 || 16;
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

// The same answer to the other cut: the limit on lines comes off and the box takes the height its
// own text needs. Room here is the box's parent absorbing that without growing itself, which is
// what a padded card does and what a row in a list of rows never does.
function growTall(el) {
  const parent = el.parentElement;
  const before = parent?.getBoundingClientRect().bottom ?? 0;
  el.classList.add(CLASS_UNCLIPPED);
  if (mode === "grow") return true;
  const shown = el.scrollHeight - el.clientHeight < 1;
  if (shown && parent && parent.getBoundingClientRect().bottom <= before + 1) return true;
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
//
// Text the page cut downwards moves the same way, once the shape of the window says how. One line
// tall and it is a line like any other: the wrap comes out and it reads across. Taller than that and
// it is a paragraph, so it rises through the window instead, goes off the top and comes back from
// below, paced by the line rather than in pixels, because the reader is waiting for lines to arrive
// rather than following words across.
function slide(el, block, axis) {
  const down = axis === "y";
  // The page wrapped this text and hid the rest; putting it back on one line is what makes it a
  // line to move, and the box was showing exactly one line already.
  const flat = axis === "flat";

  // Read before anything moves: wrapping the children changes what the box reports about them.
  const view = down ? el.clientHeight : el.clientWidth;
  const laid = down ? el.scrollHeight : el.scrollWidth;

  el.classList.add(CLASS_MARQUEE);
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const runner = document.createElement("span");
  const extra = down ? ` ${CLASS_MARQUEE_COLUMN}` : flat ? ` ${CLASS_MARQUEE_FLAT}` : "";
  runner.className = CLASS_MARQUEE_LINE + extra;
  runner.append(...el.childNodes);
  el.append(runner);

  // The flattened one has to be measured after the fact: until the wrap came out there was no
  // single line to measure, only as many as the page had chosen to break it into.
  const line = flat ? runner.scrollWidth : laid;
  const lap = view + line;
  const pace = down ? (lap / lineHeight(el)) * SECONDS_PER_LINE : lap / PX_PER_SECOND;
  const seconds = Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, pace));
  const at = (px) => (down ? `translateY(${px}px)` : `translateX(${px}px)`);

  // Zero is where the page drew the line, so nothing here has to know about its own indent.
  const animation = runner.animate(
    [
      { offset: 0, transform: at(view), easing: "linear" },
      { offset: 1, transform: at(-line) },
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
  // Whichever of the two holds the other, so the pointer is never asked to stay somewhere smaller
  // than the thing the reader is looking at.
  const host = el.contains(block) ? el : block;
  host.addEventListener("pointerenter", start);
  host.addEventListener("pointerleave", stop);
  sliding.set(el, {
    animation,
    host,
    start,
    stop,
    timer: () => {
      clearTimeout(leaving);
      clearTimeout(waiting);
    },
  });

  // The pointer is on it already: it is what asked for this translation.
  if (host.matches(":hover")) start();
}

// Must run before the block is put back: the rebuild path restores the original children, and the
// marked boxes are among the ones it replaces.
export function clearOverflow(block) {
  const boxes = new Set(marked.get(block));
  marked.delete(block);
  for (const el of [block, ...block.querySelectorAll(MARKED)]) {
    if (el.matches(MARKED)) boxes.add(el);
  }
  for (const el of boxes) strip(el);
}
