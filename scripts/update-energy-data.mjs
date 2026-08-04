import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { normalizeMavirTables, validateNormalizedEnergyData } from "../src/data/energy-schema.mjs";
import { parseFirstWorksheet } from "./lib/xlsx-table.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.join(projectRoot, "public", "data", "energy-latest.json");
const baseUrl = "https://rtdwweb.mavir.hu/rtdwweb/webuser/chart";
const endTime = Date.now();
const startTime = endTime - 26 * 60 * 60_000;

async function fetchChart(chartId) {
  const url = new URL(`${baseUrl}/${chartId}/export`);
  url.search = new URLSearchParams({
    exportType: "xlsx",
    fromTime: String(startTime),
    toTime: String(endTime),
    periodType: "min",
    period: "15",
  });

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { accept: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.subarray(0, 2).toString("ascii") !== "PK") throw new Error("response is not an XLSX file");
      return parseFirstWorksheet(buffer);
    } catch (error) {
      lastError = error;
      if (attempt < 3) await delay(attempt * 2_000);
    }
  }
  throw new Error(`MAVIR chart ${chartId} failed after 3 attempts: ${lastError.message}`);
}

const [systemRows, flowRows, frequencyRows] = await Promise.all([
  fetchChart(20001),
  fetchChart(5229),
  fetchChart(4444),
]);

const normalized = validateNormalizedEnergyData(normalizeMavirTables({ systemRows, flowRows, frequencyRows }));
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");

console.log(JSON.stringify({
  output: outputPath,
  measuredAt: normalized.measuredAt,
  sources: normalized.quality.requiredFeeds,
  quality: normalized.quality,
  generationMW: normalized.system.generationMW,
  consumptionMW: normalized.system.consumptionMW,
  netImportMW: normalized.system.netImportMW,
}, null, 2));
