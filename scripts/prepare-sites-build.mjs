#!/usr/bin/env node
import { cpSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const index = path.join(dist, "client", "index.html");
const hosting = path.join(root, ".openai", "hosting.json");
const migrations = path.join(root, "db", "migrations");

for (const file of [index, hosting, migrations]) {
  if (!existsSync(file)) throw new Error("Missing Sites build input: " + file);
}

await build({
  configFile: false,
  logLevel: "warn",
  build: {
    target: "es2022",
    outDir: path.join(dist, "server"),
    emptyOutDir: true,
    minify: false,
    lib: { entry: path.join(root, "worker", "index.js"), formats: ["es"], fileName: () => "index.js" },
  },
});
mkdirSync(path.join(dist, ".openai"), { recursive: true });
copyFileSync(hosting, path.join(dist, ".openai", "hosting.json"));
cpSync(migrations, path.join(dist, ".openai", "drizzle"), { recursive: true });

console.log("Prepared Sites build: server worker, hosting metadata, and D1 migration");
