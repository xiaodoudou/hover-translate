# Hover Translate

**A Chrome extension that translates whatever is under your pointer, text or image.** Point at it,
tap <kbd>Ctrl</kbd>, and it is translated in place. Tap it again to get the original back,
<kbd>Esc</kbd> restores the whole page.

![Hover Translate replacing a paragraph in place, then reading an image](docs/demo.gif)

*Replace, bilingual, bubble, then an image read and translated.*

No account, no API key, no paid service. Three free providers, tried in the order you choose:

| Provider | Notes |
| --- | --- |
| **Tencent TranSmart** | A mainland China provider, and the strongest of the three on Chinese |
| **Google** | Batches natively, fastest, widest language coverage |
| **MyMemory** | Last resort: needs to be told the source language and caps each request at 500 characters |

If one fails the next is tried, so a single outage is not a dead extension. The settings page shows
which provider served the last block and how long it took, text and images counted separately.

## Images

Words in an image are pixels, so they have to be read before they can be translated. Pointing at an
image and tapping <kbd>Ctrl</kbd> reads it and lays the translation over it. The page's own DOM is
never touched: the result goes in a closed shadow root anchored above the image, so the `<img>` keeps
its original `src` and nothing is inserted beside it.

![A Chinese product banner being read and translated in place](docs/demo-image.gif)

This is **off until you turn it on**, because reading an image the page did not serve itself is a
cross-origin fetch that needs a host permission. Setting **Translate images** to *Yes* on the
settings page asks for that permission there and then; declining leaves the feature off rather than
switching it on into something that cannot work. Setting it back to *No* hands the permission back.

| Recogniser | Notes |
| --- | --- |
| **Youdao** | Reads Chinese best by a distance, and translates as it reads. Returns a finished picture rather than boxes, so it replaces the image instead of annotating it |
| **Google Lens** | Any script. Returns each line with a box, which the usual providers above then translate |
| **Yandex** | Any script, and the only one that reports the text and background colours it found |

Youdao's endpoint **ignores the target language**: Chinese always comes back English, and everything
else always comes back Chinese. So it declines outright unless the target is English or Chinese, and
the language it actually answered in is checked before the result is used. When it does not match,
the failover moves on to Lens.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. **Load unpacked**, and pick this folder.
3. Open its settings from **Details** on that page, then **Extension options**, and choose your
   target language, display mode and provider order. There is no toolbar button: the extension is
   worked entirely from the keyboard, so it takes no room in the toolbar.

## Use

| Action | Result |
| --- | --- |
| Hover text, tap <kbd>Ctrl</kbd> | Translates the block under the pointer |
| Hover an image, tap <kbd>Ctrl</kbd> | Reads the image and lays the translation over it |
| Hold <kbd>Ctrl</kbd> | Translates nothing, and outlines the block that would be, if you asked for that |
| Select text, tap <kbd>Ctrl</kbd> on it | Replaces just the selection, in the page, in a field or in a chat box |
| Tap <kbd>Ctrl</kbd> on a translated block or image | Restores it |
| <kbd>Esc</kbd> | Restores every block and image on the page |

Nothing happens until you let go, so holding the key is how you aim and releasing it is how you
commit; a press you think better of costs nothing. Shortcuts are unaffected: pressing
any second key, clicking or scrolling while the trigger key is down cancels the press, so
<kbd>Ctrl</kbd>+C, <kbd>Ctrl</kbd>+click and <kbd>Ctrl</kbd>+scroll all behave normally.

"Outline what would be translated" on the settings page shows you what you are aiming at while the
key is down. It is off by default, since the key is held for a moment before every translation and
most of the time you already know what you are pointing at; turn it on while you are learning what a
tap takes. It is the same block the trigger itself resolves, not a guess at it, so no outline means
nothing would happen there. It is an outline rather than a border because an outline is painted
outside the box and takes no space at all: the element keeps its size, nothing reflows, and no word
moves under the pointer while you are aiming at it. On a double-tap trigger only the second press
outlines anything, since the first one does nothing.

## Quick translate

The trigger takes whole blocks, which is right for a paragraph and useless for half of one. Quick
translate takes the selection instead: select any text, tap <kbd>Ctrl</kbd> on it, and those words are
replaced where they sit. In the page that is a view like any other translation, and tapping the key
on it again puts the original back.

It is the trigger's own key by default, and what is under the pointer tells the two meanings apart. A
press on a key both use goes to whichever of them has something to act on: a selection where you are
pointing, or one in the field you are over, takes it, and everything else takes the block under the
pointer exactly as before. A selection left behind somewhere else on the page is not what a press
means, because what you are pointing at is.

The press is handed over before either side counts it, so the two can also differ in taps on the one
modifier: <kbd>Ctrl</kbd> once for the block and <kbd>Ctrl</kbd> twice for the selection is a legal
pair, and neither ever sees the other's press. Quick translate can equally be given a key of its own,
which then means the selection wherever it is, pointer or no pointer.

Text selected inside an input or a textarea is replaced there too, which is how you send a message
out in a language you do not write: type it in your own, select it, tap. A field holds no nodes to
work with and nothing the page's selection API reports, so that text is taken as a range of
characters in the field's value instead.

A field also differs from the page in the way that matters most here: what is in it is your text, not
the page's, so translating it is an edit and not a view of something. The field keeps the
translation, the trigger key has nothing to undo there, and <kbd>Esc</kbd> leaves it alone; taking
back the message you translated in order to send it would be the one unforgivable thing this could
do. The field's own undo is the way back, which is why the write goes through the browser's editing
command rather than assigning to the value: that is also what tells a framework holding the value
what changed. Passwords are refused outright, since they would be sent to a translation endpoint like
any other string, and so are readonly and disabled fields, which nothing could be written back to.

A chat box is usually not a field at all. Taobao's is a `<pre>` the page marked contenteditable, and
there the selection API does report a real range, so it used to be wrapped in a span like any passage
of the page. An editor serialises that wrapper straight into whatever gets sent. So those go through
the editing command as well, and count as your text for the same reason a field does: nothing of this
extension's is left in the box to travel with the message. Pointing anywhere in the box counts too,
the way it does for a field, rather than only at the words you selected.

<kbd>Alt</kbd> is not offered for either. The browser answers a bare <kbd>Alt</kbd> by moving focus to
its own toolbar, which takes the keys with it and blurs the page, so a tap of it is one the page
hears the beginning of and never the end.

Where a selection goes is read off the writing system it is in rather than from a language detector,
which costs nothing and cannot be wrong about what it does answer:

| Row | Covers |
| --- | --- |
| Latin | English, French, Spanish, German and everything else written in it |
| Han, Japanese, Korean, Cyrillic, Arabic | one row each |
| Everything else | any script with no row of its own |

The list is read top to bottom, and it can be reordered. **Same as above** means the row above it, so
scripts that share a destination stack under the one that names it. Latin on top going to Chinese,
then Han set to English with everything below it saying Same as above, is the whole of "what I write
goes out in Chinese, and everything I read comes back in English". The top row has nothing above it,
so it always names a language, and moving a row up to the top settles it on whatever it was
inheriting rather than leaving it pointing at nothing.

A script tells Chinese from Russian from English for free. It stops where an alphabet is shared:
French and English are one row, and so are Mandarin and Cantonese, because nothing in the characters
says which of the two it is. Separating those needs a detector, and a selection is often a handful of
words, which is exactly where detectors are least reliable.

In the page, the selection is replaced as plain text, so a link or a bold word inside it does not
survive; a press that takes the block is the one that keeps markup. Rich editors are left alone,
since the wrapper this needs would be serialised into whatever you are writing.

## Display modes

Each one is shown in the demo above, in order, before the image at the end.

| Mode | What it does |
| --- | --- |
| **Replace** | Rewrites the text where it stands. The default, and the only one that touches no nodes at all |
| **Both** | Keeps the original and adds the translation after it, as a single text node |
| **Bubble** | Leaves the page completely alone and shows the translation in an overlay, dismissed by moving the mouse |

Bilingual mode appends the translated text and nothing else, in a single `<span>`, so the original
is left exactly as it was.

## Lines the page cut short

A page sizes its text boxes for the language it shipped with, and the same sentence is usually longer
in another one, so part of the translation ends up where the page never meant to paint. It happens
two ways. Sideways: one `nowrap` line with its tail behind an ellipsis, which is what a sidebar menu
does. Downwards: the text wraps as it should and the box was simply given the height its own language
needed, so the second line exists, is laid out, and is painted nowhere, which is what a product card
does to a title. Neither cut is necessarily on the element holding the words, since a card sizes the
row rather than the title inside it, so the boxes above the text are checked too.

There are only two honest answers, and **Scroll clipped lines** on the settings page picks between them.

| Setting | What happens to text that no longer fits |
| --- | --- |
| **Enable** | The default. It scrolls, unless the page left room around the box, which it takes instead |
| **Disable** | The box always grows |

There was a third setting that always scrolled and never took the room. It is gone, because next to
nothing told the two apart: a menu row is built around its single line and has none to give, so it
scrolls either way. They only parted company where a page left slack, and taking slack costs the
page nothing. Anything still stored under the old name reads as the default.

A lap carries the line from off the right edge of the box to off the left one, at one steady 50px/s,
for as long as you are pointing at the row. Because both ends of a lap are off screen the wrap has
no seam, and because it never stops there is nothing for a reader to wait out. It holds still for a
second first, so the beginning can be read where you were already looking, and it keeps the page's
own ellipsis until it actually sets off.

Text cut downwards moves the same way, once the shape of the window says how. A window one line tall
is a line, whichever way the page cut it, so the wrap comes out and it reads across exactly like the
one above: the box was showing a single line before and it shows a single line now, so nothing about
its height changes. A window several lines tall is a paragraph cut short instead, and undoing the
wrap there would leave one line rattling around in a box built for three, so it rises through the
window and comes back from below. That one is timed a line at a time, roughly one every two seconds,
because reading down a paragraph is waiting for the next line rather than following words across.

Sliding is a `transform` on a wrapper span, the one node this extension adds to a page, and only
inside a box whose text it has already replaced. That is what makes it smooth: `text-indent` is a
layout property, so animating it relaid the line out on the main thread every frame, and anything
else busy there left the text standing still and then arriving late in one jump. A transform on its
own layer belongs to the compositor and page script cannot stall it. The wrapper is stripped when
the block is reverted, along with the animation.

It runs while the pointer is anywhere in the block rather than only on the box itself; a menu row is
130px wide and 24px tall, so anything smaller stops every time a hand drifts, and leaving is given
300ms of grace before the line is handed back. That is also why the movement is driven from the
content script rather than by a `:hover` rule: a CSS animation starts over every time its selector
matches again. Under `prefers-reduced-motion` nothing moves.

Growing wraps the line inside the width the page gave it, so the column stays where it is and only
the height changes.

**Only if no space** means room the page already had, not room it can be made to give. A sidebar row
is as tall as the one line in it, so a second line pushes every row below it down and the column
reflows under the reader; that is not free, so those lines slide. A box with slack, a row taller
than its text, grows into it. What that costs is measured rather than guessed: the box has to end up
showing the whole line, the block it sits in has to end exactly where it ended before, and nothing
above it may clip the new lines away. When any of that fails the line slides instead.

While a request is in flight a blue gradient sweeps along the bottom edge of the block. It is painted
as a background, not a border, an outline or an appended element, so it adds no height, shifts nothing
and inserts no node. Once the text is replaced nothing is left behind.

An image cannot use that trick, since a painted background sits behind the image's own pixels and
would never be seen. It gets the same sweep drawn on top instead, full width across the middle of the
image, on a track with a pale hairline so it stays legible over a light picture and a dark one alike.

## Deciding what is already in the target language

- **Every result is judged, not just the first.** When a block's Chinese sits inside styled spans, the
  string carrying the sentence can be almost entirely brand names, and a provider reads that one as
  English. Judging the block on it alone made whole paragraphs vanish into "already in English". The
  majority of the detected languages now decides.
- **The writing system overrules the detector.** Han characters mean the text is not English whatever
  a detector claims, so a block is never skipped when it contains script the target language does not
  use. Latin is ignored as evidence, since brand names, model numbers and dates appear in every
  language. See [src/lib/script.js](src/lib/script.js).

## Tests

The one that matters most installs the extension in a real headless Chrome and drives it with real
mouse and keyboard events. It serves the folder, launches its own throwaway profile and cleans up:

```bash
node test/extension.test.mjs
```

Every provider against its live endpoint:

```bash
node test/remote.test.mjs
```

Package sanity, no browser needed:

```bash
node test/package.test.mjs
```

Two browser tests need the folder served over http, because ES module imports do not work from
`file://`:

```bash
python -m http.server 8731
```

- `http://localhost:8731/test/harness.html` runs `block.js`, `richtext.js`, `marquee.js` and
  `script.js` against the fixture DOM.
- `http://localhost:8731/test/e2e.html` runs the whole content script over the fixture, translating
  through live endpoints, with only the `chrome.*` APIs stubbed.
- `test/fixture.html` is the manual page: open it with the extension loaded and hover through it.

## Limits

- These are undocumented endpoints. They can rate-limit or change without notice, which is exactly why
  there are three of them and why failures surface on the settings page rather than passing silently.
- The Lens recogniser is the least documented of the lot: its request shape was derived from the
  server's own error messages rather than a spec, so it is the first thing that will break if Google
  renumbers those fields. The failover means that degrades to Yandex rather than to nothing.
- A block over 5000 characters is refused, so a stray hover cannot rewrite half a page.
- Pages that build their chat out of nested frames are handled, whatever the nesting and whatever the
  origins: the press is passed from frame to frame until the whole tree has seen it, and the frame the
  pointer is actually over is the one that acts. What still cannot work is a frame that runs no
  content script of its own, either because it is sandboxed without `allow-scripts` or because its
  scheme is outside the ones the extension matches. Nothing inside such a frame can be translated,
  and nothing below it can be reached either.
- An image over 12 MB is refused.
- Reloading or updating the extension leaves the copy already injected into open tabs with nothing
  behind it, and only a page load gets a fresh one. Rather than repeating Chrome's "Extension context
  invalidated" on every trigger, it says so once and asks you to reload the page. Undo still works,
  since restoring a block touches nothing but the DOM.
