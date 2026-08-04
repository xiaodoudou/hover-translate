// Static checks on the extension package: every path the manifest and the module graph reference
// must exist, and every dynamically imported module must be web accessible or Chrome refuses it.
// Run with: node test/package.test.mjs

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;

const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : " " + detail}`);
  if (!ok) failures++;
};

const manifest = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8"));
const posix = (p) => p.split(sep).join("/");

console.log("manifest paths exist");
const referenced = [
  manifest.background.service_worker,
  ...manifest.content_scripts.flatMap((cs) => [...(cs.js || []), ...(cs.css || [])]),
  manifest.action.default_popup,
  ...Object.values(manifest.icons),
];
for (const path of referenced) {
  check(path, existsSync(resolve(root, path)));
}

console.log("\nmanifest shape");
check("manifest_version is 3", manifest.manifest_version === 3);
check("service worker is a module", manifest.background.type === "module");
check("storage permission present", manifest.permissions.includes("storage"));
check("no permission beyond storage", manifest.permissions.length === 1,
  JSON.stringify(manifest.permissions));

const PROVIDER_HOSTS = ["translate-pa.googleapis.com", "translate.googleapis.com",
  "transmart.qq.com", "api.mymemory.translated.net"];
for (const host of PROVIDER_HOSTS) {
  check(`host permission for ${host}`,
    manifest.host_permissions.some((h) => h.includes(host)), JSON.stringify(manifest.host_permissions));
}
check("no host permission beyond the provider endpoints",
  manifest.host_permissions.length === PROVIDER_HOSTS.length, JSON.stringify(manifest.host_permissions));

// Walk the static import graph from every entry point.
const IMPORT_RE = /(?:^|[\s;{])(?:import|export)[\s\S]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
function walk(entry, seen = new Set()) {
  const file = resolve(root, entry);
  if (seen.has(file)) return seen;
  seen.add(file);
  if (!existsSync(file)) return seen;
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(IMPORT_RE)) {
    const spec = match[1] || match[2];
    if (!spec || !spec.startsWith(".")) continue;
    walk(posix(relative(root, resolve(dirname(file), spec))), seen);
  }
  return seen;
}

console.log("\nmodule graph resolves");
const entries = ["src/background.js", "src/content/loader.js", "src/popup/popup.js", "src/content/index.js"];
const reached = new Set();
for (const entry of entries) for (const file of walk(entry)) reached.add(file);
for (const file of reached) {
  check(posix(relative(root, file)), existsSync(file), "missing import target");
}

console.log("\ncontent script modules are web accessible");
const patterns = manifest.web_accessible_resources.flatMap((w) => w.resources);
const matches = (path) =>
  patterns.some((pattern) => new RegExp("^" + pattern.replace(/[.]/g, "\\.").replace(/\*/g, ".*") + "$").test(path));
// Everything the content script pulls in is fetched by URL, so each one needs a matching pattern.
const contentGraph = [...walk("src/content/index.js")].map((f) => posix(relative(root, f)));
for (const path of contentGraph) {
  check(path, matches(path), "not covered by web_accessible_resources");
}
check("popup-only modules are not needlessly exposed", !matches("src/popup/popup.js"));

console.log("\ncontent script safety");
const contentSources = contentGraph.map((p) => readFileSync(resolve(root, p), "utf8")).join("\n");
check("no innerHTML in the content script graph", !/\.innerHTML\s*=/.test(contentSources));
check("no eval or Function constructor", !/\beval\(|new Function\(/.test(contentSources));
check("no remote markup is parsed", !/DOMParser|insertAdjacentHTML/.test(contentSources));

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
