# Hover Translate

**A Chrome extension that translates the text under your pointer.** Point at any text, tap
<kbd>Ctrl</kbd>, and it is translated in place. Tap it again to get the original back,
<kbd>Esc</kbd> restores the whole page.

![Hover Translate translating a paragraph in place](docs/demo.gif)

No account, no API key, no paid service. Three free providers, tried in the order you choose:

| Provider | Notes |
| --- | --- |
| **Tencent TranSmart** | A mainland China provider, and the strongest of the three on Chinese |
| **Google** | Batches natively, fastest, widest language coverage |
| **MyMemory** | Last resort: needs to be told the source language and caps each request at 500 characters |

If one fails the next is tried, so a single outage is not a dead extension. The popup shows which
provider served the last block and how long it took.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. **Load unpacked**, and pick this folder.
3. Open the popup to choose your target language, display mode and provider order.

## Use

| Action | Result |
| --- | --- |
| Hover text, tap <kbd>Ctrl</kbd> | Translates the block under the pointer |
| Keep <kbd>Ctrl</kbd> held and move | Translates each block you sweep over |
| Tap <kbd>Ctrl</kbd> on a translated block | Restores it |
| <kbd>Esc</kbd> | Restores every block on the page |

A tap fires when you release the key, so a quick press is enough. Shortcuts are unaffected: pressing
any second key, clicking or scrolling while the trigger key is down cancels the press, so
<kbd>Ctrl</kbd>+C, <kbd>Ctrl</kbd>+click and <kbd>Ctrl</kbd>+scroll all behave normally.

## Display modes

Each one is shown in the demo above, in order.

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
- A block over 5000 characters is refused, so a stray hover cannot rewrite half a page.
