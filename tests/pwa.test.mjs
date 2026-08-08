import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("public/manifest.webmanifest", root), "utf8"));
const index = await readFile(new URL("index.html", root), "utf8");
const main = await readFile(new URL("src/main.jsx", root), "utf8");
const serviceWorker = await readFile(new URL("public/sw.js", root), "utf8");

function pngDimensions(bytes) {
  assert.equal(bytes.toString("ascii", 1, 4), "PNG");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

test("the web app manifest describes an installable standalone app", () => {
  assert.equal(manifest.name, "Energiatérkép — Magyarország villamosenergia-rendszere");
  assert.equal(manifest.short_name, "Energiatérkép");
  assert.equal(manifest.start_url, "./");
  assert.equal(manifest.scope, "./");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.theme_color, "#07111b");
  assert.ok(manifest.icons.some((icon) => icon.sizes === "192x192" && icon.purpose === "any"));
  assert.ok(manifest.icons.some((icon) => icon.sizes === "512x512" && icon.purpose === "any"));
  assert.ok(manifest.icons.some((icon) => icon.sizes === "512x512" && icon.purpose === "maskable"));
});

test("Android and iOS icon files have their declared dimensions", async () => {
  const expected = new Map([
    ["icon-192.png", 192],
    ["icon-512.png", 512],
    ["icon-maskable-512.png", 512],
    ["apple-touch-icon.png", 180],
  ]);

  for (const [file, size] of expected) {
    const dimensions = pngDimensions(await readFile(new URL(`public/icons/${file}`, root)));
    assert.deepEqual(dimensions, { width: size, height: size });
  }
});

test("the document exposes install and iOS metadata", () => {
  assert.match(index, /rel="manifest" href="\.\/manifest\.webmanifest"/);
  assert.match(index, /rel="apple-touch-icon" sizes="180x180"/);
  assert.match(index, /apple-mobile-web-app-capable" content="yes"/);
  assert.match(index, /apple-mobile-web-app-status-bar-style" content="black-translucent"/);
});

test("the production app registers an offline-capable service worker without caching APIs", () => {
  assert.match(main, /import\.meta\.env\.PROD/);
  assert.match(main, /navigator\.serviceWorker\.register/);
  assert.match(serviceWorker, /request\.mode === "navigate"/);
  assert.match(serviceWorker, /data\/energy-latest\.json/);
  assert.match(serviceWorker, /url\.pathname\.includes\("\/api\/"\)/);
  assert.match(serviceWorker, /event\.respondWith\(fetch\(request\)\)/);
});
