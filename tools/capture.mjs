// Records the extension in use: the pointer, the loading sweep, and each display mode.
//   node tools/capture.mjs
//
// Everything lands in docs/: the 1280x800 stills the store wants under docs/screenshots/, plus an
// animated GIF and an mp4 for the README and a listing video. Needs ffmpeg on PATH.
//
// A synthetic cursor is drawn into the page because a CDP screenshot never contains the real one.
// It carries data-ht-ui, the attribute the extension uses to ignore its own UI, so the demo pointer
// can never be mistaken for translatable text.

import { createServer } from "node:http";
import { readFile, writeFile, mkdir, rm, mkdtemp, readdir } from "node:fs/promises";
import { spawn, execFile } from "node:child_process";
import { dirname, resolve, join, extname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const docs = join(root, "docs");
const stills = join(docs, "screenshots");

const PORT = 8771;
const CDP = 9533;
const W = 1280;
const H = 800;
const LOADING_MS = 1500; // held long enough that the sweep lands in several frames
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" };
const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(req.url.split("?")[0]);
    const body = await readFile(join(root, path));
    res.writeHead(200, { "content-type": MIME[extname(path)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const frameDir = await mkdtemp(join(tmpdir(), "ht-frames-"));
const profile = await mkdtemp(join(tmpdir(), "ht-cap-"));
const chrome = spawn(
  process.env.CHROME_PATH || `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
  [
    "--headless=new", `--user-data-dir=${profile}`, "--enable-unsafe-extension-debugging",
    `--remote-debugging-port=${CDP}`, "--no-first-run", "--no-default-browser-check",
    "--disable-sync", "--hide-scrollbars", `--window-size=${W},${H}`, "about:blank",
  ],
  { stdio: "ignore" },
);
for (let i = 0; i < 40; i++) {
  await sleep(500);
  try { await (await fetch(`http://127.0.0.1:${CDP}/json/version`)).json(); break; } catch {}
}

function attach(url) {
  let id = 1;
  const pending = new Map();
  const contexts = [];
  const ws = new WebSocket(url);
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === "Runtime.executionContextCreated") contexts.push(m.params.context);
  });
  const ready = new Promise((r) => ws.addEventListener("open", r));
  const send = (method, params = {}) =>
    new Promise((res) => { const i = id++; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  return { send, ready, contexts };
}

const version = await (await fetch(`http://127.0.0.1:${CDP}/json/version`)).json();
const browser = attach(version.webSocketDebuggerUrl);
await browser.ready;
const { result } = await browser.send("Extensions.loadUnpacked", { path: root });
const EXT = result.id;

const tab = await (await fetch(
  `http://127.0.0.1:${CDP}/json/new?http://127.0.0.1:${PORT}/docs/demo.html`, { method: "PUT" },
)).json();
await sleep(1200);
const page = attach(tab.webSocketDebuggerUrl);
await page.ready;
await page.send("Runtime.enable");
await page.send("Page.enable");
await page.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });

// Installing opens the settings in a tab of its own, which leaves the demo page in the background,
// where a headless screenshot never arrives at all. Closed here, and the last scene opens its own.
for (const target of await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()) {
  if (target.url?.startsWith(`chrome-extension://${EXT}/src/options/`)) {
    await fetch(`http://127.0.0.1:${CDP}/json/close/${target.id}`);
  }
}
await page.send("Page.bringToFront");

const main = async (expression) => {
  const m = await page.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.exception?.description || "eval failed");
  return m.result?.result?.value;
};
const inExtension = async (expression) => {
  const ctx = page.contexts.filter((c) => c.origin === `chrome-extension://${EXT}`).pop();
  const m = await page.send("Runtime.evaluate", { contextId: ctx.id, expression, awaitPromise: true, returnByValue: true });
  return m.result?.result?.value;
};

const CURSOR = `(() => {
  let el = document.getElementById('demo-cursor');
  if (!el) {
    el = document.createElement('div');
    el.id = 'demo-cursor';
    el.setAttribute('data-ht-ui', '');
    el.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;left:0;top:0;' +
      'width:26px;height:26px;transform:translate(-3px,-2px);' +
      'filter:drop-shadow(0 2px 3px rgba(0,0,0,.45));';
    el.innerHTML = '<svg viewBox="0 0 24 24" width="26" height="26">' +
      '<path d="M5 2 L5 19 L9.5 15 L12.5 21.5 L15.5 20 L12.5 13.8 L19 13.5 Z" ' +
      'fill="#fff" stroke="#0f172a" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    document.body.appendChild(el);
  }
  return true;
})()`;

const LABEL = (text) => `(() => {
  let el = document.getElementById('demo-label');
  if (!el) {
    el = document.createElement('div');
    el.id = 'demo-label';
    el.setAttribute('data-ht-ui', '');
    el.style.cssText = 'position:fixed;z-index:2147483646;left:50%;top:18px;transform:translateX(-50%);' +
      'background:#0f172a;color:#f1f5f9;font:600 13px/1 system-ui,sans-serif;letter-spacing:.04em;' +
      'padding:9px 16px;border-radius:999px;box-shadow:0 6px 20px rgba(0,0,0,.3);';
    document.body.appendChild(el);
  }
  el.textContent = ${JSON.stringify(text)};
  return true;
})()`;

const moveCursor = (x, y) =>
  main(`(() => { const c = document.getElementById('demo-cursor');
    c.style.left = '${x}px'; c.style.top = '${y}px'; return true; })()`);

const frames = [];
// `from` is the tab being filmed: the demo page for most of it, the settings page for the last scene.
async function grab(from = page) {
  const shot = await from.send("Page.captureScreenshot", { format: "png" });
  const file = join(frameDir, `f${String(frames.length).padStart(4, "0")}.png`);
  await writeFile(file, Buffer.from(shot.result.data, "base64"));
  frames.push({ file, at: Date.now() });
  return file;
}

async function hold(ms, from = page) {
  const until = Date.now() + ms;
  while (Date.now() < until) await grab(from);
}

const tapCtrl = async (target = page) => {
  const key = { key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17 };
  await target.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...key, modifiers: 2 });
  await sleep(40);
  await target.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
};

// Straight lines look like a script; a hand arrives, slows down and settles.
async function approach(to, from = { x: 120, y: 90 }) {
  for (const step of [0.0, 0.4, 0.7, 0.9, 1.0]) {
    await moveCursor(Math.round(to.x * step + from.x * (1 - step)), Math.round(to.y * step + from.y * (1 - step)));
    await grab();
  }
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: to.x, y: to.y, button: "none" });
}

await rm(stills, { recursive: true, force: true });
await mkdir(stills, { recursive: true });
await mkdir(docs, { recursive: true });

const MODES = [
  ["replace", "Replace the text"],
  ["both", "Original and translation"],
  ["bubble", "Bubble, page untouched"],
];
const TARGET = `document.querySelector('.lead')`;

console.log("capturing:");
for (const [mode, caption] of MODES) {
  await inExtension(`chrome.storage.sync.set({displayMode: ${JSON.stringify(mode)}, minLoadingMs: ${LOADING_MS}})`);
  await sleep(500);
  await page.send("Page.reload");
  await sleep(2200);
  await main(CURSOR);
  await main(LABEL(caption));

  const rect = await main(`(() => { const r = ${TARGET}.getBoundingClientRect();
    return {x: Math.round(r.left + 150), y: Math.round(r.top + 14)}; })()`);

  // Approach, so the pointer is visibly on the text before anything happens.
  for (const step of [0.0, 0.4, 0.7, 0.9, 1.0]) {
    await moveCursor(Math.round(rect.x * step + 90 * (1 - step)), Math.round(rect.y * step + 60 * (1 - step)));
    await grab();
  }
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y, button: "none" });
  await hold(500);

  const key = { key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17 };
  await page.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...key, modifiers: 2 });
  await sleep(40);
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });

  // Mid-flight: the sweep is on screen for LOADING_MS, so this lands a still of it.
  await sleep(450);
  const loading = await grab();
  if (mode === "replace") await writeFile(join(stills, "0-loading.png"), await readFile(loading));
  await hold(LOADING_MS - 300);

  // Settled.
  await sleep(700);
  await hold(900);
  await writeFile(join(stills, `${MODES.findIndex((m) => m[0] === mode) + 1}-${mode}.png`), await readFile(await grab()));
  console.log(`  ${MODES.findIndex((m) => m[0] === mode) + 1}-${mode}.png`);
}
console.log("  0-loading.png");

// --- images ---------------------------------------------------------------
// Off by default, so the capture turns it on the way the settings page would. No host permission is needed
// here: the demo image is same-origin with the page, which the content script can fetch itself.
// Where this scene starts, so it can be cut out again as a GIF of its own for the README.
let imageStart = 0;
{
  imageStart = frames.length;
  await inExtension(`chrome.storage.sync.set({displayMode: "replace", translateImages: true, minLoadingMs: ${LOADING_MS}})`);
  await sleep(500);
  await page.send("Page.reload");
  await sleep(2200);
  await main(CURSOR);
  await main(LABEL("Images too"));

  // Nudged past centre so the headline clears the caption pill, which is pinned to the top.
  const rect = await main(`(() => { const img = document.querySelector('img.shot');
    img.scrollIntoView({block: 'center'});
    window.scrollBy(0, 70);
    const r = img.getBoundingClientRect();
    return {x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2)}; })()`);
  await hold(300);

  for (const step of [0.0, 0.4, 0.7, 0.9, 1.0]) {
    await moveCursor(Math.round(rect.x * step + 120 * (1 - step)), Math.round(rect.y * step + 90 * (1 - step)));
    await grab();
  }
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y, button: "none" });
  await hold(500);

  const key = { key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17 };
  await page.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...key, modifiers: 2 });
  await sleep(40);
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });

  // The bar sweeps across the middle of the image while the recogniser is working.
  await sleep(450);
  await writeFile(join(stills, "4-image-loading.png"), await readFile(await grab()));
  await hold(LOADING_MS - 300);

  // Reading an image takes longer than a block of text, so this waits on the result rather than
  // guessing at it: a fixed sleep captured the bar as often as the translation.
  for (let i = 0; i < 60; i++) {
    await grab();
    if (await main(`!!document.querySelector('body > [data-ht-ui="image"]')`)) break;
    await sleep(150);
  }
  await hold(1400);
  await writeFile(join(stills, "4-image.png"), await readFile(await grab()));
  console.log("  4-image-loading.png\n  4-image.png");
}

// --- a selection, in the page and in what you are writing -----------------
// The other half of the extension: not the block, but the words you highlighted. Two scenes, because
// they are two different things underneath and the second one is the reason people want it.
let selectionStart = 0;
{
  selectionStart = frames.length;
  await inExtension(`chrome.storage.sync.set({displayMode: "replace", translateImages: false,
    quickKey: "trigger", minLoadingMs: ${LOADING_MS},
    quickOrder: [{group:"latin",lang:"en"},{group:"han",lang:""},{group:"kana",lang:""},
                 {group:"hangul",lang:""},{group:"cyrillic",lang:""},{group:"arabic",lang:""},
                 {group:"other",lang:""}]})`);
  await sleep(500);
  await page.send("Page.reload");
  await sleep(2200);
  await main(CURSOR);
  await main(LABEL("Or only what you selected"));

  // Half a sentence, highlighted the way a reader would, so the scene shows the selection itself and
  // then the same words replaced with the rest of the line untouched around them.
  const at = await main(`(() => {
    const p = document.querySelectorAll('article > p')[3];
    p.scrollIntoView({block: 'center'});
    const node = p.firstChild;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, 22);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    const r = range.getClientRects()[0];
    return {x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2)}; })()`);
  await hold(700);
  await approach(at);
  await hold(600);
  await tapCtrl();
  await sleep(450);
  await hold(LOADING_MS - 300);
  await sleep(600);
  await hold(1300);
  await writeFile(join(stills, "5-selection.png"), await readFile(await grab()));
  console.log("  5-selection.png");
}

{
  // Writing a comment in your own language and sending it out in the page's: the one row that has to
  // be set for it, latin going to Chinese, is the row the settings page opens on.
  await inExtension(`chrome.storage.sync.set({quickOrder: [{group:"latin",lang:"zh"},
    {group:"han",lang:"en"},{group:"kana",lang:""},{group:"hangul",lang:""},
    {group:"cyrillic",lang:""},{group:"arabic",lang:""},{group:"other",lang:""}]})`);
  await sleep(400);
  await main(LABEL("Even what you are writing"));

  const box = await main(`(() => { const el = document.getElementById('comment');
    el.scrollIntoView({block: 'center'});
    const r = el.getBoundingClientRect();
    return {x: Math.round(r.left + 40), y: Math.round(r.top + 20)}; })()`);
  await approach(box);
  await hold(400);
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await grab();

  // Typed in pieces so the writing is something you watch happen rather than a jump cut.
  for (const chunk of ["Great review, ", "thanks. ", "Does it come ", "with a charger?"]) {
    await page.send("Input.insertText", { text: chunk });
    await hold(220);
  }
  await hold(500);

  const line = await main(`(() => { const el = document.getElementById('comment');
    el.setSelectionRange(0, el.value.length);
    const r = el.getBoundingClientRect();
    return {x: Math.round(r.left + 120), y: Math.round(r.top + 22)}; })()`);
  await moveCursor(line.x, line.y);
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: line.x, y: line.y, button: "none" });
  await hold(800);
  await tapCtrl();
  await sleep(450);
  await hold(LOADING_MS - 300);
  await sleep(600);
  await hold(1600);
  await writeFile(join(stills, "6-field.png"), await readFile(await grab()));
  console.log("  6-field.png");
}

// --- the settings, which are a page of their own --------------------------
let settingsStart = 0;
{
  settingsStart = frames.length;
  await inExtension(`chrome.storage.sync.set({displayMode: "replace", translateImages: false,
    quickKey: "trigger", minLoadingMs: 400,
    quickOrder: [{group:"latin",lang:"en"},{group:"han",lang:""},{group:"kana",lang:""},
                 {group:"hangul",lang:""},{group:"cyrillic",lang:""},{group:"arabic",lang:""},
                 {group:"other",lang:""}]})`);
  await sleep(400);

  const tab2 = await (await fetch(
    `http://127.0.0.1:${CDP}/json/new?chrome-extension://${EXT}/src/options/options.html`, { method: "PUT" },
  )).json();
  await sleep(1400);
  const options = attach(tab2.webSocketDebuggerUrl);
  await options.ready;
  await options.send("Runtime.enable");
  await options.send("Page.enable");
  await options.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await options.send("Page.bringToFront");
  await sleep(600);

  const onOptions = async (expression) => {
    const m = await options.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    return m.result?.result?.value;
  };
  await onOptions(CURSOR);
  await onOptions(LABEL("Everything else is a page"));
  // Parked somewhere sensible before the first frame, or it is drawn in the corner it was created in.
  await onOptions(`(() => { const c = document.getElementById('demo-cursor');
    c.style.left = '620px'; c.style.top = '300px'; return true; })()`);
  await hold(1100, options);
  await writeFile(join(stills, "7-settings.png"), await readFile(await grab(options)));

  // Unfolded, since a folded card in a still says nothing about what is in it.
  const summary = await onOptions(`(() => { const s = document.querySelector('details.card > summary');
    const r = s.getBoundingClientRect();
    return {x: Math.round(r.left + 40), y: Math.round(r.top + r.height / 2)}; })()`);
  for (const step of [0.0, 0.5, 0.8, 1.0]) {
    await onOptions(`(() => { const c = document.getElementById('demo-cursor');
      c.style.left = '${Math.round(summary.x * step + 620 * (1 - step))}px';
      c.style.top = '${Math.round(summary.y * step + 300 * (1 - step))}px'; return true; })()`);
    await grab(options);
  }
  await onOptions(`document.querySelector('details.card').open = true`);
  await hold(1500, options);

  // Down the page, slowly enough to read what is passing.
  for (let y = 0; y <= 900; y += 60) {
    await onOptions(`window.scrollTo(0, ${y})`);
    await grab(options);
  }
  await hold(1200, options);
  console.log("  7-settings.png");
}

chrome.kill();
server.close();
await sleep(300);

// --- assemble the animation ------------------------------------------------
// ffmpeg's concat demuxer holds each still for its own measured duration, so the result runs at the
// speed the capture actually happened rather than a flat frame rate.
async function frameList(subset, name) {
  const list = subset
    .map((frame, i) => {
      const next = subset[i + 1];
      const seconds = next ? Math.min(1.2, Math.max(0.04, (next.at - frame.at) / 1000)) : 1.6;
      return `file '${frame.file.split("\\").join("/")}'\nduration ${seconds.toFixed(3)}`;
    })
    .join("\n");
  const file = join(frameDir, name);
  await writeFile(file, `${list}\nfile '${subset.at(-1).file.split("\\").join("/")}'\n`);
  return file;
}

// Two passes: one to pick a palette across the whole clip, one to use it. A single pass would pick
// its palette from the first frame and band everything after it.
async function makeGif(listFile, out, width, tag) {
  const palette = join(frameDir, `palette-${tag}.png`);
  await run("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listFile,
    "-vf", `fps=12,scale=${width}:-1:flags=lanczos,palettegen=stats_mode=diff`, palette]);
  await run("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listFile, "-i", palette,
    "-lavfi", `fps=12,scale=${width}:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3`,
    "-loop", "0", out]);
}

const listFile = await frameList(frames, "frames.txt");

const mp4 = join(docs, "demo.mp4");
await run("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listFile,
  "-vf", "scale=1280:-2:flags=lanczos,fps=20", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23", mp4]);
console.log("  docs/demo.mp4");

await makeGif(listFile, join(docs, "demo.gif"), 880, "full");
console.log("  docs/demo.gif");

// Each scene again on its own, for the README section about it: the whole demo is too long to ask
// someone to sit through to reach the part they are reading about.
const imageList = await frameList(frames.slice(imageStart, selectionStart), "frames-image.txt");
await makeGif(imageList, join(docs, "demo-image.gif"), 760, "image");
console.log("  docs/demo-image.gif");

const selectionList = await frameList(frames.slice(selectionStart, settingsStart), "frames-selection.txt");
await makeGif(selectionList, join(docs, "demo-selection.gif"), 760, "selection");
console.log("  docs/demo-selection.gif");

const settingsList = await frameList(frames.slice(settingsStart), "frames-settings.txt");
await makeGif(settingsList, join(docs, "demo-settings.gif"), 760, "settings");
console.log("  docs/demo-settings.gif");

// YouTube is 16:9. Padding here rather than letting YouTube do it keeps the bars on brand.
await run("ffmpeg", ["-y", "-loglevel", "error", "-i", mp4,
  "-vf", "scale=1728:1080:flags=lanczos,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x0B3B47",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-movflags", "+faststart",
  join(docs, "demo-youtube.mp4")]);
console.log("  docs/demo-youtube.mp4");

await rm(frameDir, { recursive: true, force: true }).catch(() => {});
await rm(profile, { recursive: true, force: true }).catch(() => {});
console.log(`\n${frames.length} frames`);
process.exit(0);
