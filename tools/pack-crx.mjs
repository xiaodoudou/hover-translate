// Signs the built ZIP into a CRX with the release key.
//   node tools/pack-crx.mjs
//
// Run after tools/package.mjs. Chrome packs a directory, not an archive, so the ZIP that was just
// verified is unpacked into a temp tree and that tree is what gets signed: the CRX is then the same
// bytes as the ZIP rather than a second walk of the source, which could disagree with it.
//
// The key lives outside the repo on purpose. Every release is signed with it, which is what keeps
// the extension id stable so an install updates in place instead of arriving as a stranger.

import { readFile, rm, mkdtemp, copyFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const key = process.env.CRX_KEY || resolve(root, "..", "hover-translate-signing-key.pem");

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

if (!existsSync(key)) throw new Error(`signing key not found: ${key}`);

const { version } = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
const zipPath = join(root, "dist", `hover-translate-${version}.zip`);
if (!existsSync(zipPath)) throw new Error(`run tools/package.mjs first: ${zipPath} is missing`);

const work = await mkdtemp(join(tmpdir(), "ht-crx-"));
const tree = join(work, "extension");

await run("powershell", [
  "-NoProfile",
  "-Command",
  `Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
    `[IO.Compression.ZipFile]::ExtractToDirectory('${zipPath}', '${tree}')`,
]);
if (!existsSync(join(tree, "manifest.json"))) throw new Error("unpacked tree has no manifest.json");

// Chrome writes <tree>.crx beside the directory and exits without waiting for anything, but it
// returns a non-zero code on the pack path even when it succeeds, so the file is what is checked.
await run(findChrome(), [
  `--pack-extension=${tree}`,
  `--pack-extension-key=${key}`,
  "--no-message-box",
]).catch(() => {});

const packed = `${tree}.crx`;
if (!existsSync(packed)) throw new Error("Chrome did not produce a CRX");

// Copied rather than renamed: the temp tree is on whichever drive the OS gives out, and a rename
// across devices is refused outright.
const crxPath = join(root, "dist", `hover-translate-${version}.crx`);
await copyFile(packed, crxPath);
await rm(work, { recursive: true, force: true });

const { size } = await stat(crxPath);
console.log(`dist/hover-translate-${version}.crx  (${(size / 1024).toFixed(1)} kB)`);
console.log(`signed with ${key}`);
