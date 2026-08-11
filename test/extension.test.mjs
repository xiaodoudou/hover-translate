// The only test that exercises the extension as Chrome actually runs it: a real unpacked install,
// real content script injection, real mouse and keyboard input.
//
//   node test/extension.test.mjs
//
// It serves the folder, launches its own headless Chrome with a throwaway profile and cleans up.
// Headless matters: with a visible window, CDP key events are dropped unless the OS focus is on it.

import { createServer } from "node:http";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, resolve, extname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// EXT_PATH points the install at an unpacked copy of the shipping ZIP, so the same assertions can
// be run against the artifact that actually goes to the store rather than the source tree.
const extPath = process.env.EXT_PATH ? resolve(process.env.EXT_PATH) : root;
const PORT = 8741;
const CDP_PORT = 9444;

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : "  <- " + detail}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- static server ------------------------------------------------------
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png" };
const server = createServer(async (req, res) => {
  try {
    const file = join(root, decodeURIComponent(req.url.split("?")[0]));
    const body = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

// --- chrome -------------------------------------------------------------
function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env["ProgramFiles(x86)"]}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
  ].filter(Boolean);
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error("Chrome not found; set CHROME_PATH");
  return found;
}

const profile = await mkdtemp(join(tmpdir(), "ht-chrome-"));
const chrome = spawn(findChrome(), [
  "--headless=new", `--user-data-dir=${profile}`, "--enable-unsafe-extension-debugging",
  `--remote-debugging-port=${CDP_PORT}`, "--no-first-run", "--no-default-browser-check",
  "--disable-sync", "--window-size=1200,900", "about:blank",
], { stdio: "ignore" });

async function cleanup(code) {
  chrome.kill();
  server.close();
  await sleep(400);
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  process.exit(code);
}

for (let i = 0; i < 40; i++) {
  await sleep(500);
  try { await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(); break; } catch {}
}

// --- CDP plumbing -------------------------------------------------------
function attach(wsUrl) {
  let nextId = 1;
  const pending = new Map();
  const contexts = [];
  const logs = [];
  const ws = new WebSocket(wsUrl);
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === "Runtime.executionContextCreated") contexts.push(m.params.context);
    if (m.method === "Runtime.consoleAPICalled")
      logs.push(`[${m.params.type}] ` + m.params.args.map((a) => a.value ?? a.description ?? a.type).join(" ").slice(0, 300));
    if (m.method === "Runtime.exceptionThrown")
      logs.push("[exception] " + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || "").slice(0, 400));
  });
  const ready = new Promise((r) => ws.addEventListener("open", r));
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = nextId++;
      pending.set(id, (m) => (m.error ? rej(new Error(method + " " + m.error.message)) : res(m.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { send, ready, contexts, logs };
}

try {
  const version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
  console.log(version.Browser);

  const browser = attach(version.webSocketDebuggerUrl);
  await browser.ready;
  const install = await browser.send("Extensions.loadUnpacked", { path: extPath });
  const EXT_ID = install.id;
  console.log(`installed as ${EXT_ID}\n`);
  check("extension installed", !!EXT_ID);

  const created = await (await fetch(
    `http://127.0.0.1:${CDP_PORT}/json/new?http://127.0.0.1:${PORT}/test/fixture.html`,
    { method: "PUT" },
  )).json();
  await sleep(1200);

  const page = attach(created.webSocketDebuggerUrl);
  await page.ready;
  await page.send("Runtime.enable");
  await page.send("Page.enable");
  await page.send("Page.reload");
  await sleep(2500);

  // The fixture frames a chat, so the extension has a world per frame. Everything below addresses
  // the top document, which has to be picked by frame id rather than by taking the last one.
  const { frameTree } = await page.send("Page.getFrameTree");
  const topFrameId = frameTree.frame.id;
  const worlds = page.contexts.filter((c) => c.origin === `chrome-extension://${EXT_ID}`);
  // Last, not first: the reload above leaves the pre-reload contexts in the list, and they are dead.
  const ctx = worlds.filter((c) => c.auxData?.frameId === topFrameId).pop() || worlds.pop();
  check("content script injected into its own isolated world", !!ctx, "content script never ran");
  check("and into the framed document as well", worlds.length > 1, `${worlds.length} world(s)`);
  if (!ctx) await cleanup(1);

  const ev = async (expression) => {
    const r = await page.send("Runtime.evaluate", { contextId: ctx.id, expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  check("loader ran", (await ev("window.__hoverTranslateLoaded")) === true);
  check("extension APIs reachable from the content script", (await ev("typeof chrome?.storage?.local")) === "object");

  const SEL = {
    zh: `[...document.querySelectorAll('p')].find(e => e.getAttribute('lang') === 'zh-CN')`,
    es: `[...document.querySelectorAll('p')].find(e => e.getAttribute('lang') === 'es')`,
    fr: `[...document.querySelectorAll('p')].find(e => e.getAttribute('lang') === 'fr')`,
    it: `[...document.querySelectorAll('p')].find(e => e.getAttribute('lang') === 'it')`,
    en: `[...document.querySelectorAll('p')].find(e => e.getAttribute('lang') === 'en')`,
    pre: `document.querySelector('pre code')`,
    // Tagged up front: their text is what gets translated, so a text-based selector stops matching.
    mixed: `document.querySelector('[data-test="mixed"]')`,
    order: `document.querySelector('[data-test="order"]')`,
    price: `[...document.querySelectorAll('p')].find(e => e.getAttribute('lang') === 'zh-CN' && e.querySelector('span.price'))`,
    wrapped: `[...document.querySelectorAll('p')].find(e => e.querySelector('a > span.price'))`,
    cell: `document.getElementById('order-cell')`,
    ja: `[...document.querySelectorAll('p')].find(e => e.getAttribute('lang') === 'ja')`,
    ru: `[...document.querySelectorAll('p')].find(e => e.getAttribute('lang') === 'ru')`,
    ko: `[...document.querySelectorAll('p')].find(e => e.getAttribute('lang') === 'ko')`,
    flex: `document.getElementById('flex-block')`,
    clipped: `document.getElementById('clipped-block')`,
    menu: `document.getElementById('menu-item')`,
    pinned: `document.getElementById('menu-pinned')`,
    de: `[...document.querySelectorAll('p')].find(e => e.getAttribute('lang') === 'de' && !e.classList.contains('notranslate'))`,
    stale: `document.querySelector('#stale-region h4')`,
  };

  // A tap, not a hold: press and release straight away, which is how people actually use it.
  // `aim` is where the pointer goes when the block's left edge holds something excluded, such as the
  // checkbox in the order cell: hovering that refuses, exactly as it should.
  async function ctrlTap(expr, settleMs = 15000, aim = expr) {
    const rect = await ev(`(() => { const el = ${aim}; if (!el) return null;
      el.scrollIntoView({block:'center'});
      const r = el.getBoundingClientRect();
      return {x: Math.round(r.left + Math.min(40, r.width/2)), y: Math.round(r.top + r.height/2)}; })()`);
    if (!rect) throw new Error("not found: " + expr);
    const was = await ev(`(${expr}).hasAttribute('data-ht-state')`);
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y, button: "none" });
    await sleep(80);
    const key = { key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17 };
    await page.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...key, modifiers: 2 });
    await sleep(40);
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
    const deadline = Date.now() + settleMs;
    while (Date.now() < deadline) {
      await sleep(150);
      const s = await ev(`(() => { const el = ${expr};
        return {pending: el.classList.contains('ht-pending'),
                translated: el.hasAttribute('data-ht-state')}; })()`);
      if (!s.pending && s.translated !== was) break;
    }
    await sleep(150);
  }
  const status = () => ev(`(async () => (await chrome.storage.local.get('status')).status)()`);

  await ev(`(() => {
    const tag = (needle, name) => {
      const el = [...document.querySelectorAll('p')].find((e) => e.textContent.includes(needle));
      if (el) el.setAttribute('data-test', name);
    };
    tag('奥丁2掌机', 'mixed');
    tag('订单号', 'order');
    return 'ok';
  })()`);

  // The loading state is a class, and nothing is ever appended. Watch both, so a regression that
  // reintroduces an inserted node is caught as well as one that drops the indicator.
  await ev(`window.__pending = 0; window.__added = 0;
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'attributes' && r.target.classList?.contains('ht-pending')) window.__pending++;
        if (r.type === 'childList') window.__added += r.addedNodes.length;
      }
    }).observe(document.body, {attributes: true, childList: true, subtree: true, attributeFilter: ['class']});
    'ok'`);

  console.log("\ntranslate with real input events");
  const zhBefore = await ev(`${SEL.zh}.textContent`);
  await ctrlTap(SEL.zh);
  const zhAfter = await ev(`${SEL.zh}.textContent`);
  console.log("   ", JSON.stringify(zhAfter.slice(0, 72)));
  console.log("   engine:", JSON.stringify(await status()));
  check("text was replaced", zhAfter !== zhBefore);
  check("no chinese left", !/[一-鿿]/.test(zhAfter));
  check("marked translated", (await ev(`${SEL.zh}.getAttribute('data-ht-state')`)) === "translated");
  check("pulse cleared", (await ev(`${SEL.zh}.classList.contains('ht-pending')`)) === false);
  check("engine recorded", !!(await status())?.engine);

  console.log("\nloading indicator and leftover styling");
  check("the loading state was shown while the request was in flight", (await ev(`window.__pending`)) > 0);
  check("no node was added to show it", (await ev(`window.__added`)) === 0, await ev(`window.__added`));
  check("the loading class is gone afterwards",
    (await ev(`document.querySelectorAll('.ht-pending, .ht-error').length`)) === 0);
  check("translated text carries no underline",
    (await ev(`getComputedStyle(${SEL.zh}).textDecorationLine`)) === "none",
    await ev(`getComputedStyle(${SEL.zh}).textDecorationLine`));
  check("and no leftover background of ours",
    (await ev(`getComputedStyle(${SEL.zh}).backgroundImage`)) === "none",
    await ev(`getComputedStyle(${SEL.zh}).backgroundImage`));

  // An !important background-position would outrank the keyframes and pin the gradient off-screen,
  // leaving a loading state that never moves. Sample the animation rather than trusting it.
  console.log("\nthe loading gradient actually sweeps");
  const sweep = await ev(`(() => {
    const el = document.querySelector('p.notranslate');
    el.classList.add('ht-pending');
    const anim = el.getAnimations().find((a) => a.animationName === 'ht-sweep');
    if (!anim) { el.classList.remove('ht-pending'); return null; }
    const before = el.getBoundingClientRect().height;
    const samples = [];
    for (const t of [0, 0.5, 0.99]) {
      anim.pause();
      anim.currentTime = t * 1100;
      samples.push(getComputedStyle(el).backgroundPosition);
    }
    const after = el.getBoundingClientRect().height;
    anim.cancel();
    el.classList.remove('ht-pending');
    return { samples, before, after };
  })()`);
  console.log("   ", JSON.stringify(sweep?.samples));
  check("the sweep animation is running", sweep !== null);
  check("the gradient moves rather than sitting still",
    new Set(sweep?.samples || []).size === 3, JSON.stringify(sweep?.samples));
  check("it is painted along the bottom edge",
    (sweep?.samples || []).every((s) => s.endsWith("100%")), JSON.stringify(sweep?.samples));
  check("and it costs no height", sweep?.before === sweep?.after,
    `${sweep?.before} vs ${sweep?.after}`);

  console.log("\nthe loading state is held long enough to be seen");
  await ev(`chrome.storage.sync.set({minLoadingMs: 1200})`);
  await sleep(400);
  const heldFrom = Date.now();
  await ctrlTap(SEL.ja);
  const held = Date.now() - heldFrom;
  console.log(`    ${held}ms from trigger to translated`);
  check("a fast translation still shows the gradient for the configured minimum", held >= 1200,
    `${held}ms`);
  check("the japanese paragraph did translate", (await ev(`${SEL.ja}.hasAttribute('data-ht-state')`)) === true);
  await ctrlTap(SEL.ja, 6000); // put it back
  await ev(`chrome.storage.sync.set({minLoadingMs: 0})`);
  await sleep(400);

  console.log("\ntapping translated text restores it");
  await ctrlTap(SEL.zh, 6000);
  check("original restored", (await ev(`${SEL.zh}.textContent`)) === zhBefore);
  check("state cleared", (await ev(`${SEL.zh}.hasAttribute('data-ht-state')`)) === false);

  console.log("\nmarkup survives");
  await ctrlTap(SEL.es);
  check("spanish translated", (await ev(`${SEL.es}.hasAttribute('data-ht-state')`)) === true);
  check("code span byte for byte", (await ev(`${SEL.es}.querySelector('code')?.textContent`)) === "npm install --save-dev vite");
  await ctrlTap(SEL.fr);
  check("link href kept", (await ev(`${SEL.fr}.querySelector('a')?.getAttribute('href')`)) === "https://example.com");
  check("link text translated", /sofa|couch/i.test(await ev(`${SEL.fr}.querySelector('a')?.textContent || ''`)),
    await ev(`${SEL.fr}.querySelector('a')?.textContent`));
  await ctrlTap(SEL.it);
  check("image kept", (await ev(`!!${SEL.it}.querySelector('img')`)) === true);
  check("superscript kept", (await ev(`${SEL.it}.querySelector('sup')?.textContent`)) === "1");

  console.log("\npage styling is preserved");
  await ctrlTap(SEL.price);
  check("chinese price line translated", (await ev(`${SEL.price}.hasAttribute('data-ht-state')`)) === true);
  // Providers redistribute words across the tags, so assert the span and its price, not exact wording.
  check("the short styled span keeps its class and its price",
    /¥199/.test((await ev(`${SEL.price}.querySelector('span.price')?.textContent`)) || ""),
    await ev(`${SEL.price}.innerHTML`));
  check("and keeps its colour",
    (await ev(`getComputedStyle(${SEL.price}.querySelector('span.price')).color`)) === "rgb(220, 38, 38)");
  await ctrlTap(SEL.wrapped);
  check("a wrapper chain keeps its inner span",
    (await ev(`!!${SEL.wrapped}.querySelector('a > span.price')`)) === true,
    await ev(`${SEL.wrapped}.innerHTML`));

  // The engines start a fresh sentence at every tag boundary and capitalise it. Anything capitalised
  // mid-sentence that is not a plausible proper noun is a regression of that fix.
  const strays = await ev(`(() => {
    const text = ${SEL.price}.textContent;
    return [...text.matchAll(/[a-z,;]\\s+([A-Z][a-z]+)/g)].map((m) => m[1]);
  })()`);
  console.log("   price line:", JSON.stringify(await ev(`${SEL.price}.textContent`)));
  check("no stray capitals were left at the tag boundaries", strays.length === 0, JSON.stringify(strays));

  console.log("\na real order row keeps every tag and every node");
  const cellElements = await ev(`${SEL.cell}.querySelectorAll('*').length`);
  const cellBefore = await ev(`${SEL.cell}.textContent`);
  // An expando survives on the original node but not on a clone, so this proves node identity.
  await ev(`[...${SEL.cell}.querySelectorAll('*')].forEach((n, i) => { n.__htId = i; }); 'ok'`);
  await ctrlTap(SEL.cell, 15000, `${SEL.cell}.querySelector('span[data-spm-anchor-id]')`);
  console.log("   ", JSON.stringify(await ev(`${SEL.cell}.innerHTML`)));
  check("the cell was translated", (await ev(`${SEL.cell}.textContent`)) !== cellBefore);
  check("no element was lost", (await ev(`${SEL.cell}.querySelectorAll('*').length`)) === cellElements,
    `${await ev(`${SEL.cell}.querySelectorAll('*').length`)} vs ${cellElements}`);
  check("the disabled checkbox survives",
    (await ev(`${SEL.cell}.querySelector('input[type="checkbox"]')?.disabled`)) === true);
  check("the date keeps its create-time span",
    (await ev(`${SEL.cell}.querySelector('span.create-time')?.textContent`)) === "2026-07-23",
    await ev(`${SEL.cell}.innerHTML`));
  check("and the date is still bold",
    (await ev(`getComputedStyle(${SEL.cell}.querySelector('span.create-time')).fontWeight`)) === "700");
  check("the order number keeps its data attribute",
    (await ev(`${SEL.cell}.querySelector('span[data-spm-anchor-id]')?.textContent`))?.trim() ===
      "3313704182876019697");
  check("the chinese label was translated",
    /order|number/i.test(await ev(`${SEL.cell}.textContent`)), await ev(`${SEL.cell}.textContent`));
  check("not one node was replaced: a reactive page keeps its tree",
    (await ev(`[...${SEL.cell}.querySelectorAll('*')].every((n, i) => n.__htId === i)`)) === true,
    await ev(`JSON.stringify([...${SEL.cell}.querySelectorAll('*')].map(n => n.__htId))`));

  console.log("\nmixed script is not mistaken for english");
  const mixedBefore = await ev(`${SEL.mixed}.textContent`);
  await ctrlTap(SEL.mixed);
  console.log("   ", JSON.stringify((await ev(`${SEL.mixed}.textContent`)).slice(0, 76)));
  console.log("   ", JSON.stringify(await status()));
  check("chinese padded with latin brand names is translated",
    (await ev(`${SEL.mixed}.textContent`)) !== mixedBefore);
  check("it was not skipped as already english", (await status())?.engine !== "skipped", JSON.stringify(await status()));

  // The regression that started this: Chinese inside styled spans leaves a main string of nothing
  // but placeholders and brand names, which the endpoint detects as "no". The block used to be
  // skipped as "already English" on the strength of that one result.
  const splitBefore = await ev(`document.getElementById('split-title').textContent`);
  await ctrlTap(`document.getElementById('split-title')`);
  console.log("   ", JSON.stringify(await ev(`document.getElementById('split-title').textContent`)));
  console.log("   ", JSON.stringify(await status()));
  check("a block whose main string is latin-only still translates",
    (await ev(`document.getElementById('split-title').textContent`)) !== splitBefore);
  check("it was not skipped", (await status())?.engine !== "skipped", JSON.stringify(await status()));
  check("its styled spans survived",
    (await ev(`document.getElementById('split-title').querySelectorAll('span.price').length`)) === 2);

  const orderBefore = await ev(`${SEL.order}.textContent`);
  await ctrlTap(SEL.order);
  console.log("   ", JSON.stringify(await ev(`${SEL.order}.textContent`)));
  check("a date and order number with han is translated",
    (await ev(`${SEL.order}.textContent`)) !== orderBefore);
  check("and was not skipped either", (await status())?.engine !== "skipped", JSON.stringify(await status()));

  // A page cuts these boxes to fit its own language, so the longer translation ends up behind the
  // ellipsis. It has to slide under the pointer, and it has to do that without resizing the box.
  // Both rows below are built around their one line, so there is no room to take and they slide.
  console.log("\na clipped line slides so the whole translation can be read");
  await ev(`chrome.storage.sync.set({clippedLines: 'fit'})`);
  await sleep(500);
  const nudge = async (expr) => {
    const at = await ev(`(() => { const r = ${expr}.getBoundingClientRect();
      return {x: Math.round(r.left + Math.min(40, r.width / 2)), y: Math.round(r.top + r.height / 2)}; })()`);
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y, button: "none" });
    await sleep(150);
  };
  const away = async () => {
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 4, y: 4, button: "none" });
    await sleep(250);
  };
  for (const [name, sel, box, clips] of [
    ["the block itself clips", SEL.clipped, SEL.clipped, "P"],
    ["a box inside the block clips", SEL.pinned, `${SEL.pinned}.querySelector('.menu-label')`, "SPAN"],
  ]) {
    const widthBefore = await ev(`Math.round(${box}.getBoundingClientRect().width)`);
    // Where the first glyph actually sits, not what the computed style claims. Asserting the
    // property alone would pass on a line that never moved a pixel on screen.
    const probe = `(() => {
      const el = ${sel}.matches('.ht-marquee') ? ${sel} : ${sel}.querySelector('.ht-marquee');
      if (!el) return null;
      const runner = el.querySelector('.ht-marquee-line');
      const anim = runner?.getAnimations().find((a) => a.id === 'ht-marquee');
      const text = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode();
      const charAt = () => {
        const r = document.createRange();
        r.setStart(text, 0); r.setEnd(text, 1);
        return Math.round(r.getBoundingClientRect().left - el.getBoundingClientRect().left);
      };
      const was = { state: anim?.playState, at: anim?.currentTime };
      const samples = [];
      if (anim && was.state === 'running') {
        const step = anim.effect.getComputedTiming().duration;
        // Not a sample at 1: the lap is half open, and that instant belongs to the next one.
        for (const t of [0, 0.25, 0.5, 0.75, 0.999]) {
          anim.pause();
          anim.currentTime = t * step;
          samples.push(charAt());
        }
        anim.currentTime = was.at;
        anim.play();
      }
      const frames = anim
        ? anim.effect.getKeyframes().map((f) => Math.round(parseFloat(f.transform.match(/-?[\\d.]+/)[0])))
        : null;
      return { tag: el.tagName, view: el.clientWidth, frames, samples, runner: !!runner,
               state: was.state, at: Math.round(was.at ?? -1),
               lap: anim ? Math.round(anim.effect.getComputedTiming().duration) : null,
               char: charAt(),
               moving: el.classList.contains('ht-marquee-moving'),
               ellipsis: getComputedStyle(el).textOverflow,
               width: Math.round(el.getBoundingClientRect().width) };
    })()`;

    await ctrlTap(sel);
    // The pointer never left, but the text under it changed: nudge it so the hover is settled.
    await nudge(box);
    // It waits before it sets off, so the beginning can be read where the reader was already looking.
    const waiting = await ev(probe);
    check(`${name}: it holds still at first, where the page drew the line`,
      waiting?.state === "paused" && waiting?.char === 0,
      JSON.stringify({ state: waiting?.state, char: waiting?.char }));
    check(`${name}: keeping the page's ellipsis until it actually sets off`,
      waiting?.ellipsis !== "clip" && waiting?.moving === false, waiting?.ellipsis);
    await sleep(1400);

    const slide = await ev(probe);
    console.log(`   ${name}:`, JSON.stringify(slide));
    check(`${name}: the box that clips is marked`, !!slide, "nothing was marked");
    check(`${name}: and it is that box, not whatever the block happens to be`, slide?.tag === clips,
      slide?.tag);
    check(`${name}: sliding costs the box no width`, slide && slide.width === widthBefore,
      `${slide?.width} vs ${widthBefore}`);
    // The pointer never left, so the wait is all it was ever going to need.
    check(`${name}: and then it goes, without being asked twice`, slide?.state === "running",
      slide?.state);
    check(`${name}: a lap starts with the line off the right edge`,
      slide && slide.frames[0] === slide.view, JSON.stringify(slide?.frames));
    check(`${name}: and ends with it gone past the left one, so the wrap has no seam`,
      slide && slide.frames[1] < 0 && Math.abs(slide.frames[1]) > slide.view,
      JSON.stringify(slide?.frames));
    // The check that matters: the glyphs themselves march left, one sample after another.
    check(`${name}: and the text really travels, every sample left of the one before`,
      slide && slide.samples.every((x, i) => i === 0 || x < slide.samples[i - 1]),
      JSON.stringify(slide?.samples));
    check(`${name}: the ellipsis is out of the way while it moves`, slide?.ellipsis === "clip",
      slide?.ellipsis);

    // What every earlier attempt got wrong: it stopped. A marquee keeps going.
    const first = await ev(probe);
    await sleep(1200);
    const later = await ev(probe);
    console.log(`   ${name} still going:`, JSON.stringify({ from: first.char, to: later.char, at: later.at }));
    check(`${name}: it is still running a second later, not parked somewhere`,
      later?.state === "running" && later.at > first.at, JSON.stringify({ was: first?.at, now: later?.at }));
    check(`${name}: and the line is somewhere else on the screen than it was`,
      later && first && later.char !== first.char, `${first?.char} -> ${later?.char}`);

    await away();
    await sleep(300);
    const parked = await ev(probe);
    console.log(`   ${name} parked:`, JSON.stringify({ state: parked.state ?? "gone", char: parked.char, ellipsis: parked.ellipsis }));
    check(`${name}: leaving the block gives the page its line back`,
      parked?.char === 0 && parked?.state === undefined,
      JSON.stringify({ char: parked?.char, state: parked?.state ?? "gone" }));
    check(`${name}: with the page's own ellipsis back`,
      parked?.ellipsis !== "clip" && parked?.moving === false, parked?.ellipsis);
    await nudge(box);
    await sleep(1400);
    const resumed = await ev(probe);
    check(`${name}: coming back sets it going again`, resumed?.state === "running", resumed?.state);

    await ctrlTap(sel, 6000);
    check(`${name}: reverting leaves no marker behind`,
      (await ev(`${sel}.querySelectorAll('.ht-marquee').length + (${sel}.matches('.ht-marquee') ? 1 : 0)`)) === 0);
    check(`${name}: and no animation of ours left running`,
      (await ev(`${box}.getAnimations().filter((a) => a.id === 'ht-marquee').length`)) === 0);
    check(`${name}: and the wrapper it moved is gone with it`,
      (await ev(`${sel}.querySelectorAll('.ht-marquee-line').length`)) === 0);
    check(`${name}: and no leftover style attribute`,
      (await ev(`${box}.getAttribute('style')`)) === null, await ev(`${box}.getAttribute('style')`));
  }

  // The other answer to the same line: keep the line and let the box grow instead. On the row built
  // around its one line, since that is the one the default slides.
  console.log("\ngrowing the box rather than moving the line");
  const shapeOf = (row) => ev(`(() => { const el = ${row}.querySelector('.menu-label');
    const r = el.getBoundingClientRect();
    return { cls: el.className, w: Math.round(r.width), h: Math.round(r.height),
             hides: el.scrollWidth - el.clientWidth }; })()`);
  const shape = () => shapeOf(SEL.menu);
  await ctrlTap(SEL.pinned);
  const sliding = await shapeOf(SEL.pinned);
  await ev(`chrome.storage.sync.set({clippedLines: 'grow'})`);
  await sleep(700);
  const grown = await shapeOf(SEL.pinned);
  console.log("   ", JSON.stringify({ sliding, grown }));
  check("the line that was sliding is unclipped instead, without translating again",
    grown.cls.includes("ht-unclipped") && !grown.cls.includes("ht-marquee"), grown.cls);
  check("the whole translation is on screen", grown.hides === 0, `${grown.hides}px still hidden`);
  check("the box grew downwards, not sideways", grown.h > sliding.h && grown.w === sliding.w,
    JSON.stringify(grown));
  await ev(`chrome.storage.sync.set({clippedLines: 'fit'})`);
  await sleep(700);
  check("and switching back puts the page's own size back",
    (await shapeOf(SEL.pinned)).w === sliding.w && (await shapeOf(SEL.pinned)).h === sliding.h);
  await ctrlTap(SEL.pinned, 6000);

  console.log("\ngrowing only where the page has room for it");
  await ev(`chrome.storage.sync.set({clippedLines: 'fit'})`);
  await sleep(500);
  // Document-relative: a tap scrolls its row into view, so a viewport-relative bottom would move
  // with the scroll rather than with the layout this is asking about.
  const menuBottomAt = () => ev(`Math.round(${SEL.menu}.getBoundingClientRect().bottom + scrollY)`);
  const menuBottom = await menuBottomAt();
  await ctrlTap(SEL.menu);
  check("a row with slack the page already had grows into it",
    (await shape()).cls.includes("ht-unclipped"), (await shape()).cls);
  check("and the row still ends where it did, so nothing below it moved",
    (await menuBottomAt()) === menuBottom, `${await menuBottomAt()} vs ${menuBottom}`);
  await ctrlTap(SEL.menu, 6000);

  // The sidebar case that started this: a row as tall as its one line has no room to give, and
  // taking it would push every row below down.
  const pinnedHeight = await ev(`Math.round(${SEL.pinned}.getBoundingClientRect().height)`);
  await ctrlTap(SEL.pinned);
  const pinnedBox = await ev(`(() => { const el = ${SEL.pinned}.querySelector('.menu-label');
    return { cls: el.className, boxBottom: Math.round(el.getBoundingClientRect().bottom),
             blockBottom: Math.round(${SEL.pinned}.getBoundingClientRect().bottom),
             height: Math.round(${SEL.pinned}.getBoundingClientRect().height) }; })()`);
  console.log("   a row built around its line:", JSON.stringify(pinnedBox));
  check("a row built around its one line slides rather than shoving the page down",
    pinnedBox.cls.includes("ht-marquee") && !pinnedBox.cls.includes("ht-unclipped"), pinnedBox.cls);
  check("and it is still one line tall", pinnedBox.height === pinnedHeight,
    `${pinnedBox.height} vs ${pinnedHeight}`);
  check("and it stayed inside the box the page drew",
    pinnedBox.boxBottom <= pinnedBox.blockBottom + 1, JSON.stringify(pinnedBox));
  await ctrlTap(SEL.pinned, 6000);
  await ev(`chrome.storage.sync.set({clippedLines: 'fit'})`);
  await sleep(500);

  console.log("\nskips and exclusions");
  const preBefore = await ev(`${SEL.pre}.textContent`);
  await ctrlTap(SEL.pre, 2000).catch(() => {});
  check("pre untouched", (await ev(`${SEL.pre}.textContent`)) === preBefore);
  const enBefore = await ev(`${SEL.en}.textContent`);
  await ctrlTap(SEL.en, 8000);
  check("english left alone", (await ev(`${SEL.en}.textContent`)) === enBefore);
  check("english reported as skipped", (await status())?.engine === "skipped", JSON.stringify(await status()));

  // aria-hidden on a container is not a refusal: pages leave it on regions they are still drawing.
  const staleBefore = await ev(`${SEL.stale}.textContent`);
  await ctrlTap(SEL.stale, 8000);
  check("a row a page only claims is hidden is still translated",
    (await ev(`${SEL.stale}.textContent`)) !== staleBefore,
    JSON.stringify(await ev(`${SEL.stale}.textContent`)));
  check("and the link it sits in is still a link",
    (await ev(`Boolean(${SEL.stale}.querySelector('a'))`)) === true);

  console.log("\nescape restores the page");
  const esc = { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 };
  await page.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...esc });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...esc });
  await sleep(500);
  check("nothing translated remains", (await ev(`document.querySelectorAll('[data-ht-state]').length`)) === 0);
  check("code element restored", (await ev(`${SEL.es}.querySelector('code')?.textContent`)) === "npm install --save-dev vite");
  check("image restored", (await ev(`!!${SEL.it}.querySelector('img')`)) === true);
  check("french reads french again", (await ev(`${SEL.fr}.textContent`)).includes("canapé rouge"));

  console.log("\nctrl+c is not hijacked");
  for (const e of [
    { type: "rawKeyDown", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: 2 },
    { type: "rawKeyDown", key: "c", code: "KeyC", windowsVirtualKeyCode: 67, nativeVirtualKeyCode: 67, modifiers: 2 },
    { type: "keyUp", key: "c", code: "KeyC", windowsVirtualKeyCode: 67, nativeVirtualKeyCode: 67, modifiers: 2 },
    { type: "keyUp", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17 },
  ]) await page.send("Input.dispatchKeyEvent", e);
  await sleep(1500);
  check("no translation fired", (await ev(`document.querySelectorAll('[data-ht-state]').length`)) === 0);

  // Holding the key should say what it is about to act on, and say it without moving anything: an
  // outline is painted outside the box and takes no space, where a border would have to come out of
  // the element's own size or push its neighbours down.
  console.log("\nholding the key shows what it would translate");
  const aimShape = () => ev(`(() => { const el = ${SEL.fr}; const r = el.getBoundingClientRect();
    const next = el.nextElementSibling;
    return { cls: el.className, w: Math.round(r.width), h: Math.round(r.height),
             nextTop: next ? Math.round(next.getBoundingClientRect().top + scrollY) : null,
             docH: Math.round(document.documentElement.scrollHeight),
             outline: getComputedStyle(el).outlineWidth,
             aimed: document.querySelectorAll('.ht-aim').length }; })()`);
  const aimSpot = await ev(`(() => { const el = ${SEL.fr}; el.scrollIntoView({block:'center'});
    const r = el.getBoundingClientRect();
    return {x: Math.round(r.left + Math.min(40, r.width / 2)), y: Math.round(r.top + r.height / 2)}; })()`);
  const beforeAim = await aimShape();
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: aimSpot.x, y: aimSpot.y, button: "none" });
  await sleep(120);
  const aimKey = { key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17 };
  await page.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...aimKey });
  await sleep(250);
  const aimed = await aimShape();
  console.log("   ", JSON.stringify({ before: beforeAim, aimed }));
  check("the block under the pointer is outlined while the key is held",
    aimed.cls.includes("ht-aim") && aimed.aimed === 1, `${aimed.cls} / ${aimed.aimed}`);
  check("drawn as an outline, which is painted outside the box", aimed.outline === "2px", aimed.outline);
  check("the block is exactly the size it was", aimed.w === beforeAim.w && aimed.h === beforeAim.h,
    JSON.stringify({ w: [beforeAim.w, aimed.w], h: [beforeAim.h, aimed.h] }));
  check("and nothing around it moved",
    aimed.nextTop === beforeAim.nextTop && aimed.docH === beforeAim.docH,
    JSON.stringify({ nextTop: [beforeAim.nextTop, aimed.nextTop], docH: [beforeAim.docH, aimed.docH] }));

  // Holding is aiming and nothing else. Anything that fired while the key was down would fire on a
  // block the user is still choosing, and would do it behind the outline pointing at it.
  await sleep(1400);
  check("and holding it translates nothing, however long it is held",
    (await ev(`document.querySelectorAll('[data-ht-state]').length`)) === 0);
  check("the outline is still the only thing on the block",
    (await ev(`document.querySelectorAll('.ht-aim').length`)) === 1);

  // The press that turns out to be a shortcut takes the outline with it, so nothing is left marked.
  for (const type of ["rawKeyDown", "keyUp"]) {
    await page.send("Input.dispatchKeyEvent", {
      type, key: "c", code: "KeyC", windowsVirtualKeyCode: 67, nativeVirtualKeyCode: 67, modifiers: 2,
    });
  }
  await sleep(200);
  check("a shortcut being typed takes the outline away again",
    (await ev(`document.querySelectorAll('.ht-aim').length`)) === 0);
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...aimKey });
  await sleep(800);
  check("and the cancelled press translated nothing",
    (await ev(`document.querySelectorAll('[data-ht-state]').length`)) === 0);
  check("leaving no class of ours on the block",
    (await ev(`${SEL.fr}.className.includes('ht-')`)) === false, await ev(`${SEL.fr}.className`));

  // --- every provider, driven through the real extension ----------------
  console.log("\neach provider serves a real page");
  const TAGGED = "<b0>这是一段</b0>简体中文的<b1>测试文字</b1>。";
  for (const provider of ["google", "tencent", "mymemory"]) {
    const out = await ev(`(async () => await chrome.runtime.sendMessage(
      {type: 'translate', texts: [${JSON.stringify(TAGGED)}], targetLang: 'en',
       order: [${JSON.stringify(provider)}]}))()`);
    console.log(`    ${provider}: ${JSON.stringify(out?.texts?.[0] ?? out)}`);
    check(`${provider} answered through the background worker`, out?.engine === provider, JSON.stringify(out));
    check(`${provider} kept both tag pairs`,
      /<b0>[\s\S]*<\/b0>/.test(out?.texts?.[0] || "") && /<b1>[\s\S]*<\/b1>/.test(out?.texts?.[0] || ""),
      out?.texts?.[0]);
  }

  console.log("\nthe provider chosen in the popup is the one used");
  await ev(`chrome.storage.sync.set({providerOrder: ['tencent']})`);
  await sleep(600);
  await ctrlTap(SEL.ko);
  console.log("   ", JSON.stringify(await ev(`${SEL.ko}.textContent`)));
  check("the korean paragraph translated", (await ev(`${SEL.ko}.hasAttribute('data-ht-state')`)) === true);
  check("and tencent served it", (await status())?.engine === "tencent", JSON.stringify(await status()));
  await ctrlTap(SEL.ko, 6000); // leave it untranslated for the display-mode checks below
  await ev(`chrome.storage.sync.set({providerOrder: ['google','tencent','mymemory']})`);
  await sleep(600);

  console.log("\nthe reported duration is the provider's own round trip");
  const timing = await status();
  console.log("   ", JSON.stringify(timing));
  check("a duration was recorded", typeof timing?.ms === "number", JSON.stringify(timing));
  check("and it is a plausible round trip", timing?.ms > 0 && timing?.ms < 15000, String(timing?.ms));

  // --- display modes ----------------------------------------------------
  console.log("\nthe marker modes are visual only and cost no layout");
  for (const [mode, cls, expect] of [
    ["outlined", "ht-mark-outline", "outline"],
    ["underlined", "ht-mark-underline", "solid"],
    ["dashed", "ht-mark-dashed", "dashed"],
  ]) {
    await ev(`chrome.storage.sync.set({displayMode: ${JSON.stringify(mode)}})`);
    await sleep(500);
    const before = await ev(`(() => { const r = ${SEL.de}.getBoundingClientRect();
      return {w: Math.round(r.width), h: Math.round(r.height)}; })()`);
    await ctrlTap(SEL.de);
    const after = await ev(`(() => { const el = ${SEL.de}; const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return {w: Math.round(r.width), h: Math.round(r.height),
              marked: el.classList.contains(${JSON.stringify(cls)}),
              outline: s.outlineStyle, decoration: s.textDecorationStyle,
              line: s.textDecorationLine}; })()`);
    console.log(`   ${mode}:`, JSON.stringify(after));
    check(`${mode}: the block carries its marker class`, after.marked, JSON.stringify(after));
    check(`${mode}: the marker is actually painted`,
      expect === "outline" ? after.outline === "solid"
        : after.line === "underline" && after.decoration === expect, JSON.stringify(after));
    check(`${mode}: the box did not change size`,
      after.w === before.w && after.h === before.h,
      `${JSON.stringify(before)} vs ${JSON.stringify(after)}`);
    await ctrlTap(SEL.de, 6000);
    check(`${mode}: reverting clears the marker`,
      (await ev(`${SEL.de}.classList.contains(${JSON.stringify(cls)})`)) === false);
  }
  await ev(`chrome.storage.sync.set({displayMode: 'replace'})`);
  await sleep(500);

  console.log("\nbilingual mode keeps the original and adds the translation");
  await ev(`chrome.storage.sync.set({displayMode: 'both'})`);
  await sleep(600);
  // The order cell is the harsh case: an id, a form control and several styled spans. Cloning the
  // subtree to show both languages would duplicate every one of them.
  await ctrlTap(SEL.cell, 15000, `${SEL.cell}.querySelector('span[data-spm-anchor-id]')`);
  check("bilingual adds exactly one node",
    (await ev(`${SEL.cell}.querySelectorAll('[data-ht-ui]').length`)) === 1,
    await ev(`${SEL.cell}.innerHTML`));
  check("and clones no element at all",
    (await ev(`${SEL.cell}.querySelectorAll('input').length`)) === 1 &&
      (await ev(`${SEL.cell}.querySelectorAll('span.create-time').length`)) === 1,
    await ev(`${SEL.cell}.innerHTML`));
  check("the original cell text is untouched",
    (await ev(`${SEL.cell}.querySelector('span.create-time').textContent`)) === "2026-07-23");
  check("the translation was added as text",
    /order/i.test(await ev(`${SEL.cell}.querySelector('[data-ht-ui]').textContent`)),
    await ev(`${SEL.cell}.querySelector('[data-ht-ui]')?.textContent`));
  await ctrlTap(SEL.cell, 6000, `${SEL.cell}.querySelector('span[data-spm-anchor-id]')`);
  check("reverting removes it again",
    (await ev(`${SEL.cell}.querySelectorAll('[data-ht-ui]').length`)) === 0);

  // A flex parent would put the added line beside the original, and a nowrap plus overflow-hidden
  // parent would clip it out of sight. Both have to end up readable on their own line.
  for (const [name, sel] of [["flex", SEL.flex], ["clipped", SEL.clipped]]) {
    await ctrlTap(sel);
    const box = await ev(`(() => {
      // A flex or grid block gets its line placed after it rather than inside it.
      const holder = ${sel}.querySelector('[data-ht-ui]')
        || (${sel}.nextElementSibling?.hasAttribute('data-ht-ui') ? ${sel}.nextElementSibling : null);
      if (!holder) return null;
      const h = holder.getBoundingClientRect();
      // Measure the last original node, not the block: the block's own rect has already grown to
      // include the line we are trying to check, which would make the comparison circular.
      const prev = holder.parentElement === ${sel} ? holder.previousSibling : ${sel};
      let last;
      if (prev && prev.nodeType === 1) last = prev.getBoundingClientRect();
      else {
        const range = document.createRange();
        range.selectNodeContents(prev ?? ${sel});
        last = range.getBoundingClientRect();
      }
      const style = getComputedStyle(holder);
      return { top: Math.round(h.top), left: Math.round(h.left), width: Math.round(h.width),
               height: Math.round(h.height), originalBottom: Math.round(last.bottom),
               blockLeft: Math.round(${sel}.getBoundingClientRect().left),
               text: holder.textContent.trim(), whiteSpace: style.whiteSpace,
               overflow: style.overflow, visibility: style.visibility };
    })()`);
    console.log(`   ${name}:`, JSON.stringify(box));
    check(`${name} parent: the translation exists`, !!box?.text, JSON.stringify(box));
    check(`${name} parent: it sits below the original, not beside it`,
      box && box.top >= box.originalBottom - 2, JSON.stringify(box));
    check(`${name} parent: it starts at the block's left edge`,
      box && Math.abs(box.left - box.blockLeft) <= 4, JSON.stringify(box));
    check(`${name} parent: it has real height so it is visible`, box && box.height > 0, JSON.stringify(box));
    check(`${name} parent: it is not clipped to one nowrap line`,
      box && box.whiteSpace === "normal" && box.overflow === "visible", JSON.stringify(box));
    await ctrlTap(sel, 6000);
  }

  const ruBefore = await ev(`${SEL.ru}.textContent`);
  await ctrlTap(SEL.ru);
  const ruAfter = await ev(`${SEL.ru}.textContent`);
  console.log("   ", JSON.stringify(ruAfter.slice(0, 120)));
  check("the original russian is still there", ruAfter.startsWith(ruBefore),
    JSON.stringify(ruAfter.slice(0, 60)));
  check("and an english translation was added after it",
    /test|paragraph/i.test(ruAfter.slice(ruBefore.length)),
    JSON.stringify(ruAfter.slice(ruBefore.length, ruBefore.length + 90)));
  await ctrlTap(SEL.ru, 6000);
  check("reverting removes the added translation", (await ev(`${SEL.ru}.textContent`)) === ruBefore,
    JSON.stringify(await ev(`${SEL.ru}.textContent`)));

  console.log("\nbubble mode leaves the page completely alone");
  await ev(`chrome.storage.sync.set({displayMode: 'bubble'})`);
  await sleep(600);
  const koBefore = await ev(`${SEL.ko}.textContent`);
  const nodesBefore = await ev(`document.querySelectorAll('*').length`);
  await ctrlTap(SEL.ko);
  check("the korean paragraph is untouched", (await ev(`${SEL.ko}.textContent`)) === koBefore);
  check("a bubble appeared outside the block",
    (await ev(`document.querySelectorAll('body > [data-ht-ui]').length`)) === 1);
  check("and nothing else was added to the page",
    (await ev(`document.querySelectorAll('*').length`)) === nodesBefore + 1,
    `${await ev(`document.querySelectorAll('*').length`)} vs ${nodesBefore}`);
  // Dismissal is armed on a delay, so the pointer sitting still on the block does not kill it.
  await sleep(400);
  const spot = await ev(`(() => { const r = ${SEL.ko}.getBoundingClientRect();
    return {x: Math.round(r.left + 200), y: Math.round(r.top + 4)}; })()`);
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: spot.x, y: spot.y, button: "none" });
  await sleep(250);
  check("moving the mouse dismisses the bubble",
    (await ev(`document.querySelectorAll('body > [data-ht-ui]').length`)) === 0);
  check("and the page is still untouched afterwards", (await ev(`${SEL.ko}.textContent`)) === koBefore);
  check("the block was never marked, so no trigger is wasted on stale state",
    (await ev(`${SEL.ko}.hasAttribute('data-ht-state')`)) === false);

  // The bug this guards: the block used to stay marked after the bubble went, so the next trigger
  // was spent reverting something already gone and the bubble only came back on the second press.
  await ctrlTap(SEL.ko);
  check("triggering again brings the bubble straight back, first press",
    (await ev(`document.querySelectorAll('body > [data-ht-ui]').length`)) === 1);
  await ev(`document.querySelectorAll('body > [data-ht-ui]').forEach((n) => n.remove())`);
  await ev(`chrome.storage.sync.set({displayMode: 'replace'})`);
  await sleep(600);

  // --- images -------------------------------------------------------------
  // The worker has no host permission for the fixture server, so this also exercises the fallback
  // where the page fetches its own bytes and hands them over.
  console.log("\nan image is read and painted over, leaving the page alone");
  const overlayCount = () => ev(`document.querySelectorAll('body > [data-ht-ui="image"]').length`);
  const imageStatusOf = () => ev(`(async () => (await chrome.storage.local.get('imageStatus')).imageStatus)()`);

  // Images ship switched off, since reading them needs a permission asked for from the popup.
  check("images are off until asked for",
    (await ev(`(async () => (await chrome.storage.sync.get({translateImages: null})).translateImages)()`)) !== true);
  await ev(`chrome.storage.sync.set({translateImages: true})`);
  await sleep(500);

  async function ctrlTapImage(selector, settleMs = 30000) {
    const before = await overlayCount();
    const at = await ev(`(() => { const el = ${selector};
      el.scrollIntoView({block:'center'});
      const r = el.getBoundingClientRect();
      return {x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2)}; })()`);
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y, button: "none" });
    await sleep(80);
    const key = { key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17 };
    await page.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...key, modifiers: 2 });
    await sleep(40);
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
    const deadline = Date.now() + settleMs;
    while (Date.now() < deadline) {
      await sleep(200);
      if ((await overlayCount()) !== before) break;
    }
    await sleep(200);
  }

  const SIGN = `document.getElementById('sign-image')`;
  const signSrcBefore = await ev(`${SIGN}.getAttribute('src')`);
  const signParentBefore = await ev(`${SIGN}.parentElement.childNodes.length`);

  // The loading bar has to be visible while the request is out. Watched rather than sampled,
  // because a fast provider could come back between two polls.
  await ev(`window.__sawBar = false;
    new MutationObserver(() => {
      if (document.querySelector('body > [data-ht-ui="image-pending"]')) window.__sawBar = true;
    }).observe(document.body, { childList: true });
    'ok'`);

  // Each recogniser on its own, so a failure is attributed to the one that failed rather than
  // hidden by the failover. Youdao translates as it reads, so it reports itself alone; the other
  // two return lines that the usual provider chain then translates.
  for (const [id, expected] of [["youdao", /^youdao$/], ["lens", /^lens\+/], ["yandex", /^yandex\+/]]) {
    await ev(`chrome.storage.sync.set({imageOcrOrder: ['${id}']})`);
    await sleep(500);
    await ctrlTapImage(SIGN);
    const s = await imageStatusOf();
    console.log(`   ${id}: ${JSON.stringify(s)}`);
    check(`${id}: an overlay went up`, (await overlayCount()) === 1, JSON.stringify(s));
    check(`${id}: it is the engine that served it`, expected.test(String(s?.engine)), JSON.stringify(s));
    await ctrlTapImage(SIGN);
    check(`${id}: and it comes away again`, (await overlayCount()) === 0);
  }

  await ev(`chrome.storage.sync.set({imageOcrOrder: ['youdao','lens','yandex']})`);
  await sleep(500);
  await ctrlTapImage(SIGN);

  const imageStatus = await imageStatusOf();
  console.log(`   default order: ${JSON.stringify(imageStatus)}`);
  check("an overlay was put over the image", (await overlayCount()) === 1);
  check("a loading bar was shown while the image was being read",
    (await ev(`window.__sawBar`)) === true);
  check("and no bar is left once the translation is up",
    (await ev(`document.querySelectorAll('body > [data-ht-ui="image-pending"]').length`)) === 0);
  check("the image element itself was not touched",
    (await ev(`${SIGN}.getAttribute('src')`)) === signSrcBefore &&
      (await ev(`${SIGN}.hasAttribute('data-ht-state')`)) === false);
  check("and nothing was added beside it in the page",
    (await ev(`${SIGN}.parentElement.childNodes.length`)) === signParentBefore);
  check("the overlay is anchored on the image",
    await ev(`(() => { const h = document.querySelector('body > [data-ht-ui="image"]');
      const r = ${SIGN}.getBoundingClientRect();
      return Math.abs(parseFloat(h.style.left) - (r.left + scrollX)) < 2
          && Math.abs(parseFloat(h.style.width) - r.width) < 2; })()`));
  check("its contents are sealed in a closed shadow root",
    (await ev(`document.querySelector('body > [data-ht-ui="image"]').shadowRoot`)) === null);

  await ctrlTapImage(SIGN);
  check("tapping the image again takes the overlay away", (await overlayCount()) === 0);

  await ctrlTapImage(SIGN);
  await page.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await sleep(400);
  check("escape clears image overlays too", (await overlayCount()) === 0);

  // Turning images off must make the trigger ignore them entirely, not just fail quietly.
  await ev(`chrome.storage.sync.set({translateImages: false})`);
  await sleep(500);
  await ctrlTapImage(SIGN, 6000);
  check("with image translation off, nothing happens at all", (await overlayCount()) === 0);
  await ev(`chrome.storage.sync.set({translateImages: true})`);
  await sleep(500);

  // --- framed content -----------------------------------------------------
  // Mouse events go to the innermost frame, key events to the focused one. With the chat in an
  // iframe and focus still on the top document those are different content scripts, so the framed
  // message used to be unreachable while the top frame fired on whatever it last saw.
  console.log("\na message inside an iframe is the one that translates");
  const inPage = async (expression) => {
    const r = await page.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  };
  const framedText = () =>
    inPage(`document.getElementById('chat-frame').contentDocument.getElementById('framed-msg').textContent.trim()`);

  const beforeFramed = await framedText();
  const translatedBefore = await ev(`document.querySelectorAll('[data-ht-state]').length`);
  const framedSpot = await inPage(`(() => {
    const f = document.getElementById('chat-frame');
    f.scrollIntoView({block: 'center'});
    const r = f.getBoundingClientRect();
    return { x: Math.round(r.left + 90), y: Math.round(r.top + 30) };
  })()`);

  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: framedSpot.x, y: framedSpot.y, button: "none" });
  await sleep(200);
  const ctrl = { key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17 };
  await page.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...ctrl, modifiers: 2 });
  await sleep(40);
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...ctrl });
  for (let i = 0; i < 60 && (await framedText()) === beforeFramed; i++) await sleep(200);

  const afterFramed = await framedText();
  console.log(`   framed message: ${JSON.stringify(beforeFramed)} -> ${JSON.stringify(afterFramed)}`);
  check("the message inside the frame was translated", afterFramed !== beforeFramed, afterFramed);
  check("and the top document was left alone",
    (await ev(`document.querySelectorAll('[data-ht-state]').length`)) === translatedBefore);

  // --- orphaned content script -------------------------------------------
  // Reloading the extension leaves the copy already injected into an open tab with nothing behind
  // it. Simulated by taking chrome.runtime.id away, which is exactly what Chrome does. This runs
  // last: the content script latches the state and stays quiet from then on.
  console.log("\nan orphaned content script explains itself instead of erroring");
  await ev(`document.querySelectorAll('body > [data-ht-ui]').forEach((n) => n.remove());
    window.__notices = 0;
    new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) {
        if (n.nodeType === 1 && n.matches?.('[data-ht-ui]')) window.__notices++;
      }
    }).observe(document.body, { childList: true });
    Object.defineProperty(chrome.runtime, 'id', { get: () => undefined, configurable: true });
    'ok'`);

  const frBefore = await ev(`${SEL.fr}.textContent`);
  await ctrlTap(SEL.fr, 4000);
  check("nothing is translated once the extension is gone",
    (await ev(`${SEL.fr}.textContent`)) === frBefore);
  check("and a notice was put up", (await ev(`window.__notices`)) >= 1);
  check("the block was not left marked as failed",
    (await ev(`${SEL.fr}.classList.contains('ht-error')`)) === false);

  await ctrlTap(SEL.fr, 3000);
  check("it says it once and then stays quiet", (await ev(`window.__notices`)) === 1,
    `${await ev(`window.__notices`)} notices`);

  console.log("\nconsole cleanliness");
  const errors = page.logs.filter((l) => /exception|\[error\]/i.test(l));
  check("no errors from the page or content script", errors.length === 0, errors.join(" | "));

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  await cleanup(failures === 0 ? 0 : 1);
} catch (error) {
  console.error("\nharness error:", error);
  await cleanup(1);
}
