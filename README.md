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

If one fails the next is tried, so a single outage is not a dead extension. The popup shows which
provider served the last block and how long it took, text and images counted separately.

## Images

Words in an image are pixels, so they have to be read before they can be translated. Pointing at an
image and tapping <kbd>Ctrl</kbd> reads it and lays the translation over it. The page's own DOM is
never touched: the result goes in a closed shadow root anchored above the image, so the `<img>` keeps
its original `src` and nothing is inserted beside it.

![A Chinese product banner being read and translated in place](docs/demo-image.gif)

This is **off until you turn it on**, because reading an image the page did not serve itself is a
cross-origin fetch that needs a host permission. Setting **Translate images** to *Yes* in the popup
asks for that permission there and then; declining leaves the feature off rather than switching it on
into something that cannot work. Setting it back to *No* hands the permission back.

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
3. Open the popup to choose your target language, display mode and provider order.

## Use

| Action | Result |
| --- | --- |
| Hover text, tap <kbd>Ctrl</kbd> | Translates the block under the pointer |
| Hover an image, tap <kbd>Ctrl</kbd> | Reads the image and lays the translation over it |
| Keep <kbd>Ctrl</kbd> held and move | Translates each block you sweep over |
| Tap <kbd>Ctrl</kbd> on a translated block or image | Restores it |
| <kbd>Esc</kbd> | Restores every block and image on the page |

A tap fires when you release the key, so a quick press is enough. Shortcuts are unaffected: pressing
any second key, clicking or scrolling while the trigger key is down cancels the press, so
<kbd>Ctrl</kbd>+C, <kbd>Ctrl</kbd>+click and <kbd>Ctrl</kbd>+scroll all behave normally.

## Display modes

Each one is shown in the demo above, in order, before the image at the end.

| Mode | What it does |
| --- | --- |
| **Replace** | Rewrites the text where it stands. The default, and the only one that touches no nodes at all |
| **Both** | Keeps the original and adds the translation after it, as a single text node |
| **Bubble** | Leaves the page completely alone and shows the translation in an overlay, dismissed by moving the mouse |

Bilingual mode appends the translated text and nothing else, in a single `<span>`, so the original
is left exactly as it was.

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

- `http://localhost:8731/test/harness.html` runs `block.js`, `richtext.js` and `script.js` against the
  fixture DOM.
- `http://localhost:8731/test/e2e.html` runs the whole content script over the fixture, translating
  through live endpoints, with only the `chrome.*` APIs stubbed.
- `test/fixture.html` is the manual page: open it with the extension loaded and hover through it.

## Limits

- These are undocumented endpoints. They can rate-limit or change without notice, which is exactly why
  there are three of them and why failures surface in the popup rather than passing silently.
- The Lens recogniser is the least documented of the lot: its request shape was derived from the
  server's own error messages rather than a spec, so it is the first thing that will break if Google
  renumbers those fields. The failover means that degrades to Yandex rather than to nothing.
- A block over 5000 characters is refused, so a stray hover cannot rewrite half a page.
- An image over 12 MB is refused.
- Reloading or updating the extension leaves the copy already injected into open tabs with nothing
  behind it, and only a page load gets a fresh one. Rather than repeating Chrome's "Extension context
  invalidated" on every trigger, it says so once and asks you to reload the page. Undo still works,
  since restoring a block touches nothing but the DOM.
