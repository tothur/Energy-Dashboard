import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeEnergyPayload, validateNormalizedEnergyData } from "../src/data/energy-schema.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.join(projectRoot, "public", "data", "energy-latest.json");
const sourceUrl = "https://holadelej.hu/api/data";

const response = await fetch(sourceUrl, {
  headers: {
    accept: "application/json",
    referer: "https://holadelej.hu/",
    "user-agent": "Energy-Dashboard/1.0 (+https://github.com/tothur/Energy-Dashboard)",
  },
  signal: AbortSignal.timeout(20_000),
});

if (!response.ok) throw new Error(`Energy source returned HTTP ${response.status}`);

const raw = await response.json();
const normalized = validateNormalizedEnergyData(normalizeEnergyPayload(raw));

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");

console.log(
  JSON.stringify(
    {
      output: outputPath,
      measuredAt: normalized.measuredAt,
      quality: normalized.quality,
      generationMW: normalized.system.generationMW,
      consumptionMW: normalized.system.consumptionMW,
      netImportMW: normalized.system.netImportMW,
    },
    null,
    2,
  ),
);
