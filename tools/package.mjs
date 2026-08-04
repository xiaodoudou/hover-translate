// Builds the ZIP to upload to the Chrome Web Store.
//   node tools/package.mjs
//
// Ships only what the extension needs to run. Tests, tooling and store copy stay out: review reads
// what you upload, and dev files invite questions that have nothing to do with the extension.

import { readFile, writeFile, readdir, stat, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { dirname, resolve, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { makeZip } from "./zip.mjs";

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "dist");
const posix = (p) => p.split(sep).join("/");

const SHIP = ["manifest.json", "src", "icons"];

async function walk(entry) {
  const full = join(root, entry);
  if (!existsSync(full)) throw new Error(`missing: ${entry}`);
  if ((await stat(full)).isFile()) return [entry];
  const out = [];
  for (const name of await readdir(full)) out.push(...(await walk(join(entry, name))));
  return out;
}

const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
const files = (await Promise.all(SHIP.map(walk))).flat().map(posix);

// Nothing ships that the manifest and the module graph do not actually reach.
const stray = files.filter((f) => /\.(md|zip|ps1|mjs)$/.test(f) || f.includes("/test/"));
if (stray.length) throw new Error(`unexpected files in the ship list: ${stray.join(", ")}`);

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
const zipPath = join(outDir, `hover-translate-${manifest.version}.zip`);

const archive = makeZip(
  await Promise.all(files.map(async (name) => ({ name, data: await readFile(join(root, name)) }))),
);
await writeFile(zipPath, archive);

// Prove the tree survived rather than trusting it: manifest.json at the root, sources under src/,
// and every separator a forward slash.
const { stdout } = await run("powershell", [
  "-NoProfile",
  "-Command",
  `Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
    `$z = [IO.Compression.ZipFile]::OpenRead('${zipPath}'); ` +
    `$z.Entries | ForEach-Object { $_.FullName }; $z.Dispose()`,
]);
const packed = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
const missing = files.filter((f) => !packed.includes(f));
if (missing.length) throw new Error(`archive is missing or renamed: ${missing.join(", ")}`);
if (packed.some((p) => p.includes("\\"))) throw new Error("archive used backslash separators");
if (!packed.includes("manifest.json")) throw new Error("manifest.json is not at the archive root");

const { size } = await stat(zipPath);
await writeFile(
  join(outDir, "MANIFEST.txt"),
  [`Hover Translate ${manifest.version}`, "", ...files].join("\n") + "\n",
  "utf8",
);

console.log(`${relative(root, zipPath)}  (${(size / 1024).toFixed(1)} kB, ${files.length} files)`);
for (const f of files) console.log(`  ${f}`);
