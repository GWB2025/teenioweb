import { copyFile, lstat, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(root, "_site");
// Publish only app assets, never test fixtures, local captures or repository files.
const assets = [
  "index.html", "styles.css", "app.js", "protocol.js", "calculator.js",
  "program-table.js", "stored-programs.js", "storage-writing.js", "memory-cards.js", "program-upload.js", "serial.js",
  "sw.js", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png",
];

for (const name of assets) {
  const stat = await lstat(resolve(root, "Web", name));
  if (!stat.isFile()) throw new Error(`Expected a regular runtime file: ${name}`);
}
await rm(output, { recursive: true, force: true });
for (const name of assets) {
  const target = resolve(output, name);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(resolve(root, "Web", name), target);
}
console.log(`Packaged ${assets.length} runtime files in _site/.`);
